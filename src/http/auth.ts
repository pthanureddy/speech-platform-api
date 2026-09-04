import type { FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { unauthorized } from '../domain/errors.js';
import type { Tenant } from '../domain/types.js';
import type { PlatformRepository } from '../repository.js';
import { constantTimeEqual, digestApiKey } from '../security.js';

declare module 'fastify' {
  interface FastifyRequest {
    tenant: Tenant | null;
    rawBodyText: string | null;
  }
}

function headerValue(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export function apiKeyAuthenticator(repository: PlatformRepository): preHandlerAsyncHookHandler {
  return async (request) => {
    const apiKey = headerValue(request, 'x-api-key');
    if (apiKey === undefined || apiKey.length < 12 || apiKey.length > 256) {
      throw unauthorized('INVALID_API_KEY', 'A valid API key is required.');
    }
    const tenant = await repository.findTenantByApiKeyDigest(digestApiKey(apiKey));
    if (tenant === undefined) {
      throw unauthorized('INVALID_API_KEY', 'A valid API key is required.');
    }
    request.tenant = tenant;
  };
}

export function internalTokenAuthenticator(expectedToken: string): preHandlerAsyncHookHandler {
  return (request) => {
    const token = headerValue(request, 'x-internal-token');
    if (token === undefined || !constantTimeEqual(token, expectedToken)) {
      throw unauthorized('INVALID_INTERNAL_TOKEN', 'A valid internal token is required.');
    }
    return Promise.resolve();
  };
}

export function requireTenant(request: FastifyRequest): Tenant {
  if (request.tenant === null) {
    throw unauthorized('INVALID_API_KEY', 'A valid API key is required.');
  }
  return request.tenant;
}
