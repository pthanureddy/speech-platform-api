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
} from './domain/types.js';

export interface PlatformRepository {
  findTenantByApiKeyDigest(apiKeyDigest: string): Promise<Tenant | undefined>;
  findTenantById(tenantId: string): Promise<Tenant | undefined>;
  createJobWithReservation(command: SubmitJobCommand): Promise<SubmitJobResult>;
  findJobForTenant(tenantId: string, jobId: string): Promise<SpeechJob | undefined>;
  cancelQueuedJob(tenantId: string, jobId: string, now: string): Promise<SpeechJob>;
  claimQueuedJob(jobId: string, now: string): Promise<SpeechJob>;
  completeProcessingJob(jobId: string, output: SpeechOutput, now: string): Promise<SpeechJob>;
  failProcessingJob(jobId: string, failure: SpeechFailure, now: string): Promise<SpeechJob>;
  applyWebhookEvent(event: WebhookEvent, now: string): Promise<ApplyWebhookResult>;
  getUsage(tenantId: string, period: string): Promise<UsageBucket>;
  ping(): Promise<boolean>;
}
