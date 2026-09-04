export const problemSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'title', 'status', 'detail', 'instance', 'code', 'requestId'],
  properties: {
    type: { type: 'string' },
    title: { type: 'string' },
    status: { type: 'integer' },
    detail: { type: 'string' },
    instance: { type: 'string' },
    code: { type: 'string' },
    requestId: { type: 'string' },
    details: { type: 'object', additionalProperties: true },
  },
} as const;

export const errorResponses = {
  400: problemSchema,
  401: problemSchema,
  403: problemSchema,
  404: problemSchema,
  409: problemSchema,
  413: problemSchema,
  415: problemSchema,
  429: problemSchema,
  500: problemSchema,
} as const;

export const speechOutputSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['artifactUri', 'sha256', 'durationMs'],
  properties: {
    artifactUri: { type: 'string' },
    sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    durationMs: { type: 'integer', minimum: 0 },
  },
} as const;

export const speechFailureSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['code', 'message'],
  properties: {
    code: { type: 'string' },
    message: { type: 'string' },
  },
} as const;

export const speechJobSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'voice',
    'format',
    'characterCount',
    'status',
    'createdAt',
    'updatedAt',
  ],
  properties: {
    id: { type: 'string' },
    voice: { type: 'string' },
    format: { type: 'string', enum: ['mp3', 'wav'] },
    characterCount: { type: 'integer', minimum: 1 },
    status: {
      type: 'string',
      enum: ['queued', 'processing', 'completed', 'failed', 'cancelled'],
    },
    createdAt: { type: 'string', format: 'date-time' },
    updatedAt: { type: 'string', format: 'date-time' },
    output: speechOutputSchema,
    failure: speechFailureSchema,
  },
} as const;

export const jobIdParamsSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['jobId'],
  properties: {
    jobId: { type: 'string', minLength: 5, maxLength: 100 },
  },
} as const;

export const apiKeySecurity = [{ ApiKeyAuth: [] }] as const;

export const internalTokenSecurity = [{ InternalToken: [] }] as const;
