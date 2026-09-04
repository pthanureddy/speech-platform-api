import postgres from 'postgres';
import { conflict, notFound, tooManyRequests } from '../domain/errors.js';
import { getPlanPolicy } from '../domain/plans.js';
import type {
  ApplyWebhookResult,
  AudioFormat,
  JobStatus,
  SpeechFailure,
  SpeechJob,
  SpeechOutput,
  SubmitJobCommand,
  SubmitJobResult,
  Tenant,
  UsageBucket,
  WebhookEvent,
} from '../domain/types.js';
import type { PlatformRepository } from '../repository.js';
import { webhookEventFingerprint } from '../security.js';
import { runPostgresMigrations } from './postgres-migrations.js';

const TENANT_SEED_LOCK = 'speech-platform-api:tenant-seeds:v1';

export interface PostgresRepositoryOptions {
  databaseUrl: string;
  tenants: readonly Tenant[];
  maxConnections?: number;
}

interface TenantRow {
  id: string;
  name: string;
  plan_id: Tenant['planId'];
  api_key_digest: string;
}

interface JobRow {
  id: string;
  tenant_id: string;
  input_text: string;
  voice: string;
  format: AudioFormat;
  character_count: number;
  quota_period: string;
  status: JobStatus;
  output: unknown;
  failure: unknown;
  created_at: Date | string;
  updated_at: Date | string;
}

interface UsageRow {
  tenant_id: string;
  period: string;
  reserved_characters: number | string | bigint;
  consumed_characters: number | string | bigint;
  character_limit: number | string | bigint;
}

interface IdempotencyRow {
  request_fingerprint: string;
  job_id: string;
}

interface WebhookRow {
  fingerprint: string;
  job_id: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJson(value: unknown, field: string): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed;
  } catch {
    throw new Error(`Repository invariant failed: malformed ${field} JSON in PostgreSQL.`);
  }
}

function parseOutput(value: unknown): SpeechOutput | undefined {
  if (value === null) {
    return undefined;
  }
  const parsed = parseJson(value, 'speech output');
  if (
    !isRecord(parsed) ||
    typeof parsed.artifactUri !== 'string' ||
    typeof parsed.sha256 !== 'string' ||
    typeof parsed.durationMs !== 'number'
  ) {
    throw new Error('Repository invariant failed: malformed speech output in PostgreSQL.');
  }
  return {
    artifactUri: parsed.artifactUri,
    sha256: parsed.sha256,
    durationMs: parsed.durationMs,
  };
}

function parseFailure(value: unknown): SpeechFailure | undefined {
  if (value === null) {
    return undefined;
  }
  const parsed = parseJson(value, 'speech failure');
  if (!isRecord(parsed) || typeof parsed.code !== 'string' || typeof parsed.message !== 'string') {
    throw new Error('Repository invariant failed: malformed speech failure in PostgreSQL.');
  }
  return { code: parsed.code, message: parsed.message };
}

function toIsoTimestamp(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error('Repository invariant failed: malformed timestamp in PostgreSQL.');
  }
  return date.toISOString();
}

