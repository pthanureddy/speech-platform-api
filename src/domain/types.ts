export const PLAN_IDS = ['free', 'starter', 'business'] as const;

export type PlanId = (typeof PLAN_IDS)[number];

export type AudioFormat = 'mp3' | 'wav';

export type JobStatus = 'queued' | 'processing' | 'completed' | 'failed' | 'cancelled';

export interface PlanPolicy {
  id: PlanId;
  displayName: string;
  monthlyCharacterLimit: number;
  maxCharactersPerJob: number;
}

export interface TenantSeed {
  id: string;
  name: string;
  planId: PlanId;
  apiKey: string;
}

export interface Tenant {
  id: string;
  name: string;
  planId: PlanId;
  apiKeyDigest: string;
}

export interface SpeechOutput {
  artifactUri: string;
  sha256: string;
  durationMs: number;
}

export interface SpeechFailure {
  code: string;
  message: string;
}

export interface SpeechJob {
  id: string;
  tenantId: string;
  text: string;
  voice: string;
  format: AudioFormat;
  characterCount: number;
  quotaPeriod: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  output?: SpeechOutput;
  failure?: SpeechFailure;
}

export interface PublicSpeechJob {
  id: string;
  voice: string;
  format: AudioFormat;
  characterCount: number;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  output?: SpeechOutput;
  failure?: SpeechFailure;
}

export interface UsageBucket {
  tenantId: string;
  period: string;
  reservedCharacters: number;
  consumedCharacters: number;
}

export interface UsageSummary extends UsageBucket {
  characterLimit: number;
  remainingCharacters: number;
}

export interface SubmitJobCommand {
  tenantId: string;
  idempotencyKey: string;
  requestFingerprint: string;
  job: SpeechJob;
  period: string;
  characterLimit: number;
}

export interface SubmitJobResult {
  job: SpeechJob;
  replayed: boolean;
}

export interface WebhookEvent {
  eventId: string;
  type: 'synthesis.completed' | 'synthesis.failed';
  tenantId: string;
  jobId: string;
  output?: SpeechOutput;
  error?: SpeechFailure;
}

export interface ApplyWebhookResult {
  job: SpeechJob;
  replayed: boolean;
}

export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  next(): string;
}

export interface Synthesizer {
  synthesize(job: SpeechJob): Promise<SpeechOutput>;
}
