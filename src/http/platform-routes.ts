import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify';
import { badRequest, unauthorized } from '../domain/errors.js';
import type { AudioFormat, Clock, WebhookEvent } from '../domain/types.js';
import { verifyWebhookSignature } from '../security.js';
import { toPublicJob } from '../services/platform-service.js';
import type { PlatformService } from '../services/platform-service.js';
import { requireTenant } from './auth.js';
import {
  apiKeySecurity,
  errorResponses,
  internalTokenSecurity,
  jobIdParamsSchema,
  speechFailureSchema,
  speechJobSchema,
  speechOutputSchema,
} from './schemas.js';

interface JobIdParams {
  jobId: string;
}

interface CreateJobHeaders {
  'idempotency-key': string;
}

interface CreateJobBody {
  text: string;
  voice?: string;
  format?: AudioFormat;
}

interface WebhookHeaders {
  'x-webhook-signature': string;
  'x-webhook-timestamp': string;
}

const IDEMPOTENCY_KEY_PATTERN = '^[A-Za-z0-9._:-]+$';
const IDENTIFIER_PATTERN = '^[A-Za-z0-9_-]+$';

export function registerTenantRoutes(
  app: FastifyInstance,
  service: PlatformService,
  authenticate: preHandlerAsyncHookHandler,
): void {
  app.post<{ Body: CreateJobBody; Headers: CreateJobHeaders }>(
    '/v1/speech/jobs',
    {
      preHandler: authenticate,
      schema: {
        tags: ['Speech jobs'],
        summary: 'Reserve quota and create a speech job',
        security: apiKeySecurity,
        headers: {
          type: 'object',
          required: ['idempotency-key'],
          properties: {
            'idempotency-key': {
              type: 'string',
              minLength: 1,
              maxLength: 128,
              pattern: IDEMPOTENCY_KEY_PATTERN,
            },
          },
        },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['text'],
          properties: {
            text: { type: 'string', minLength: 1, maxLength: 50_000 },
            voice: {
              type: 'string',
              enum: ['narrator-en', 'narrator-sv', 'assistant-en'],
              default: 'narrator-en',
            },
            format: { type: 'string', enum: ['mp3', 'wav'], default: 'mp3' },
          },
        },
        response: { 202: speechJobSchema, ...errorResponses },
      },
    },
    async (request, reply) => {
      const tenant = requireTenant(request);
      const result = await service.submitSpeechJob(
        tenant,
        request.headers['idempotency-key'],
        request.body,
      );
      return reply
        .code(202)
        .header('location', `/v1/speech/jobs/${result.job.id}`)
        .header('idempotency-replayed', String(result.replayed))
        .send(toPublicJob(result.job));
    },
  );

  app.get<{ Params: JobIdParams }>(
    '/v1/speech/jobs/:jobId',
    {
      preHandler: authenticate,
      schema: {
        tags: ['Speech jobs'],
        summary: 'Get a tenant-scoped speech job',
        security: apiKeySecurity,
        params: jobIdParamsSchema,
        response: { 200: speechJobSchema, ...errorResponses },
      },
    },
    async (request) => {
      const tenant = requireTenant(request);
      return toPublicJob(await service.getJob(tenant.id, request.params.jobId));
    },
  );

  app.post<{ Params: JobIdParams }>(
    '/v1/speech/jobs/:jobId/cancel',
    {
      preHandler: authenticate,
      schema: {
        tags: ['Speech jobs'],
        summary: 'Cancel a queued speech job and release its reservation',
        security: apiKeySecurity,
        params: jobIdParamsSchema,
        response: { 200: speechJobSchema, ...errorResponses },
      },
    },
    async (request) => {
      const tenant = requireTenant(request);
      return toPublicJob(await service.cancelJob(tenant.id, request.params.jobId));
    },
  );

  app.get(
    '/v1/usage',
    {
      preHandler: authenticate,
      schema: {
        tags: ['Subscriptions and usage'],
        summary: 'Get the current UTC-month quota ledger',
        security: apiKeySecurity,
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: [
              'tenantId',
              'period',
              'reservedCharacters',
              'consumedCharacters',
              'characterLimit',
              'remainingCharacters',
            ],
            properties: {
              tenantId: { type: 'string' },
              period: { type: 'string', pattern: '^\\d{4}-\\d{2}$' },
              reservedCharacters: { type: 'integer', minimum: 0 },
              consumedCharacters: { type: 'integer', minimum: 0 },
              characterLimit: { type: 'integer', minimum: 0 },
              remainingCharacters: { type: 'integer', minimum: 0 },
            },
          },
          ...errorResponses,
        },
      },
    },
    async (request) => service.usageFor(requireTenant(request)),
  );

  app.get(
    '/v1/subscription',
    {
      preHandler: authenticate,
      schema: {
        tags: ['Subscriptions and usage'],
        summary: 'Get the effective subscription policy',
        security: apiKeySecurity,
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: [
              'tenantId',
              'planId',
              'planName',
              'monthlyCharacterLimit',
              'maxCharactersPerJob',
            ],
            properties: {
              tenantId: { type: 'string' },
              planId: { type: 'string', enum: ['free', 'starter', 'business'] },
              planName: { type: 'string' },
              monthlyCharacterLimit: { type: 'integer', minimum: 0 },
              maxCharactersPerJob: { type: 'integer', minimum: 0 },
            },
          },
          ...errorResponses,
        },
      },
    },
    (request) => service.subscriptionFor(requireTenant(request)),
  );
}

