import { conflict, notFound, tooManyRequests } from '../domain/errors.js';
import { getPlanPolicy } from '../domain/plans.js';
import type {
  ApplyWebhookResult,
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

interface IdempotencyRecord {
  fingerprint: string;
  jobId: string;
}

interface WebhookRecord {
  fingerprint: string;
  jobId: string;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function usageKey(tenantId: string, period: string): string {
  return `${tenantId}:${period}`;
}

function idempotencyKey(tenantId: string, key: string): string {
  return `${tenantId}:${key}`;
}

/**
 * Deterministic single-process adapter.
 *
 * All read-modify-write operations run under one async mutex. This makes races
 * reproducible in tests but is deliberately not a distributed lock. A durable
 * adapter must preserve the same method-level transaction boundaries.
 */
export class InMemoryPlatformRepository implements PlatformRepository {
  private readonly tenantsById = new Map<string, Tenant>();
  private readonly tenantIdByDigest = new Map<string, string>();
  private readonly jobs = new Map<string, SpeechJob>();
  private readonly usage = new Map<string, UsageBucket>();
  private readonly idempotencyRecords = new Map<string, IdempotencyRecord>();
  private readonly webhookRecords = new Map<string, WebhookRecord>();
  private mutexTail: Promise<void> = Promise.resolve();

  public constructor(tenants: readonly Tenant[]) {
    for (const tenant of tenants) {
      if (this.tenantsById.has(tenant.id) || this.tenantIdByDigest.has(tenant.apiKeyDigest)) {
        throw new Error(`Duplicate tenant id or API-key digest for '${tenant.id}'.`);
      }
      this.tenantsById.set(tenant.id, clone(tenant));
      this.tenantIdByDigest.set(tenant.apiKeyDigest, tenant.id);
    }
  }

  public async findTenantByApiKeyDigest(apiKeyDigest: string): Promise<Tenant | undefined> {
    return this.exclusive(() => {
      const tenantId = this.tenantIdByDigest.get(apiKeyDigest);
      const tenant = tenantId === undefined ? undefined : this.tenantsById.get(tenantId);
      return tenant === undefined ? undefined : clone(tenant);
    });
  }

  public async findTenantById(tenantId: string): Promise<Tenant | undefined> {
    return this.exclusive(() => {
      const tenant = this.tenantsById.get(tenantId);
      return tenant === undefined ? undefined : clone(tenant);
    });
  }

  public async createJobWithReservation(command: SubmitJobCommand): Promise<SubmitJobResult> {
    return this.exclusive(() => {
      const recordKey = idempotencyKey(command.tenantId, command.idempotencyKey);
      const existingRecord = this.idempotencyRecords.get(recordKey);

      if (existingRecord !== undefined) {
        if (existingRecord.fingerprint !== command.requestFingerprint) {
          throw conflict(
            'IDEMPOTENCY_KEY_REUSED',
            'The Idempotency-Key was already used with a different request body.',
          );
        }

        const existingJob = this.jobs.get(existingRecord.jobId);
        if (existingJob === undefined) {
          throw new Error('Repository invariant failed: idempotency record has no job.');
        }
        return { job: clone(existingJob), replayed: true };
      }

      const tenant = this.tenantsById.get(command.tenantId);
      if (tenant === undefined) {
        throw notFound('TENANT_NOT_FOUND', 'Tenant was not found.');
      }
      const characterLimit = Math.min(
        command.characterLimit,
        getPlanPolicy(tenant.planId).monthlyCharacterLimit,
      );
      if (this.jobs.has(command.job.id)) {
        throw conflict('JOB_ID_COLLISION', 'A generated job identifier already exists.');
      }

      const key = usageKey(command.tenantId, command.period);
      const bucket = this.usage.get(key) ?? {
        tenantId: command.tenantId,
        period: command.period,
        reservedCharacters: 0,
        consumedCharacters: 0,
      };
      const attemptedTotal =
        bucket.reservedCharacters + bucket.consumedCharacters + command.job.characterCount;

      if (attemptedTotal > characterLimit) {
        const remaining = Math.max(
          0,
          characterLimit - bucket.reservedCharacters - bucket.consumedCharacters,
        );
        throw tooManyRequests('QUOTA_EXCEEDED', 'The monthly character quota would be exceeded.', {
          characterLimit,
          requestedCharacters: command.job.characterCount,
          remainingCharacters: remaining,
          period: command.period,
        });
      }

      const job = clone({ ...command.job, quotaPeriod: command.period });
      this.jobs.set(job.id, job);
      this.usage.set(key, {
        ...bucket,
        reservedCharacters: bucket.reservedCharacters + job.characterCount,
      });
      this.idempotencyRecords.set(recordKey, {
        fingerprint: command.requestFingerprint,
        jobId: job.id,
      });

      return { job: clone(job), replayed: false };
    });
  }

  public async findJobForTenant(tenantId: string, jobId: string): Promise<SpeechJob | undefined> {
    return this.exclusive(() => {
      const job = this.jobs.get(jobId);
      return job === undefined || job.tenantId !== tenantId ? undefined : clone(job);
    });
  }

  public async cancelQueuedJob(tenantId: string, jobId: string, now: string): Promise<SpeechJob> {
    return this.exclusive(() => {
      const job = this.requireTenantJob(tenantId, jobId);
      if (job.status === 'cancelled') {
        return clone(job);
      }
      if (job.status !== 'queued') {
        throw conflict('INVALID_JOB_STATE', `A '${job.status}' job cannot be cancelled.`, {
          currentStatus: job.status,
          allowedStatus: 'queued',
        });
      }

      this.releaseReservation(job);
      job.status = 'cancelled';
      job.updatedAt = now;
      return clone(job);
    });
  }

  public async claimQueuedJob(jobId: string, now: string): Promise<SpeechJob> {
    return this.exclusive(() => {
      const job = this.requireJob(jobId);
      if (job.status !== 'queued') {
        throw conflict('INVALID_JOB_STATE', `A '${job.status}' job cannot begin processing.`, {
          currentStatus: job.status,
          allowedStatus: 'queued',
        });
      }
      job.status = 'processing';
      job.updatedAt = now;
      return clone(job);
    });
  }

  public async completeProcessingJob(
    jobId: string,
    output: SpeechOutput,
    now: string,
  ): Promise<SpeechJob> {
    return this.exclusive(() => {
      const job = this.requireJob(jobId);
      if (job.status !== 'processing') {
        throw conflict('INVALID_JOB_STATE', `A '${job.status}' job cannot be completed.`, {
          currentStatus: job.status,
          allowedStatus: 'processing',
        });
      }
      this.consumeReservation(job);
      job.status = 'completed';
      job.output = clone(output);
      job.updatedAt = now;
      return clone(job);
    });
  }

  public async failProcessingJob(
    jobId: string,
    failure: SpeechFailure,
    now: string,
  ): Promise<SpeechJob> {
    return this.exclusive(() => {
      const job = this.requireJob(jobId);
      if (job.status !== 'processing') {
        throw conflict('INVALID_JOB_STATE', `A '${job.status}' job cannot be failed.`, {
          currentStatus: job.status,
          allowedStatus: 'processing',
        });
      }
      this.releaseReservation(job);
      job.status = 'failed';
      job.failure = clone(failure);
      job.updatedAt = now;
      return clone(job);
    });
  }

  public async applyWebhookEvent(event: WebhookEvent, now: string): Promise<ApplyWebhookResult> {
    return this.exclusive(() => {
      const fingerprint = webhookEventFingerprint(event);
      const existingRecord = this.webhookRecords.get(event.eventId);
      if (existingRecord !== undefined) {
        if (existingRecord.fingerprint !== fingerprint) {
          throw conflict(
            'WEBHOOK_EVENT_REUSED',
            'The webhook event id was already used with a different payload.',
          );
        }
        const replayedJob = this.requireJob(existingRecord.jobId);
        return { job: clone(replayedJob), replayed: true };
      }

      const job = this.requireTenantJob(event.tenantId, event.jobId);
      if (job.status !== 'queued' && job.status !== 'processing') {
        throw conflict(
          'INVALID_JOB_STATE',
          `A '${job.status}' job cannot accept a synthesis callback.`,
          { currentStatus: job.status, allowedStatuses: ['queued', 'processing'] },
        );
      }

      if (event.type === 'synthesis.completed') {
        if (event.output === undefined) {
          throw new Error('Repository invariant failed: completed event has no output.');
        }
        this.consumeReservation(job);
        job.status = 'completed';
        job.output = clone(event.output);
      } else {
        if (event.error === undefined) {
          throw new Error('Repository invariant failed: failed event has no error.');
        }
        this.releaseReservation(job);
        job.status = 'failed';
        job.failure = clone(event.error);
      }
      job.updatedAt = now;
      this.webhookRecords.set(event.eventId, { fingerprint, jobId: job.id });
      return { job: clone(job), replayed: false };
    });
  }

  public async getUsage(tenantId: string, period: string): Promise<UsageBucket> {
    return this.exclusive(() => {
      const bucket = this.usage.get(usageKey(tenantId, period));
      return clone(
        bucket ?? {
          tenantId,
          period,
          reservedCharacters: 0,
          consumedCharacters: 0,
        },
      );
    });
  }

  public async ping(): Promise<boolean> {
    return Promise.resolve(true);
  }

  private requireJob(jobId: string): SpeechJob {
    const job = this.jobs.get(jobId);
    if (job === undefined) {
      throw notFound('JOB_NOT_FOUND', 'Speech job was not found.');
    }
    return job;
  }

  private requireTenantJob(tenantId: string, jobId: string): SpeechJob {
    const job = this.jobs.get(jobId);
    if (job === undefined || job.tenantId !== tenantId) {
      // A uniform 404 prevents callers from enumerating another tenant's jobs.
      throw notFound('JOB_NOT_FOUND', 'Speech job was not found.');
    }
    return job;
  }

  private releaseReservation(job: SpeechJob): void {
    const key = usageKey(job.tenantId, job.quotaPeriod);
    const bucket = this.usage.get(key);
    if (bucket === undefined || bucket.reservedCharacters < job.characterCount) {
      throw new Error('Repository invariant failed: insufficient reserved characters.');
    }
    bucket.reservedCharacters -= job.characterCount;
  }

  private consumeReservation(job: SpeechJob): void {
    const key = usageKey(job.tenantId, job.quotaPeriod);
    const bucket = this.usage.get(key);
    if (bucket === undefined || bucket.reservedCharacters < job.characterCount) {
      throw new Error('Repository invariant failed: insufficient reserved characters.');
    }
    bucket.reservedCharacters -= job.characterCount;
    bucket.consumedCharacters += job.characterCount;
  }

  private async exclusive<T>(operation: () => T | Promise<T>): Promise<T> {
    const previous = this.mutexTail;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.mutexTail = previous.then(() => gate);
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
