import type { FastifyInstance } from 'fastify';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';
import type {
  SpeechJob,
  SubmitJobCommand,
  Tenant,
} from '../src/domain/types.js';
import { PostgresPlatformRepository } from '../src/infrastructure/postgres-platform-repository.js';
import { runPostgresMigrations } from '../src/infrastructure/postgres-migrations.js';
import { digestApiKey, requestFingerprint } from '../src/security.js';

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const RESET_CONFIRMATION = 'speech-platform-integration-tests';

function infrastructureTestsEnabled(): boolean {
  if (process.env.RUN_INFRA_TESTS !== '1') {
    return false;
  }
  if (DATABASE_URL.length === 0) {
    throw new Error('DATABASE_URL is required when RUN_INFRA_TESTS=1.');
  }
  if (process.env.CONFIRM_DATABASE_RESET !== RESET_CONFIRMATION) {
    throw new Error(`CONFIRM_DATABASE_RESET=${RESET_CONFIRMATION} is required.`);
  }
  let parsed: URL;
  try {
    parsed = new URL(DATABASE_URL);
  } catch {
    throw new Error('The integration DATABASE_URL must be a valid PostgreSQL URL.');
  }
  const databaseName = decodeURIComponent(parsed.pathname.slice(1));
  if (
    (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') ||
    !databaseName.endsWith('_test')
  ) {
    throw new Error('The integration database name must end in _test.');
  }
  return true;
}

const RUN_INFRA_TESTS = infrastructureTestsEnabled();
const NOW = '2026-09-04T12:00:00.000Z';
const API_KEY = 'postgres_api_key_for_tests';
const TENANT: Tenant = {
  id: 'tenant_postgres',
  name: 'PostgreSQL tenant',
  planId: 'free',
  apiKeyDigest: digestApiKey(API_KEY),
};

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

async function settle<T>(promise: Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { ok: false, error };
  }
}

function command(
  jobId: string,
  idempotencyKey: string,
  text: string,
  options: { period?: string } = {},
): SubmitJobCommand {
  const period = options.period ?? '2026-09';
  const voice = 'narrator-en';
  const format = 'mp3';
  const job: SpeechJob = {
    id: jobId,
    tenantId: TENANT.id,
    text,
    voice,
    format,
    characterCount: Array.from(text).length,
    quotaPeriod: period,
    status: 'queued',
    createdAt: NOW,
    updatedAt: NOW,
  };
  return {
    tenantId: TENANT.id,
    idempotencyKey,
    requestFingerprint: requestFingerprint({ text, voice, format }),
    job,
    period,
    characterLimit: 10_000,
  };
}