function toSafeInteger(value: number | string | bigint, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Repository invariant failed: invalid ${field} in PostgreSQL.`);
  }
  return parsed;
}

function mapJob(row: JobRow): SpeechJob {
  const output = parseOutput(row.output);
  const failure = parseFailure(row.failure);
  const job: SpeechJob = {
    id: row.id,
    tenantId: row.tenant_id,
    text: row.input_text,
    voice: row.voice,
    format: row.format,
    characterCount: row.character_count,
    quotaPeriod: row.quota_period,
    status: row.status,
    createdAt: toIsoTimestamp(row.created_at),
    updatedAt: toIsoTimestamp(row.updated_at),
  };
  if (output !== undefined) {
    job.output = output;
  }
  if (failure !== undefined) {
    job.failure = failure;
  }
  return job;
}

function mapUsage(row: UsageRow): UsageBucket {
  return {
    tenantId: row.tenant_id,
    period: row.period,
    reservedCharacters: toSafeInteger(row.reserved_characters, 'reserved character count'),
    consumedCharacters: toSafeInteger(row.consumed_characters, 'consumed character count'),
  };
}

/**
 * Durable PostgreSQL adapter. Every mutator uses one database transaction.
 * Job and usage rows are locked in a consistent order; advisory transaction
 * locks serialize unique keys whose rows may not exist yet.
 */
export class PostgresPlatformRepository implements PlatformRepository {
  private constructor(private readonly sql: postgres.Sql) {}

  public static async connect(
    options: PostgresRepositoryOptions,
  ): Promise<PostgresPlatformRepository> {
    if (options.databaseUrl.trim().length === 0) {
      throw new Error('DATABASE_URL must not be empty.');
    }
    if (
      options.maxConnections !== undefined &&
      (!Number.isSafeInteger(options.maxConnections) || options.maxConnections <= 0)
    ) {
      throw new Error('PostgreSQL maxConnections must be a positive integer.');
    }

    const sql = postgres(options.databaseUrl, {
      max: options.maxConnections ?? 10,
      idle_timeout: 20,
      connect_timeout: 10,
      connection: {
        application_name: 'speech-platform-api',
        statement_timeout: 15_000,
        lock_timeout: 10_000,
        idle_in_transaction_session_timeout: 15_000,
      },
      onnotice: () => undefined,
    });
    const repository = new PostgresPlatformRepository(sql);

    try {
      await runPostgresMigrations(sql);
      await repository.seedTenants(options.tenants);
      return repository;
    } catch (error) {
      await sql.end({ timeout: 1 }).catch(() => undefined);
      throw error instanceof Error
        ? error
        : new Error('PostgreSQL repository initialization failed.', { cause: error });
    }
  }

  public async seedTenants(tenants: readonly Tenant[]): Promise<void> {
    await this.sql.begin(async (transaction) => {
      await transaction`
        SELECT pg_advisory_xact_lock(hashtextextended(${TENANT_SEED_LOCK}, 0))
      `;
      for (const tenant of tenants) {
        await transaction`
          INSERT INTO tenants (id, name, plan_id, api_key_digest)
          VALUES (${tenant.id}, ${tenant.name}, ${tenant.planId}, ${tenant.apiKeyDigest})
          ON CONFLICT (id) DO UPDATE
          SET name = EXCLUDED.name,
              plan_id = EXCLUDED.plan_id,
              api_key_digest = EXCLUDED.api_key_digest,
              updated_at = now()
        `;
      }
    });
  }

  public async findTenantByApiKeyDigest(apiKeyDigest: string): Promise<Tenant | undefined> {
    const rows = await this.sql<TenantRow[]>`
      SELECT id, name, plan_id, api_key_digest
      FROM tenants
      WHERE api_key_digest = ${apiKeyDigest}
    `;
    const row = rows[0];
    return row === undefined
      ? undefined
      : {
          id: row.id,
          name: row.name,
          planId: row.plan_id,
          apiKeyDigest: row.api_key_digest,
        };
  }

  public async findTenantById(tenantId: string): Promise<Tenant | undefined> {
    const rows = await this.sql<TenantRow[]>`
      SELECT id, name, plan_id, api_key_digest
      FROM tenants
      WHERE id = ${tenantId}
    `;
    const row = rows[0];
    return row === undefined
      ? undefined
      : {
          id: row.id,
          name: row.name,
          planId: row.plan_id,
          apiKeyDigest: row.api_key_digest,
        };
  }

  public async createJobWithReservation(command: SubmitJobCommand): Promise<SubmitJobResult> {
    if (command.job.tenantId !== command.tenantId) {
      throw new Error('Repository invariant failed: job and command tenants differ.');
    }

    return this.sql.begin(async (transaction) => {
      const lockKey = `idempotency:${command.tenantId}:${command.idempotencyKey}`;
      await transaction`
        SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))
      `;

      const existing = await transaction<IdempotencyRow[]>`
        SELECT request_fingerprint, job_id
        FROM idempotency_keys
        WHERE tenant_id = ${command.tenantId}
          AND idempotency_key = ${command.idempotencyKey}
        FOR UPDATE
      `;
      const existingRecord = existing[0];
      if (existingRecord !== undefined) {
        return this.replayIdempotentJob(transaction, existingRecord, command.requestFingerprint);
      }

      const tenantRows = await transaction<{ id: string; plan_id: Tenant['planId'] }[]>`
        SELECT id, plan_id
        FROM tenants
        WHERE id = ${command.tenantId}
        FOR SHARE
      `;
      const tenant = tenantRows[0];
      if (tenant === undefined) {
        throw notFound('TENANT_NOT_FOUND', 'Tenant was not found.');
      }
      const characterLimit = Math.min(
        command.characterLimit,
        getPlanPolicy(tenant.plan_id).monthlyCharacterLimit,
      );

      const jobLockKey = `job:${command.job.id}`;
      await transaction`
        SELECT pg_advisory_xact_lock(hashtextextended(${jobLockKey}, 0))
      `;
      const collidingJobs = await transaction<{ id: string }[]>`
        SELECT id
        FROM speech_jobs
        WHERE id = ${command.job.id}
      `;
      if (collidingJobs[0] !== undefined) {
        throw conflict('JOB_ID_COLLISION', 'A generated job identifier already exists.');
      }

      const recorded = await transaction<{ job_id: string }[]>`
        INSERT INTO idempotency_keys (
          tenant_id,
          idempotency_key,
          request_fingerprint,
          job_id
        )
        VALUES (
          ${command.tenantId},
          ${command.idempotencyKey},
          ${command.requestFingerprint},
          ${command.job.id}
        )
        ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
        RETURNING job_id
      `;
      if (recorded[0] === undefined) {
        const raced = await transaction<IdempotencyRow[]>`
          SELECT request_fingerprint, job_id
          FROM idempotency_keys
          WHERE tenant_id = ${command.tenantId}
            AND idempotency_key = ${command.idempotencyKey}
          FOR UPDATE
        `;
        const racedRecord = raced[0];
        if (racedRecord === undefined) {
          throw new Error('Repository invariant failed: idempotency insert race lost its row.');
        }
        return this.replayIdempotentJob(transaction, racedRecord, command.requestFingerprint);
      }

      await transaction`
        INSERT INTO usage_buckets (
          tenant_id,
          period,
          reserved_characters,
          consumed_characters,
          character_limit
        )
        VALUES (${command.tenantId}, ${command.period}, 0, 0, ${characterLimit})
        ON CONFLICT (tenant_id, period) DO NOTHING
      `;
      const usageRows = await transaction<UsageRow[]>`
        SELECT tenant_id, period, reserved_characters, consumed_characters, character_limit
        FROM usage_buckets
        WHERE tenant_id = ${command.tenantId}
          AND period = ${command.period}
        FOR UPDATE
      `;
      const usage = usageRows[0];
      if (usage === undefined) {
        throw new Error('Repository invariant failed: usage bucket was not created.');
      }
      const reservedCharacters = toSafeInteger(
        usage.reserved_characters,
        'reserved character count',
      );
      const consumedCharacters = toSafeInteger(
        usage.consumed_characters,
        'consumed character count',
      );
      const attemptedTotal =
        reservedCharacters + consumedCharacters + command.job.characterCount;
      if (attemptedTotal > characterLimit) {
        const remaining = Math.max(
          0,
          characterLimit - reservedCharacters - consumedCharacters,
        );
        throw tooManyRequests(
          'QUOTA_EXCEEDED',
          'The monthly character quota would be exceeded.',
          {
            characterLimit,
            requestedCharacters: command.job.characterCount,
            remainingCharacters: remaining,
            period: command.period,
          },
        );
      }

      const insertedJobs = await transaction<JobRow[]>`
        INSERT INTO speech_jobs (
          id,
          tenant_id,
          input_text,
          voice,
          format,
          character_count,
          quota_period,
          status,
          created_at,
          updated_at
        )
        VALUES (
          ${command.job.id},
          ${command.tenantId},
          ${command.job.text},
          ${command.job.voice},
          ${command.job.format},
          ${command.job.characterCount},
          ${command.period},
          'queued',
          ${command.job.createdAt},
          ${command.job.updatedAt}
        )
        ON CONFLICT (id) DO NOTHING
        RETURNING *
      `;
      const insertedJob = insertedJobs[0];
      if (insertedJob === undefined) {
        throw conflict('JOB_ID_COLLISION', 'A generated job identifier already exists.');
      }

      await transaction`
        UPDATE usage_buckets
        SET reserved_characters = reserved_characters + ${command.job.characterCount},
            character_limit = ${characterLimit}
        WHERE tenant_id = ${command.tenantId}
          AND period = ${command.period}
      `;

      return { job: mapJob(insertedJob), replayed: false };
    });
  }

  public async findJobForTenant(
    tenantId: string,
    jobId: string,
  ): Promise<SpeechJob | undefined> {
    const rows = await this.sql<JobRow[]>`
      SELECT *
      FROM speech_jobs
      WHERE id = ${jobId}
        AND tenant_id = ${tenantId}
    `;
    const row = rows[0];
    return row === undefined ? undefined : mapJob(row);
  }

  public async cancelQueuedJob(
    tenantId: string,
    jobId: string,
    now: string,
  ): Promise<SpeechJob> {
    return this.sql.begin(async (transaction) => {
      const job = await this.lockTenantJob(transaction, tenantId, jobId);
      if (job.status === 'cancelled') {
        return mapJob(job);
      }
      if (job.status !== 'queued') {
        throw conflict('INVALID_JOB_STATE', `A '${job.status}' job cannot be cancelled.`, {
          currentStatus: job.status,
          allowedStatus: 'queued',
        });
      }

      await this.releaseReservation(transaction, job);
      const updated = await transaction<JobRow[]>`
        UPDATE speech_jobs
        SET status = 'cancelled', updated_at = ${now}
        WHERE id = ${job.id}
        RETURNING *
      `;
      return mapJob(this.requireUpdatedJob(updated));
    });
  }

  public async claimQueuedJob(jobId: string, now: string): Promise<SpeechJob> {
    return this.sql.begin(async (transaction) => {
      const job = await this.lockJob(transaction, jobId);
      if (job.status !== 'queued') {
        throw conflict('INVALID_JOB_STATE', `A '${job.status}' job cannot begin processing.`, {
          currentStatus: job.status,
          allowedStatus: 'queued',
        });
      }
      const updated = await transaction<JobRow[]>`
        UPDATE speech_jobs
        SET status = 'processing', updated_at = ${now}
        WHERE id = ${job.id}
        RETURNING *
      `;
      return mapJob(this.requireUpdatedJob(updated));
    });
  }

  public async completeProcessingJob(
    jobId: string,
    output: SpeechOutput,
    now: string,
  ): Promise<SpeechJob> {
    return this.sql.begin(async (transaction) => {
      const job = await this.lockJob(transaction, jobId);
      if (job.status !== 'processing') {
        throw conflict('INVALID_JOB_STATE', `A '${job.status}' job cannot be completed.`, {
          currentStatus: job.status,
          allowedStatus: 'processing',
        });
      }

      await this.consumeReservation(transaction, job);
      const serializedOutput = JSON.stringify(output);
      const updated = await transaction<JobRow[]>`
        UPDATE speech_jobs
        SET status = 'completed',
            output = ${serializedOutput}::jsonb,
            failure = NULL,
            updated_at = ${now}
        WHERE id = ${job.id}
        RETURNING *
      `;
      return mapJob(this.requireUpdatedJob(updated));
    });
  }

  public async failProcessingJob(
    jobId: string,
    failure: SpeechFailure,
    now: string,
  ): Promise<SpeechJob> {
    return this.sql.begin(async (transaction) => {
      const job = await this.lockJob(transaction, jobId);
      if (job.status !== 'processing') {
        throw conflict('INVALID_JOB_STATE', `A '${job.status}' job cannot be failed.`, {
          currentStatus: job.status,
          allowedStatus: 'processing',
        });
      }

      await this.releaseReservation(transaction, job);
      const serializedFailure = JSON.stringify(failure);
      const updated = await transaction<JobRow[]>`
        UPDATE speech_jobs
        SET status = 'failed',
            output = NULL,
            failure = ${serializedFailure}::jsonb,
            updated_at = ${now}
        WHERE id = ${job.id}
        RETURNING *
      `;
      return mapJob(this.requireUpdatedJob(updated));
    });
  }

  public async applyWebhookEvent(
    event: WebhookEvent,
    now: string,
  ): Promise<ApplyWebhookResult> {
    return this.sql.begin(async (transaction) => {
      const lockKey = `webhook:${event.eventId}`;
      await transaction`
        SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))
      `;
      const fingerprint = webhookEventFingerprint(event);
      const previousEvents = await transaction<WebhookRow[]>`
        SELECT fingerprint, job_id
        FROM webhook_events
        WHERE event_id = ${event.eventId}
        FOR UPDATE
      `;
      const previousEvent = previousEvents[0];
      if (previousEvent !== undefined) {
        if (previousEvent.fingerprint !== fingerprint) {
          throw conflict(
            'WEBHOOK_EVENT_REUSED',
            'The webhook event id was already used with a different payload.',
          );
        }
        const replayedJob = await this.lockJob(transaction, previousEvent.job_id);
        return { job: mapJob(replayedJob), replayed: true };
      }

      const job = await this.lockTenantJob(transaction, event.tenantId, event.jobId);
      if (job.status !== 'queued' && job.status !== 'processing') {
        throw conflict(
          'INVALID_JOB_STATE',
          `A '${job.status}' job cannot accept a synthesis callback.`,
          { currentStatus: job.status, allowedStatuses: ['queued', 'processing'] },
        );
      }

      let updatedJob: JobRow;
      if (event.type === 'synthesis.completed') {
        if (event.output === undefined) {
          throw new Error('Repository invariant failed: completed event has no output.');
        }
        await this.consumeReservation(transaction, job);
        const serializedOutput = JSON.stringify(event.output);
        const updated = await transaction<JobRow[]>`
          UPDATE speech_jobs
          SET status = 'completed',
              output = ${serializedOutput}::jsonb,
              failure = NULL,
              updated_at = ${now}
          WHERE id = ${job.id}
          RETURNING *
        `;
        updatedJob = this.requireUpdatedJob(updated);
      } else {
        if (event.error === undefined) {
          throw new Error('Repository invariant failed: failed event has no error.');
        }
        await this.releaseReservation(transaction, job);
        const serializedFailure = JSON.stringify(event.error);
        const updated = await transaction<JobRow[]>`
          UPDATE speech_jobs
          SET status = 'failed',
              output = NULL,
              failure = ${serializedFailure}::jsonb,
              updated_at = ${now}
          WHERE id = ${job.id}
          RETURNING *
        `;
        updatedJob = this.requireUpdatedJob(updated);
      }

      await transaction`
        INSERT INTO webhook_events (event_id, fingerprint, job_id, accepted_at)
        VALUES (${event.eventId}, ${fingerprint}, ${job.id}, ${now})
      `;
      return { job: mapJob(updatedJob), replayed: false };
    });
  }

  public async getUsage(tenantId: string, period: string): Promise<UsageBucket> {
    const rows = await this.sql<UsageRow[]>`
      SELECT tenant_id, period, reserved_characters, consumed_characters, character_limit
      FROM usage_buckets
      WHERE tenant_id = ${tenantId}
        AND period = ${period}
    `;
    const row = rows[0];
    return row === undefined
      ? { tenantId, period, reservedCharacters: 0, consumedCharacters: 0 }
      : mapUsage(row);
  }

  public async ping(): Promise<boolean> {
    try {
      await this.sql`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }

  public async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }

  private async replayIdempotentJob(
    transaction: postgres.TransactionSql,
    record: IdempotencyRow,
    requestFingerprint: string,
  ): Promise<SubmitJobResult> {
    if (record.request_fingerprint !== requestFingerprint) {
      throw conflict(
        'IDEMPOTENCY_KEY_REUSED',
        'The Idempotency-Key was already used with a different request body.',
      );
    }
    const job = await this.lockJob(transaction, record.job_id);
    return { job: mapJob(job), replayed: true };
  }

  private async lockJob(transaction: postgres.TransactionSql, jobId: string): Promise<JobRow> {
    const rows = await transaction<JobRow[]>`
      SELECT *
      FROM speech_jobs
      WHERE id = ${jobId}
      FOR UPDATE
    `;
    const row = rows[0];
    if (row === undefined) {
      throw notFound('JOB_NOT_FOUND', 'Speech job was not found.');
    }
    return row;
  }

  private async lockTenantJob(
    transaction: postgres.TransactionSql,
    tenantId: string,
    jobId: string,
  ): Promise<JobRow> {
    const rows = await transaction<JobRow[]>`
      SELECT *
      FROM speech_jobs
      WHERE id = ${jobId}
        AND tenant_id = ${tenantId}
      FOR UPDATE
    `;
    const row = rows[0];
    if (row === undefined) {
      // A uniform 404 prevents callers from enumerating another tenant's jobs.
      throw notFound('JOB_NOT_FOUND', 'Speech job was not found.');
    }
    return row;
  }

  private async releaseReservation(
    transaction: postgres.TransactionSql,
    job: JobRow,
  ): Promise<void> {
    const rows = await transaction<{ tenant_id: string }[]>`
      UPDATE usage_buckets
      SET reserved_characters = reserved_characters - ${job.character_count}
      WHERE tenant_id = ${job.tenant_id}
        AND period = ${job.quota_period}
        AND reserved_characters >= ${job.character_count}
      RETURNING tenant_id
    `;
    if (rows[0] === undefined) {
      throw new Error('Repository invariant failed: insufficient reserved characters.');
    }
  }

  private async consumeReservation(
    transaction: postgres.TransactionSql,
    job: JobRow,
  ): Promise<void> {
    const rows = await transaction<{ tenant_id: string }[]>`
      UPDATE usage_buckets
      SET reserved_characters = reserved_characters - ${job.character_count},
          consumed_characters = consumed_characters + ${job.character_count}
      WHERE tenant_id = ${job.tenant_id}
        AND period = ${job.quota_period}
        AND reserved_characters >= ${job.character_count}
      RETURNING tenant_id
    `;
    if (rows[0] === undefined) {
      throw new Error('Repository invariant failed: insufficient reserved characters.');
    }
  }

  private requireUpdatedJob(rows: JobRow[]): JobRow {
    const row = rows[0];
    if (row === undefined) {
      throw new Error('Repository invariant failed: locked job disappeared during update.');
    }
    return row;
  }
}
