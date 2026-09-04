export type ErrorDetails = Readonly<Record<string, unknown>>;

export class DomainError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: ErrorDetails,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export function badRequest(code: string, message: string, details?: ErrorDetails): DomainError {
  return new DomainError(400, code, message, details);
}

export function unauthorized(code: string, message: string): DomainError {
  return new DomainError(401, code, message);
}

export function forbidden(code: string, message: string): DomainError {
  return new DomainError(403, code, message);
}

export function notFound(code: string, message: string): DomainError {
  return new DomainError(404, code, message);
}

export function conflict(code: string, message: string, details?: ErrorDetails): DomainError {
  return new DomainError(409, code, message, details);
}

export function tooManyRequests(code: string, message: string, details?: ErrorDetails): DomainError {
  return new DomainError(429, code, message, details);
}
