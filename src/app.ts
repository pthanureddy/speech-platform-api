import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from './config.js';
import type { AppConfig } from './config.js';
import type { Clock, IdGenerator, Synthesizer, Tenant } from './domain/types.js';
import { FakeSynthesizer } from './infrastructure/fake-synthesizer.js';
import { InMemoryPlatformRepository } from './infrastructure/in-memory-repository.js';
import { PostgresPlatformRepository } from './infrastructure/postgres-platform-repository.js';
import { SystemClock } from './infrastructure/system-clock.js';
import { UuidGenerator } from './infrastructure/uuid-generator.js';
import { apiKeyAuthenticator, internalTokenAuthenticator } from './http/auth.js';
import { installErrorHandlers } from './http/error-handler.js';
import { registerHealthRoutes } from './http/health-routes.js';
import {
  registerInternalRoutes,
  registerTenantRoutes,
  registerWebhookRoutes,
} from './http/platform-routes.js';
import type { PlatformRepository } from './repository.js';
import { digestApiKey } from './security.js';
import { PlatformService } from './services/platform-service.js';

export interface BuildAppOptions {
  config?: AppConfig;
  repository?: PlatformRepository;
  clock?: Clock;
  idGenerator?: IdGenerator;
  synthesizer?: Synthesizer;
  logger?: boolean;
}

function tenantsFrom(config: AppConfig): Tenant[] {
  return config.tenantSeeds.map((seed) => ({
    id: seed.id,
    name: seed.name,
    planId: seed.planId,
    apiKeyDigest: digestApiKey(seed.apiKey),
  }));
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const config = options.config ?? loadConfig();
  if (
    config.nodeEnv === 'production' &&
    options.repository === undefined &&
    config.databaseUrl === undefined
  ) {
    throw new Error('DATABASE_URL is required for the production repository.');
  }
  const logger =
    options.logger === false
      ? false
      : {
          level: config.logLevel,
          redact: {
            paths: [
              "req.headers['x-api-key']",
              "req.headers['x-internal-token']",
              "req.headers['x-webhook-signature']",
              "req.headers['idempotency-key']",
            ],
            censor: '[REDACTED]',
          },
        };
  const app = Fastify({
    logger,
    // 50,000 four-byte Unicode code points plus JSON framing fit below this cap.
    bodyLimit: 256 * 1024,
    requestIdHeader: 'x-request-id',
  });

  app.decorateRequest('tenant', null);
  app.decorateRequest('rawBodyText', null);

  // Preserve exact JSON bytes so webhook signatures are not verified against a
  // lossy parse/serialize cycle. Normal schema validation still follows parsing.
  const defaultJsonParser = app.getDefaultJsonParser('ignore', 'ignore');
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (request, body, done) => {
      const rawBody = typeof body === 'string' ? body : body.toString('utf8');
      request.rawBodyText = rawBody;
      void defaultJsonParser(request, rawBody, done);
    },
  );

  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Multi-Tenant Speech Job API',
        description:
          'A deterministic local control-plane reference for tenant auth, quota reservations, and speech job orchestration.',
        version: '1.0.0',
      },
      servers: [{ url: 'http://localhost:3000', description: 'Local development' }],
      components: {
        securitySchemes: {
          ApiKeyAuth: { type: 'apiKey', in: 'header', name: 'x-api-key' },
          InternalToken: { type: 'apiKey', in: 'header', name: 'x-internal-token' },
        },
      },
    },
  });
  await app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: { docExpansion: 'list', deepLinking: true },
  });

  let managedRepository: PostgresPlatformRepository | undefined;
  let repository = options.repository;
  if (repository === undefined) {
    const tenants = tenantsFrom(config);
    if (config.databaseUrl === undefined) {
      repository = new InMemoryPlatformRepository(tenants);
    } else {
      managedRepository = await PostgresPlatformRepository.connect({
        databaseUrl: config.databaseUrl,
        tenants,
      });
      repository = managedRepository;
    }
  }
  if (managedRepository !== undefined) {
    app.addHook('onClose', async () => managedRepository.close());
  }
  const clock = options.clock ?? new SystemClock();
  const service = new PlatformService(
    repository,
    clock,
    options.idGenerator ?? new UuidGenerator(),
    options.synthesizer ?? new FakeSynthesizer(),
    (error, context) => {
      app.log.error({ err: error, ...context }, 'speech synthesis failed');
    },
  );

  installErrorHandlers(app);
  registerHealthRoutes(app, repository);
  registerTenantRoutes(app, service, apiKeyAuthenticator(repository));
  registerInternalRoutes(app, service, internalTokenAuthenticator(config.internalToken));
  registerWebhookRoutes(
    app,
    service,
    clock,
    config.webhookSecret,
    config.webhookToleranceSeconds,
  );

  app.get('/openapi.json', { schema: { hide: true } }, () => app.swagger());

  app.addHook('onSend', async (request, reply, payload) => {
    void reply.header('x-request-id', request.id);
    return payload;
  });

  return app;
}
