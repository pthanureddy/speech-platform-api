import { PLAN_IDS } from './domain/types.js';
import type { PlanId, TenantSeed } from './domain/types.js';

export type NodeEnvironment = 'development' | 'test' | 'production';

export interface AppConfig {
  nodeEnv: NodeEnvironment;
  host: string;
  port: number;
  logLevel: string;
  databaseUrl?: string;
  internalToken: string;
  webhookSecret: string;
  webhookToleranceSeconds: number;
  tenantSeeds: TenantSeed[];
}

const DEVELOPMENT_INTERNAL_TOKEN = 'dev_internal_token_change_me';
const DEVELOPMENT_WEBHOOK_SECRET = 'dev_webhook_secret_change_me';
const TENANT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{2,63}$/;
const API_KEY = /^[\x21-\x7e]{12,256}$/;
const MINIMUM_PRODUCTION_SECRET_LENGTH = 32;

function readNodeEnvironment(value: string | undefined): NodeEnvironment {
  const nodeEnv = value ?? 'development';
  if (nodeEnv !== 'development' && nodeEnv !== 'test' && nodeEnv !== 'production') {
    throw new Error('NODE_ENV must be one of: development, test, production.');
  }
  return nodeEnv;
}

function readPositiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535.`);
  }
  return parsed;
}

function isPlanId(value: unknown): value is PlanId {
  return typeof value === 'string' && PLAN_IDS.some((planId) => planId === value);
}

function parseTenantSeed(value: unknown, label: string): TenantSeed {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`${label} must be an object.`);
  }
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.id !== 'string' || !TENANT_ID.test(candidate.id)) {
    throw new Error(`${label}.id must be a safe 3-64 character identifier.`);
  }
  if (
    typeof candidate.name !== 'string' ||
    candidate.name.trim().length === 0 ||
    candidate.name.length > 100
  ) {
    throw new Error(`${label}.name must contain 1-100 characters.`);
  }
  if (typeof candidate.apiKey !== 'string' || !API_KEY.test(candidate.apiKey)) {
    throw new Error(`${label}.apiKey must contain 12-256 visible ASCII characters.`);
  }
  if (!isPlanId(candidate.planId)) {
    throw new Error(`${label}.planId must be one of: ${PLAN_IDS.join(', ')}.`);
  }
  return {
    id: candidate.id,
    name: candidate.name,
    apiKey: candidate.apiKey,
    planId: candidate.planId,
  };
}

function parseTenantSeeds(raw: string): TenantSeed[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('TENANTS_JSON must contain valid JSON.');
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('TENANTS_JSON must be a non-empty array.');
  }

  const seeds = parsed.map((value, index) => parseTenantSeed(value, `TENANTS_JSON[${index}]`));
  const tenantIds = new Set<string>();
  const apiKeys = new Set<string>();
  for (const seed of seeds) {
    if (tenantIds.has(seed.id) || apiKeys.has(seed.apiKey)) {
      throw new Error('TENANTS_JSON must not contain duplicate tenant ids or API keys.');
    }
    tenantIds.add(seed.id);
    apiKeys.add(seed.apiKey);
  }
  return seeds;
}

function defaultTenant(env: NodeJS.ProcessEnv): TenantSeed {
  return parseTenantSeed(
    {
      id: env.DEMO_TENANT_ID ?? 'tenant_demo',
      name: env.DEMO_TENANT_NAME ?? 'Demo tenant',
      apiKey: env.DEMO_API_KEY ?? 'dev_demo_key_change_me',
      planId: env.DEMO_PLAN ?? 'starter',
    },
    'Demo tenant configuration',
  );
}

function readDatabaseUrl(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('DATABASE_URL must be a valid PostgreSQL connection URL.');
  }
  if (
    (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') ||
    parsed.username.length === 0 ||
    parsed.pathname.length <= 1
  ) {
    throw new Error('DATABASE_URL must include a PostgreSQL scheme, user, and database name.');
  }
  return value;
}

function validateProductionSecret(value: string, name: string): void {
  if (
    value.length < MINIMUM_PRODUCTION_SECRET_LENGTH ||
    value.length > 512 ||
    /\s/.test(value)
  ) {
    throw new Error(`${name} must contain 32-512 non-whitespace characters in production.`);
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = readNodeEnvironment(env.NODE_ENV);
  const internalToken = env.INTERNAL_TOKEN ?? DEVELOPMENT_INTERNAL_TOKEN;
  const webhookSecret = env.WEBHOOK_SECRET ?? DEVELOPMENT_WEBHOOK_SECRET;
  const databaseUrl = readDatabaseUrl(env.DATABASE_URL);
  const tenantSeeds =
    env.TENANTS_JSON === undefined ? [defaultTenant(env)] : parseTenantSeeds(env.TENANTS_JSON);

  if (nodeEnv === 'production') {
    if (internalToken === DEVELOPMENT_INTERNAL_TOKEN || webhookSecret === DEVELOPMENT_WEBHOOK_SECRET) {
      throw new Error('Development secrets are not allowed when NODE_ENV=production.');
    }
    if (tenantSeeds.some((tenant) => tenant.apiKey === 'dev_demo_key_change_me')) {
      throw new Error('The development API key is not allowed when NODE_ENV=production.');
    }
    validateProductionSecret(internalToken, 'INTERNAL_TOKEN');
    validateProductionSecret(webhookSecret, 'WEBHOOK_SECRET');
    if (databaseUrl === undefined) {
      throw new Error('DATABASE_URL is required when NODE_ENV=production.');
    }
  }

  return {
    nodeEnv,
    host: env.HOST ?? '0.0.0.0',
    port: readPositiveInteger(env.PORT, 3000, 'PORT'),
    logLevel: env.LOG_LEVEL ?? 'info',
    ...(databaseUrl === undefined ? {} : { databaseUrl }),
    internalToken,
    webhookSecret,
    webhookToleranceSeconds: readPositiveInteger(
      env.WEBHOOK_TOLERANCE_SECONDS,
      300,
      'WEBHOOK_TOLERANCE_SECONDS',
    ),
    tenantSeeds,
  };
}