describe.skipIf(!RUN_INFRA_TESTS)('PostgresPlatformRepository integration', () => {
  let admin: postgres.Sql | undefined;
  let first: PostgresPlatformRepository | undefined;
  let second: PostgresPlatformRepository | undefined;
  let app: FastifyInstance | undefined;
  let schemaReady = false;

  function database(): postgres.Sql {
    if (admin === undefined) {
      throw new Error('Integration database was not initialized.');
    }
    return admin;
  }

  function primary(): PostgresPlatformRepository {
    if (first === undefined) {
      throw new Error('Primary repository was not initialized.');
    }
    return first;
  }

  function replica(): PostgresPlatformRepository {
    if (second === undefined) {
      throw new Error('Replica repository was not initialized.');
    }
    return second;
  }

  async function clearTenantState(): Promise<void> {
    await database().begin(async (transaction) => {
      await transaction`
        DELETE FROM webhook_events AS event
        USING speech_jobs AS job
        WHERE event.job_id = job.id
          AND job.tenant_id = ${TENANT.id}
      `;
      await transaction`DELETE FROM idempotency_keys WHERE tenant_id = ${TENANT.id}`;
      await transaction`DELETE FROM speech_jobs WHERE tenant_id = ${TENANT.id}`;
      await transaction`DELETE FROM usage_buckets WHERE tenant_id = ${TENANT.id}`;
    });
  }

  beforeAll(async () => {
    admin = postgres(DATABASE_URL, { max: 2 });
    await runPostgresMigrations(admin);
    schemaReady = true;
    first = await PostgresPlatformRepository.connect({
      databaseUrl: DATABASE_URL,
      tenants: [TENANT],
      maxConnections: 2,
    });
    second = await PostgresPlatformRepository.connect({
      databaseUrl: DATABASE_URL,
      tenants: [TENANT],
      maxConnections: 2,
    });
  });

  beforeEach(async () => {
    await clearTenantState();
  });

  afterAll(async () => {
    if (app !== undefined) {
      await app.close();
    }
    if (admin !== undefined && schemaReady) {
      await clearTenantState();
      await admin`DELETE FROM tenants WHERE id = ${TENANT.id}`;
    }
    await Promise.all([
      first?.close() ?? Promise.resolve(),
      second?.close() ?? Promise.resolve(),
      admin?.end({ timeout: 5 }) ?? Promise.resolve(),
    ]);
  });

  it('runs migrations, stores only API-key digests, and powers app readiness', async () => {
    expect(await primary().ping()).toBe(true);
    expect(await primary().findTenantById(TENANT.id)).toEqual(TENANT);
    expect(await replica().findTenantByApiKeyDigest(digestApiKey(API_KEY))).toEqual(TENANT);

    const stored = await database()<Array<{ api_key_digest: string }>>`
      SELECT api_key_digest FROM tenants WHERE id = ${TENANT.id}
    `;
    expect(stored[0]?.api_key_digest).toBe(digestApiKey(API_KEY));
    expect(stored[0]?.api_key_digest).not.toContain(API_KEY);

    const config: AppConfig = {
      nodeEnv: 'test',
      host: '127.0.0.1',
      port: 3000,
      logLevel: 'silent',
      databaseUrl: DATABASE_URL,
      internalToken: 'postgres_internal_token_for_tests',
      webhookSecret: 'postgres_webhook_secret_for_tests',
      webhookToleranceSeconds: 300,
      tenantSeeds: [
        {
          id: TENANT.id,
          name: TENANT.name,
          planId: TENANT.planId,
          apiKey: API_KEY,
        },
      ],
    };
    app = await buildApp({ config, logger: false });
    const ready = await app.inject({ method: 'GET', url: '/health/ready' });
    const usage = await app.inject({
      method: 'GET',
      url: '/v1/usage',
      headers: { 'x-api-key': API_KEY },
    });
    expect(ready.statusCode).toBe(200);
    expect(usage.statusCode).toBe(200);
    await app.close();
    app = undefined;
  });

  it('deduplicates concurrent submissions across repository instances', async () => {
    const left = command('job_idem_left', 'shared-key', 'read exactly once');
    const right = command('job_idem_right', 'shared-key', 'read exactly once');
    const results = await Promise.all([
      primary().createJobWithReservation(left),
      replica().createJobWithReservation(right),
    ]);

    expect(results.map((result) => result.replayed).sort()).toEqual([false, true]);
    expect(results[0].job.id).toBe(results[1].job.id);
    expect(await primary().getUsage(TENANT.id, '2026-09')).toMatchObject({
      reservedCharacters: 17,
      consumedCharacters: 0,
    });

    const counts = await database()<Array<{ jobs: number; keys: number }>>`
      SELECT
        (SELECT count(*)::integer FROM speech_jobs) AS jobs,
        (SELECT count(*)::integer FROM idempotency_keys) AS keys
    `;
    expect(counts[0]).toEqual({ jobs: 1, keys: 1 });

    const changed = command('job_idem_changed', 'shared-key', 'different request');
    await expect(primary().createJobWithReservation(changed)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
      status: 409,
    });
  });

  it('serializes near-limit reservations and preserves tenant isolation', async () => {
    const left = command('job_quota_left', 'quota-left', 'a'.repeat(6_000));
    const right = command('job_quota_right', 'quota-right', 'b'.repeat(6_000));
    // Simulate a request that authenticated before a plan downgrade. The
    // repository must honor the lower locked database plan, not this stale cap.
    left.characterLimit = 1_000_000;
    right.characterLimit = 1_000_000;
    const results = await Promise.all([
      settle(primary().createJobWithReservation(left)),
      settle(replica().createJobWithReservation(right)),
    ]);
    const accepted = results.filter((result) => result.ok);
    const rejected = results.filter((result) => !result.ok);
    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    if (rejected[0]?.ok === false) {
      expect(rejected[0].error).toMatchObject({ code: 'QUOTA_EXCEEDED', status: 429 });
    }
    expect(await primary().getUsage(TENANT.id, '2026-09')).toMatchObject({
      reservedCharacters: 6_000,
      consumedCharacters: 0,
    });

    const acceptedJob = accepted[0];
    if (acceptedJob?.ok !== true) {
      throw new Error('Expected one accepted quota reservation.');
    }
    expect(await replica().findJobForTenant('tenant_someone_else', acceptedJob.value.job.id)).toBe(
      undefined,
    );
    await expect(
      replica().cancelQueuedJob('tenant_someone_else', acceptedJob.value.job.id, NOW),
    ).rejects.toMatchObject({ code: 'JOB_NOT_FOUND', status: 404 });
  });

  it('locks lifecycle transitions and settles the original quota period exactly once', async () => {
    const created = await primary().createJobWithReservation(
      command('job_complete', 'complete-key', 'done', { period: '2026-01' }),
    );
    const claimed = await replica().claimQueuedJob(created.job.id, '2026-10-01T00:00:00.000Z');
    expect(claimed.status).toBe('processing');
    const completed = await primary().completeProcessingJob(
      created.job.id,
      { artifactUri: 'gs://bucket/done.mp3', sha256: 'a'.repeat(64), durationMs: 120 },
      '2026-10-01T00:00:01.000Z',
    );
    expect(completed.status).toBe('completed');
    expect(await replica().getUsage(TENANT.id, '2026-01')).toMatchObject({
      reservedCharacters: 0,
      consumedCharacters: 4,
    });
    expect(await primary().getUsage(TENANT.id, '2026-10')).toMatchObject({
      reservedCharacters: 0,
      consumedCharacters: 0,
    });
    if (completed.output === undefined) {
      throw new Error('Expected completed job output.');
    }
    await expect(
      replica().completeProcessingJob(created.job.id, completed.output, '2026-10-01T00:00:02.000Z'),
    ).rejects.toMatchObject({ code: 'INVALID_JOB_STATE', status: 409 });

    const failedJob = await primary().createJobWithReservation(
      command('job_failed', 'failure-key', 'failure'),
    );
    await primary().claimQueuedJob(failedJob.job.id, NOW);
    const failed = await replica().failProcessingJob(
      failedJob.job.id,
      { code: 'PROVIDER_FAILURE', message: 'safe failure' },
      NOW,
    );
    expect(failed).toMatchObject({ status: 'failed', failure: { code: 'PROVIDER_FAILURE' } });

    const cancelledJob = await primary().createJobWithReservation(
      command('job_cancelled', 'cancel-key', 'cancel me'),
    );
    const cancelled = await replica().cancelQueuedJob(TENANT.id, cancelledJob.job.id, NOW);
    const cancelledReplay = await primary().cancelQueuedJob(TENANT.id, cancelledJob.job.id, NOW);
    expect(cancelledReplay).toEqual(cancelled);
    await expect(replica().claimQueuedJob(cancelledJob.job.id, NOW)).rejects.toMatchObject({
      code: 'INVALID_JOB_STATE',
      status: 409,
    });
  });

  it('allows exactly one winner in a cross-replica claim/cancel race', async () => {
    const created = await primary().createJobWithReservation(
      command('job_claim_cancel_race', 'claim-cancel-key', 'race'),
    );
    const results = await Promise.all([
      settle(replica().claimQueuedJob(created.job.id, '2026-09-04T12:00:01.000Z')),
      settle(primary().cancelQueuedJob(TENANT.id, created.job.id, '2026-09-04T12:00:01.000Z')),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    const rejection = results.find((result) => !result.ok);
    if (rejection?.ok !== false) {
      throw new Error('Expected one rejected lifecycle transition.');
    }
    expect(rejection.error).toMatchObject({ code: 'INVALID_JOB_STATE', status: 409 });

    const winner = await primary().findJobForTenant(TENANT.id, created.job.id);
    expect(['processing', 'cancelled']).toContain(winner?.status);
    const usage = await replica().getUsage(TENANT.id, '2026-09');
    if (winner?.status === 'processing') {
      expect(usage).toMatchObject({ reservedCharacters: 4, consumedCharacters: 0 });
    } else {
      expect(usage).toMatchObject({ reservedCharacters: 0, consumedCharacters: 0 });
    }
  });

  it('deduplicates concurrent webhooks before state validation and never double-settles', async () => {
    const created = await primary().createJobWithReservation(
      command('job_webhook', 'webhook-key', 'callback'),
    );
    const event = {
      eventId: 'event_shared',
      type: 'synthesis.completed' as const,
      tenantId: TENANT.id,
      jobId: created.job.id,
      output: {
        artifactUri: 'gs://bucket/callback.mp3',
        sha256: 'b'.repeat(64),
        durationMs: 400,
      },
    };
    const results = await Promise.all([
      primary().applyWebhookEvent(event, NOW),
      replica().applyWebhookEvent(event, NOW),
    ]);
    expect(results.map((result) => result.replayed).sort()).toEqual([false, true]);
    expect(await primary().getUsage(TENANT.id, '2026-09')).toMatchObject({
      reservedCharacters: 0,
      consumedCharacters: 8,
    });

    await expect(
      replica().applyWebhookEvent(
        {
          ...event,
          output: { ...event.output, durationMs: 401 },
        },
        NOW,
      ),
    ).rejects.toMatchObject({ code: 'WEBHOOK_EVENT_REUSED', status: 409 });
    await expect(
      primary().applyWebhookEvent({ ...event, eventId: 'event_other' }, NOW),
    ).rejects.toMatchObject({ code: 'INVALID_JOB_STATE', status: 409 });

    const failureJob = await primary().createJobWithReservation(
      command('job_webhook_failure', 'webhook-failure-key', 'release'),
    );
    const failed = await replica().applyWebhookEvent(
      {
        eventId: 'event_failure',
        type: 'synthesis.failed',
        tenantId: TENANT.id,
        jobId: failureJob.job.id,
        error: { code: 'UPSTREAM_REJECTED', message: 'rejected' },
      },
      NOW,
    );
    expect(failed.job.status).toBe('failed');
    expect(await primary().findJobForTenant(TENANT.id, failureJob.job.id)).toEqual(failed.job);
  });

  it('rejects missing tenants and generated job-id collisions without ledger drift', async () => {
    const missingTenant = command('job_missing_tenant', 'missing-tenant-key', 'missing');
    missingTenant.tenantId = 'tenant_missing';
    missingTenant.job.tenantId = 'tenant_missing';
    await expect(primary().createJobWithReservation(missingTenant)).rejects.toMatchObject({
      code: 'TENANT_NOT_FOUND',
      status: 404,
    });

    await primary().createJobWithReservation(command('job_collision', 'collision-one', 'first'));
    await expect(
      replica().createJobWithReservation(command('job_collision', 'collision-two', 'second')),
    ).rejects.toMatchObject({ code: 'JOB_ID_COLLISION', status: 409 });
    expect(await primary().getUsage(TENANT.id, '2026-09')).toMatchObject({
      reservedCharacters: 5,
      consumedCharacters: 0,
    });
  });
});
