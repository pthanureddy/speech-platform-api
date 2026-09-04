import type { FastifyInstance } from 'fastify';
import type { OutgoingHttpHeaders } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import type { AppConfig } from '../src/config.js';
import type { Clock, IdGenerator, Synthesizer } from '../src/domain/types.js';
import { signWebhookPayload } from '../src/security.js';

const NOW = new Date('2026-09-04T12:00:00.000Z');
const ACME_KEY = 'acme_api_key_for_tests';
const BETA_KEY = 'beta_api_key_for_tests';
const BUSINESS_KEY = 'business_api_key_for_tests';
const INTERNAL_TOKEN = 'internal_token_for_tests';
const WEBHOOK_SECRET = 'webhook_secret_for_tests';

interface JobResponse {
  id: string;
  status: string;
  characterCount: number;
  output?: { artifactUri: string; sha256: string; durationMs: number };
  failure?: { code: string; message: string };
}

interface UsageResponse {
  reservedCharacters: number;
  consumedCharacters: number;
  remainingCharacters: number;
}

interface ProblemResponse {
  status: number;
  code: string;
  requestId: string;
}

class FixedClock implements Clock {
  public now(): Date {
    return new Date(NOW);
  }
}

class SequenceIds implements IdGenerator {
  private value = 0;

  public next(): string {
    this.value += 1;
    return `job_test_${String(this.value).padStart(4, '0')}`;
  }
}

const config: AppConfig = {
  nodeEnv: 'test',
  host: '127.0.0.1',
  port: 3000,
  logLevel: 'silent',
  internalToken: INTERNAL_TOKEN,
  webhookSecret: WEBHOOK_SECRET,
  webhookToleranceSeconds: 300,
  tenantSeeds: [
    { id: 'tenant_acme', name: 'Acme', planId: 'free', apiKey: ACME_KEY },
    { id: 'tenant_beta', name: 'Beta', planId: 'starter', apiKey: BETA_KEY },
    { id: 'tenant_business', name: 'Business', planId: 'business', apiKey: BUSINESS_KEY },
  ],
};

const openApps: FastifyInstance[] = [];

async function makeApp(synthesizer?: Synthesizer): Promise<FastifyInstance> {
  const app = await buildApp({
    config,
    clock: new FixedClock(),
    idGenerator: new SequenceIds(),
    ...(synthesizer === undefined ? {} : { synthesizer }),
    logger: false,
  });
  openApps.push(app);
  return app;
}

function parse<T>(body: string): T {
  return JSON.parse(body) as T;
}

async function createJob(
  app: FastifyInstance,
  key: string,
  idempotencyKey: string,
  text: string,
): Promise<{ statusCode: number; headers: OutgoingHttpHeaders; body: string }> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/speech/jobs',
    headers: { 'x-api-key': key, 'idempotency-key': idempotencyKey },
    payload: { text, voice: 'narrator-en', format: 'mp3' },
  });
  return { statusCode: response.statusCode, headers: response.headers, body: response.body };
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map(async (app) => app.close()));
});