export function registerInternalRoutes(
  app: FastifyInstance,
  service: PlatformService,
  authenticate: preHandlerAsyncHookHandler,
): void {
  app.post<{ Params: JobIdParams }>(
    '/internal/v1/speech/jobs/:jobId/process',
    {
      preHandler: authenticate,
      schema: {
        tags: ['Internal worker boundary'],
        summary: 'Run the deterministic local synthesizer for one queued job',
        security: internalTokenSecurity,
        params: jobIdParamsSchema,
        response: { 200: speechJobSchema, ...errorResponses },
      },
    },
    async (request) => toPublicJob(await service.processJob(request.params.jobId)),
  );
}

export function registerWebhookRoutes(
  app: FastifyInstance,
  service: PlatformService,
  clock: Clock,
  secret: string,
  toleranceSeconds: number,
): void {
  app.post<{ Body: WebhookEvent; Headers: WebhookHeaders }>(
    '/v1/webhooks/synthesis',
    {
      schema: {
        tags: ['Provider webhooks'],
        summary: 'Apply a signed synthesis provider event',
        headers: {
          type: 'object',
          required: ['x-webhook-signature', 'x-webhook-timestamp'],
          properties: {
            'x-webhook-signature': { type: 'string', pattern: '^v1=[a-f0-9]{64}$' },
            'x-webhook-timestamp': { type: 'string', pattern: '^\\d{10}$' },
          },
        },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['eventId', 'type', 'tenantId', 'jobId'],
          properties: {
            eventId: { type: 'string', minLength: 5, maxLength: 100, pattern: IDENTIFIER_PATTERN },
            type: { type: 'string', enum: ['synthesis.completed', 'synthesis.failed'] },
            tenantId: { type: 'string', minLength: 3, maxLength: 100, pattern: IDENTIFIER_PATTERN },
            jobId: { type: 'string', minLength: 5, maxLength: 100 },
            output: speechOutputSchema,
            error: speechFailureSchema,
          },
        },
        response: {
          202: {
            type: 'object',
            additionalProperties: false,
            required: ['eventId', 'replayed', 'jobId', 'status'],
            properties: {
              eventId: { type: 'string' },
              replayed: { type: 'boolean' },
              jobId: { type: 'string' },
              status: { type: 'string' },
            },
          },
          ...errorResponses,
        },
      },
    },
    async (request, reply) => {
      const rawBody = request.rawBodyText;
      if (rawBody === null) {
        throw badRequest('RAW_BODY_UNAVAILABLE', 'The webhook body could not be verified.');
      }
      const timestamp = Number(request.headers['x-webhook-timestamp']);
      const now = Math.floor(clock.now().getTime() / 1000);
      if (!Number.isSafeInteger(timestamp) || Math.abs(now - timestamp) > toleranceSeconds) {
        throw unauthorized('STALE_WEBHOOK', 'The webhook timestamp is outside the replay window.');
      }
      if (
        !verifyWebhookSignature(
          secret,
          request.headers['x-webhook-timestamp'],
          rawBody,
          request.headers['x-webhook-signature'],
        )
      ) {
        throw unauthorized('INVALID_WEBHOOK_SIGNATURE', 'The webhook signature is invalid.');
      }
      if (
        (request.body.type === 'synthesis.completed' && request.body.error !== undefined) ||
        (request.body.type === 'synthesis.failed' && request.body.output !== undefined)
      ) {
        throw badRequest('INVALID_WEBHOOK_EVENT', 'The event contains fields for the wrong event type.');
      }

      const result = await service.applyWebhook(request.body);
      return reply.code(202).send({
        eventId: request.body.eventId,
        replayed: result.replayed,
        jobId: result.job.id,
        status: result.job.status,
      });
    },
  );
}
