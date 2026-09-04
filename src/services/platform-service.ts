import { badRequest, notFound } from '../domain/errors.js';
import { getPlanPolicy } from '../domain/plans.js';
import type {
  ApplyWebhookResult,
  AudioFormat,
  Clock,
  IdGenerator,
  PublicSpeechJob,
  SpeechJob,
  SubmitJobResult,
  Synthesizer,
  Tenant,
  UsageSummary,
  WebhookEvent,
} from '../domain/types.js';
import type { PlatformRepository } from '../repository.js';
import { requestFingerprint } from '../security.js';

export interface SubmitSpeechInput {
  text: string;
  voice?: string;
  format?: AudioFormat;
}

export type SynthesisErrorReporter = (
  error: unknown,
  context: { jobId: string; tenantId: string },
) => void;

function periodFor(date: Date): string {
  return date.toISOString().slice(0, 7);
}

function timestamp(date: Date): string {
  return date.toISOString();
}

export function toPublicJob(job: SpeechJob): PublicSpeechJob {
  const publicJob: PublicSpeechJob = {
    id: job.id,
    voice: job.voice,
    format: job.format,
    characterCount: job.characterCount,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
  if (job.output !== undefined) {
    publicJob.output = structuredClone(job.output);
  }
  if (job.failure !== undefined) {
    publicJob.failure = structuredClone(job.failure);
  }
  return publicJob;
}

export class PlatformService {
  public constructor(
    private readonly repository: PlatformRepository,
    private readonly clock: Clock,
    private readonly idGenerator: IdGenerator,
    private readonly synthesizer: Synthesizer,
    private readonly reportSynthesisError: SynthesisErrorReporter = () => undefined,
  ) {}

  public async submitSpeechJob(
    tenant: Tenant,
    idempotencyKey: string,
    input: SubmitSpeechInput,
  ): Promise<SubmitJobResult> {
    const text = input.text;
    if (text.trim().length === 0) {
      throw badRequest('EMPTY_TEXT', 'Text must contain at least one non-whitespace character.');
    }
    const characterCount = Array.from(text).length;
    const policy = getPlanPolicy(tenant.planId);
    if (characterCount > policy.maxCharactersPerJob) {
      throw badRequest('JOB_TOO_LARGE', 'Text exceeds the plan limit for one speech job.', {
        characterCount,
        maxCharactersPerJob: policy.maxCharactersPerJob,
        planId: policy.id,
      });
    }

    const voice = input.voice ?? 'narrator-en';
    const format = input.format ?? 'mp3';
    const now = this.clock.now();
    const period = periodFor(now);
    const job: SpeechJob = {
      id: this.idGenerator.next(),
      tenantId: tenant.id,
      text,
      voice,
      format,
      characterCount,
      quotaPeriod: period,
      status: 'queued',
      createdAt: timestamp(now),
      updatedAt: timestamp(now),
    };

    return this.repository.createJobWithReservation({
      tenantId: tenant.id,
      idempotencyKey,
      requestFingerprint: requestFingerprint({ text, voice, format }),
      job,
      period,
      characterLimit: policy.monthlyCharacterLimit,
    });
  }

  public async getJob(tenantId: string, jobId: string): Promise<SpeechJob> {
    const job = await this.repository.findJobForTenant(tenantId, jobId);
    if (job === undefined) {
      throw notFound('JOB_NOT_FOUND', 'Speech job was not found.');
    }
    return job;
  }

  public async cancelJob(tenantId: string, jobId: string): Promise<SpeechJob> {
    return this.repository.cancelQueuedJob(tenantId, jobId, timestamp(this.clock.now()));
  }

  public async processJob(jobId: string): Promise<SpeechJob> {
    const claimed = await this.repository.claimQueuedJob(jobId, timestamp(this.clock.now()));
    let output;
    try {
      output = await this.synthesizer.synthesize(claimed);
    } catch (error) {
      this.reportSynthesisError(error, { jobId: claimed.id, tenantId: claimed.tenantId });
      return this.repository.failProcessingJob(
        jobId,
        { code: 'SYNTHESIS_FAILED', message: 'The synthesis provider could not complete the job.' },
        timestamp(this.clock.now()),
      );
    }
    return this.repository.completeProcessingJob(jobId, output, timestamp(this.clock.now()));
  }

  public async applyWebhook(event: WebhookEvent): Promise<ApplyWebhookResult> {
    if (event.type === 'synthesis.completed' && event.output === undefined) {
      throw badRequest('INVALID_WEBHOOK_EVENT', 'A completed event requires output.');
    }
    if (event.type === 'synthesis.failed' && event.error === undefined) {
      throw badRequest('INVALID_WEBHOOK_EVENT', 'A failed event requires error details.');
    }
    return this.repository.applyWebhookEvent(event, timestamp(this.clock.now()));
  }

  public async usageFor(tenant: Tenant): Promise<UsageSummary> {
    const policy = getPlanPolicy(tenant.planId);
    const period = periodFor(this.clock.now());
    const bucket = await this.repository.getUsage(tenant.id, period);
    return {
      ...bucket,
      characterLimit: policy.monthlyCharacterLimit,
      remainingCharacters: Math.max(
        0,
        policy.monthlyCharacterLimit - bucket.reservedCharacters - bucket.consumedCharacters,
      ),
    };
  }

  public subscriptionFor(tenant: Tenant): {
    tenantId: string;
    planId: string;
    planName: string;
    monthlyCharacterLimit: number;
    maxCharactersPerJob: number;
  } {
    const policy = getPlanPolicy(tenant.planId);
    return {
      tenantId: tenant.id,
      planId: policy.id,
      planName: policy.displayName,
      monthlyCharacterLimit: policy.monthlyCharacterLimit,
      maxCharactersPerJob: policy.maxCharactersPerJob,
    };
  }
}