describe('HTTP contract', () => {
  it('refuses an implicit in-memory repository in production', async () => {
    await expect(
      buildApp({ config: { ...config, nodeEnv: 'production' }, logger: false }),
    ).rejects.toThrow('DATABASE_URL is required for the production repository.');
  });

  it('serves liveness, readiness, documentation, and OpenAPI security schemes', async () => {
    const app = await makeApp();
    const live = await app.inject({ method: 'GET', url: '/health/live' });
    const ready = await app.inject({ method: 'GET', url: '/health/ready' });
    const docs = await app.inject({ method: 'GET', url: '/docs/' });
    const spec = await app.inject({ method: 'GET', url: '/openapi.json' });

    expect(live.statusCode).toBe(200);
    expect(parse<{ status: string }>(live.body).status).toBe('alive');
    expect(ready.statusCode).toBe(200);
    expect(parse<{ status: string }>(ready.body).status).toBe('ready');
    expect(docs.statusCode).toBe(200);
    expect(spec.statusCode).toBe(200);
    expect(spec.body).toContain('ApiKeyAuth');
    expect(spec.body).toContain('/v1/speech/jobs');
    expect(spec.body).toContain('"413"');
    expect(spec.body).toContain('"415"');
    expect(live.headers['x-request-id']).toBeTypeOf('string');
  });

  it('returns stable problem+json responses for auth and validation failures', async () => {
    const app = await makeApp();
    const unauthenticated = await app.inject({ method: 'GET', url: '/v1/usage' });
    const invalid = await app.inject({
      method: 'POST',
      url: '/v1/speech/jobs',
      headers: { 'x-api-key': ACME_KEY, 'idempotency-key': 'bad key with spaces' },
      payload: { text: 'hello', extra: true },
    });

    expect(unauthenticated.statusCode).toBe(401);
    expect(unauthenticated.headers['content-type']).toContain('application/problem+json');
    const authProblem = parse<ProblemResponse>(unauthenticated.body);
    expect(authProblem).toMatchObject({ status: 401, code: 'INVALID_API_KEY' });
    expect(authProblem.requestId).toBeTypeOf('string');
    expect(invalid.statusCode).toBe(400);
    expect(parse<ProblemResponse>(invalid.body).code).toBe('VALIDATION_ERROR');
  });

  it('maps malformed JSON and oversized bodies to stable client errors', async () => {
    const app = await makeApp();
    const malformed = await app.inject({
      method: 'POST',
      url: '/v1/speech/jobs',
      headers: {
        'content-type': 'application/json',
        'x-api-key': ACME_KEY,
        'idempotency-key': 'malformed-json',
      },
      payload: '{"text":',
    });
    const oversized = await app.inject({
      method: 'POST',
      url: '/v1/speech/jobs',
      headers: {
        'content-type': 'application/json',
        'x-api-key': ACME_KEY,
        'idempotency-key': 'oversized-body',
      },
      payload: JSON.stringify({ text: 'x'.repeat(300 * 1024) }),
    });

    expect(malformed.statusCode).toBe(400);
    expect(malformed.headers['content-type']).toContain('application/problem+json');
    expect(parse<ProblemResponse>(malformed.body).code).toBe('MALFORMED_JSON');
    expect(oversized.statusCode).toBe(413);
    expect(parse<ProblemResponse>(oversized.body).code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('maps unsupported request media types to a stable 415 response', async () => {
    const app = await makeApp();
    const response = await app.inject({
      method: 'POST',
      url: '/v1/speech/jobs',
      headers: {
        'content-type': 'application/xml',
        'x-api-key': ACME_KEY,
        'idempotency-key': 'unsupported-media-type',
      },
      payload: '<speech>hello</speech>',
    });

    expect(response.statusCode).toBe(415);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(parse<ProblemResponse>(response.body).code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });

  it('accepts a 50,000-code-point four-byte Unicode job within the transport cap', async () => {
    const app = await makeApp();
    const response = await createJob(app, BUSINESS_KEY, 'unicode-limit', '😀'.repeat(50_000));

    expect(response.statusCode).toBe(202);
    expect(parse<JobResponse>(response.body).characterCount).toBe(50_000);
  });

  it('exposes the effective tenant subscription without a billing claim', async () => {
    const app = await makeApp();
    const response = await app.inject({
      method: 'GET',
      url: '/v1/subscription',
      headers: { 'x-api-key': ACME_KEY },
    });
    expect(response.statusCode).toBe(200);
    expect(parse<Record<string, unknown>>(response.body)).toMatchObject({
      tenantId: 'tenant_acme',
      planId: 'free',
      monthlyCharacterLimit: 10_000,
      maxCharactersPerJob: 5_000,
    });
  });
});

describe('idempotency, tenancy, and quota', () => {
  it('returns one job for identical retries and rejects changed payloads', async () => {
    const app = await makeApp();
    const [first, concurrentReplay] = await Promise.all([
      createJob(app, ACME_KEY, 'idem-1', 'Read this once'),
      createJob(app, ACME_KEY, 'idem-1', 'Read this once'),
    ]);

    expect(first.statusCode).toBe(202);
    expect(concurrentReplay.statusCode).toBe(202);
    const firstJob = parse<JobResponse>(first.body);
    const replayedJob = parse<JobResponse>(concurrentReplay.body);
    expect(replayedJob.id).toBe(firstJob.id);
    expect([first.headers['idempotency-replayed'], concurrentReplay.headers['idempotency-replayed']]).toContain(
      'true',
    );
    expect(first.headers.location).toBe(`/v1/speech/jobs/${firstJob.id}`);

    const changed = await createJob(app, ACME_KEY, 'idem-1', 'Different text');
    expect(changed.statusCode).toBe(409);
    expect(parse<ProblemResponse>(changed.body).code).toBe('IDEMPOTENCY_KEY_REUSED');

    const usage = await app.inject({
      method: 'GET',
      url: '/v1/usage',
      headers: { 'x-api-key': ACME_KEY },
    });
    expect(parse<UsageResponse>(usage.body).reservedCharacters).toBe(14);
  });

  it('serializes concurrent reservations so the quota cannot be oversubscribed', async () => {
    const app = await makeApp();
    const text = 'x'.repeat(4_000);
    const responses = await Promise.all([
      createJob(app, ACME_KEY, 'quota-1', text),
      createJob(app, ACME_KEY, 'quota-2', text),
      createJob(app, ACME_KEY, 'quota-3', text),
    ]);

    expect(responses.map((response) => response.statusCode).sort()).toEqual([202, 202, 429]);
    const rejected = responses.find((response) => response.statusCode === 429);
    expect(rejected).toBeDefined();
    expect(parse<ProblemResponse>(rejected?.body ?? '{}').code).toBe('QUOTA_EXCEEDED');

    const usage = await app.inject({
      method: 'GET',
      url: '/v1/usage',
      headers: { 'x-api-key': ACME_KEY },
    });
    expect(parse<UsageResponse>(usage.body)).toMatchObject({
      reservedCharacters: 8_000,
      consumedCharacters: 0,
      remainingCharacters: 2_000,
    });
  });

  it('uses non-enumerating 404 responses across tenants', async () => {
    const app = await makeApp();
    const created = await createJob(app, ACME_KEY, 'private-1', 'private');
    const job = parse<JobResponse>(created.body);
    const read = await app.inject({
      method: 'GET',
      url: `/v1/speech/jobs/${job.id}`,
      headers: { 'x-api-key': BETA_KEY },
    });
    const cancel = await app.inject({
      method: 'POST',
      url: `/v1/speech/jobs/${job.id}/cancel`,
      headers: { 'x-api-key': BETA_KEY },
    });

    expect(read.statusCode).toBe(404);
    expect(cancel.statusCode).toBe(404);
    expect(parse<ProblemResponse>(read.body).code).toBe('JOB_NOT_FOUND');
    expect(parse<ProblemResponse>(cancel.body).code).toBe('JOB_NOT_FOUND');
  });
});

describe('job lifecycle accounting', () => {
  it('moves a reservation to consumed after deterministic synthesis', async () => {
    const app = await makeApp();
    const created = await createJob(app, ACME_KEY, 'process-1', 'four');
    const queued = parse<JobResponse>(created.body);
    expect(queued).not.toHaveProperty('text');
    expect(queued).not.toHaveProperty('tenantId');

    const processed = await app.inject({
      method: 'POST',
      url: `/internal/v1/speech/jobs/${queued.id}/process`,
      headers: { 'x-internal-token': INTERNAL_TOKEN },
    });
    expect(processed.statusCode).toBe(200);
    const completed = parse<JobResponse>(processed.body);
    expect(completed.status).toBe('completed');
    expect(completed.output?.artifactUri).toMatch(/^memory:\/\/synthesis\//);
    expect(completed.output?.sha256).toMatch(/^[a-f0-9]{64}$/);

    const usage = await app.inject({
      method: 'GET',
      url: '/v1/usage',
      headers: { 'x-api-key': ACME_KEY },
    });
    expect(parse<UsageResponse>(usage.body)).toMatchObject({
      reservedCharacters: 0,
      consumedCharacters: 4,
    });

    const duplicateProcess = await app.inject({
      method: 'POST',
      url: `/internal/v1/speech/jobs/${queued.id}/process`,
      headers: { 'x-internal-token': INTERNAL_TOKEN },
    });
    expect(duplicateProcess.statusCode).toBe(409);
  });

  it('releases a reservation on idempotent cancellation and rejects callbacks afterward', async () => {
    const app = await makeApp();
    const created = await createJob(app, ACME_KEY, 'cancel-1', 'cancel me');
    const queued = parse<JobResponse>(created.body);
    const cancelUrl = `/v1/speech/jobs/${queued.id}/cancel`;

    const first = await app.inject({
      method: 'POST',
      url: cancelUrl,
      headers: { 'x-api-key': ACME_KEY },
    });
    const replay = await app.inject({
      method: 'POST',
      url: cancelUrl,
      headers: { 'x-api-key': ACME_KEY },
    });
    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(200);
    expect(parse<JobResponse>(replay.body).status).toBe('cancelled');

    const raw = JSON.stringify({
      eventId: 'evt_after_cancel',
      type: 'synthesis.completed',
      tenantId: 'tenant_acme',
      jobId: queued.id,
      output: {
        artifactUri: 'gs://example/audio.mp3',
        sha256: 'a'.repeat(64),
        durationMs: 500,
      },
    });
    const seconds = String(Math.floor(NOW.getTime() / 1000));
    const callback = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/synthesis',
      headers: {
        'content-type': 'application/json',
        'x-webhook-timestamp': seconds,
        'x-webhook-signature': signWebhookPayload(WEBHOOK_SECRET, seconds, raw),
      },
      payload: raw,
    });
    expect(callback.statusCode).toBe(409);

    const usage = await app.inject({
      method: 'GET',
      url: '/v1/usage',
      headers: { 'x-api-key': ACME_KEY },
    });
    expect(parse<UsageResponse>(usage.body)).toMatchObject({
      reservedCharacters: 0,
      consumedCharacters: 0,
    });
  });

  it('settles a process/cancel race exactly once', async () => {
    const app = await makeApp();
    const created = await createJob(app, ACME_KEY, 'race-1', 'race');
    const queued = parse<JobResponse>(created.body);
    const [processResult, cancelResult] = await Promise.all([
      app.inject({
        method: 'POST',
        url: `/internal/v1/speech/jobs/${queued.id}/process`,
        headers: { 'x-internal-token': INTERNAL_TOKEN },
      }),
      app.inject({
        method: 'POST',
        url: `/v1/speech/jobs/${queued.id}/cancel`,
        headers: { 'x-api-key': ACME_KEY },
      }),
    ]);

    expect([processResult.statusCode, cancelResult.statusCode].sort()).toEqual([200, 409]);
    const usage = await app.inject({
      method: 'GET',
      url: '/v1/usage',
      headers: { 'x-api-key': ACME_KEY },
    });
    const ledger = parse<UsageResponse>(usage.body);
    expect(ledger.reservedCharacters).toBe(0);
    expect([0, 4]).toContain(ledger.consumedCharacters);
  });

  it('releases quota when the synthesizer fails', async () => {
    const synthesizer: Synthesizer = {
      synthesize: async () => Promise.reject(new Error('provider unavailable')),
    };
    const app = await makeApp(synthesizer);
    const created = await createJob(app, ACME_KEY, 'failure-1', 'fail');
    const queued = parse<JobResponse>(created.body);
    const processed = await app.inject({
      method: 'POST',
      url: `/internal/v1/speech/jobs/${queued.id}/process`,
      headers: { 'x-internal-token': INTERNAL_TOKEN },
    });

    expect(processed.statusCode).toBe(200);
    expect(parse<JobResponse>(processed.body)).toMatchObject({
      status: 'failed',
      failure: {
        code: 'SYNTHESIS_FAILED',
        message: 'The synthesis provider could not complete the job.',
      },
    });
    expect(processed.body).not.toContain('provider unavailable');
    const usage = await app.inject({
      method: 'GET',
      url: '/v1/usage',
      headers: { 'x-api-key': ACME_KEY },
    });
    expect(parse<UsageResponse>(usage.body).reservedCharacters).toBe(0);
  });
});

describe('signed webhooks', () => {
  it('verifies raw bytes, deduplicates events, and never double-charges', async () => {
    const app = await makeApp();
    const created = await createJob(app, ACME_KEY, 'webhook-1', 'callback');
    const queued = parse<JobResponse>(created.body);
    const event = {
      eventId: 'evt_complete_1',
      type: 'synthesis.completed',
      tenantId: 'tenant_acme',
      jobId: queued.id,
      output: {
        artifactUri: 'gs://example/audio.mp3',
        sha256: 'b'.repeat(64),
        durationMs: 1_200,
      },
    };
    const raw = JSON.stringify(event);
    const seconds = String(Math.floor(NOW.getTime() / 1000));
    const headers = {
      'content-type': 'application/json',
      'x-webhook-timestamp': seconds,
      'x-webhook-signature': signWebhookPayload(WEBHOOK_SECRET, seconds, raw),
    };

    const first = await app.inject({ method: 'POST', url: '/v1/webhooks/synthesis', headers, payload: raw });
    const replay = await app.inject({ method: 'POST', url: '/v1/webhooks/synthesis', headers, payload: raw });
    expect(first.statusCode).toBe(202);
    expect(replay.statusCode).toBe(202);
    expect(parse<{ replayed: boolean }>(first.body).replayed).toBe(false);
    expect(parse<{ replayed: boolean }>(replay.body).replayed).toBe(true);

    const usage = await app.inject({
      method: 'GET',
      url: '/v1/usage',
      headers: { 'x-api-key': ACME_KEY },
    });
    expect(parse<UsageResponse>(usage.body)).toMatchObject({
      reservedCharacters: 0,
      consumedCharacters: 8,
    });
  });

  it('rejects tampered, stale, and event-id-conflicting callbacks', async () => {
    const app = await makeApp();
    const created = await createJob(app, ACME_KEY, 'webhook-2', 'signed');
    const queued = parse<JobResponse>(created.body);
    const baseEvent = {
      eventId: 'evt_failure_1',
      type: 'synthesis.failed',
      tenantId: 'tenant_acme',
      jobId: queued.id,
      error: { code: 'PROVIDER_ERROR', message: 'rejected' },
    };
    const raw = JSON.stringify(baseEvent);
    const seconds = String(Math.floor(NOW.getTime() / 1000));
    const signature = signWebhookPayload(WEBHOOK_SECRET, seconds, raw);

    const tampered = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/synthesis',
      headers: {
        'content-type': 'application/json',
        'x-webhook-timestamp': seconds,
        'x-webhook-signature': signature,
      },
      payload: raw.replace('rejected', 'changed'),
    });
    expect(tampered.statusCode).toBe(401);
    expect(parse<ProblemResponse>(tampered.body).code).toBe('INVALID_WEBHOOK_SIGNATURE');

    const staleSeconds = String(Math.floor(NOW.getTime() / 1000) - 301);
    const stale = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/synthesis',
      headers: {
        'content-type': 'application/json',
        'x-webhook-timestamp': staleSeconds,
        'x-webhook-signature': signWebhookPayload(WEBHOOK_SECRET, staleSeconds, raw),
      },
      payload: raw,
    });
    expect(stale.statusCode).toBe(401);
    expect(parse<ProblemResponse>(stale.body).code).toBe('STALE_WEBHOOK');

    const validHeaders = {
      'content-type': 'application/json',
      'x-webhook-timestamp': seconds,
      'x-webhook-signature': signature,
    };
    const accepted = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/synthesis',
      headers: validHeaders,
      payload: raw,
    });
    expect(accepted.statusCode).toBe(202);

    const changedEvent = { ...baseEvent, error: { code: 'OTHER', message: 'different' } };
    const changedRaw = JSON.stringify(changedEvent);
    const conflict = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/synthesis',
      headers: {
        'content-type': 'application/json',
        'x-webhook-timestamp': seconds,
        'x-webhook-signature': signWebhookPayload(WEBHOOK_SECRET, seconds, changedRaw),
      },
      payload: changedRaw,
    });
    expect(conflict.statusCode).toBe(409);
    expect(parse<ProblemResponse>(conflict.body).code).toBe('WEBHOOK_EVENT_REUSED');
  });
});
