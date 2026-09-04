import type { FastifyError, FastifyInstance, FastifyRequest } from 'fastify';
import { DomainError } from '../domain/errors.js';

interface ValidationItem {
  instancePath?: string;
  message?: string;
}

function titleFor(status: number): string {
  const titles: Record<number, string> = {
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    409: 'Conflict',
    413: 'Payload Too Large',
    415: 'Unsupported Media Type',
    429: 'Too Many Requests',
    500: 'Internal Server Error',
    503: 'Service Unavailable',
  };
  return titles[status] ?? 'Request Failed';
}

function validationDetails(error: FastifyError): { violations: ValidationItem[] } | undefined {
  if (error.validation === undefined) {
    return undefined;
  }
  return {
    violations: error.validation.map((item) => ({
      instancePath: item.instancePath,
      message: item.message,
    })),
  };
}

function problem(
  request: FastifyRequest,
  status: number,
  code: string,
  detail: string,
  details?: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    type: `https://speech-platform.example/problems/${code.toLowerCase().replaceAll('_', '-')}`,
    title: titleFor(status),
    status,
    detail,
    instance: request.url,
    code,
    requestId: request.id,
    ...(details === undefined ? {} : { details }),
  };
}

export function installErrorHandlers(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) => {
    void reply
      .code(404)
      .type('application/problem+json')
      .send(problem(request, 404, 'ROUTE_NOT_FOUND', 'The requested route was not found.'));
  });

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof DomainError) {
      request.log.warn({ code: error.code, status: error.status }, 'request rejected');
      void reply
        .code(error.status)
        .type('application/problem+json')
        .send(problem(request, error.status, error.code, error.message, error.details));
      return;
    }

    if (error.validation !== undefined) {
      void reply
        .code(400)
        .type('application/problem+json')
        .send(
          problem(
            request,
            400,
            'VALIDATION_ERROR',
            'The request did not match the API contract.',
            validationDetails(error),
          ),
        );
      return;
    }

    if (error.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      void reply
        .code(413)
        .type('application/problem+json')
        .send(
          problem(
            request,
            413,
            'PAYLOAD_TOO_LARGE',
            'The request body exceeds the supported size.',
          ),
        );
      return;
    }

    if (
      error.code === 'FST_ERR_CTP_INVALID_JSON_BODY' ||
      error.code === 'FST_ERR_CTP_EMPTY_JSON_BODY'
    ) {
      void reply
        .code(400)
        .type('application/problem+json')
        .send(problem(request, 400, 'MALFORMED_JSON', 'The request body is not valid JSON.'));
      return;
    }

    if (error.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
      void reply
        .code(415)
        .type('application/problem+json')
        .send(
          problem(
            request,
            415,
            'UNSUPPORTED_MEDIA_TYPE',
            'The request Content-Type is not supported.',
          ),
        );
      return;
    }

    request.log.error({ err: error }, 'unhandled request error');
    void reply
      .code(500)
      .type('application/problem+json')
      .send(problem(request, 500, 'INTERNAL_ERROR', 'An unexpected error occurred.'));
  });
}
