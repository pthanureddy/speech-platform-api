import type { FastifyInstance } from 'fastify';
import type { PlatformRepository } from '../repository.js';

export function registerHealthRoutes(app: FastifyInstance, repository: PlatformRepository): void {
  app.get(
    '/health/live',
    {
      schema: {
        tags: ['Operations'],
        summary: 'Process liveness probe',
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['status'],
            properties: { status: { type: 'string', const: 'alive' } },
          },
        },
      },
    },
    () => ({ status: 'alive' as const }),
  );

  app.get(
    '/health/ready',
    {
      schema: {
        tags: ['Operations'],
        summary: 'Dependency readiness probe',
        response: {
          200: {
            type: 'object',
            additionalProperties: false,
            required: ['status', 'checks'],
            properties: {
              status: { type: 'string', const: 'ready' },
              checks: {
                type: 'object',
                additionalProperties: false,
                required: ['repository'],
                properties: { repository: { type: 'string', const: 'up' } },
              },
            },
          },
          503: {
            type: 'object',
            additionalProperties: false,
            required: ['status', 'checks'],
            properties: {
              status: { type: 'string', const: 'not_ready' },
              checks: {
                type: 'object',
                additionalProperties: false,
                required: ['repository'],
                properties: { repository: { type: 'string', const: 'down' } },
              },
            },
          },
        },
      },
    },
    async (_request, reply) => {
      try {
        const ready = await repository.ping();
        if (ready) {
          return { status: 'ready', checks: { repository: 'up' } };
        }
      } catch {
        // Readiness intentionally collapses dependency errors to a down check.
      }
      return reply.code(503).send({ status: 'not_ready', checks: { repository: 'down' } });
    },
  );
}
