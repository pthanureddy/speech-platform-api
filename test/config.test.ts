import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const VALID_TENANT = {
  id: 'tenant_acme',
  name: 'Acme',
  apiKey: 'acme_api_key_123',
  planId: 'business',
};

function tenantsJson(...tenants: unknown[]): string {
  return JSON.stringify(tenants);
}

function expectConfigError(env: NodeJS.ProcessEnv, message: string): void {
  expect(() => loadConfig(env)).toThrow(message);
}

function validProductionEnv(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://speech_user:secret@db.example.test:5432/speech',
    INTERNAL_TOKEN: 'i'.repeat(32),
    WEBHOOK_SECRET: 'w'.repeat(32),
    TENANTS_JSON: tenantsJson(VALID_TENANT),
  };
}

describe('loadConfig development configuration', () => {
  it('rejects an unknown NODE_ENV instead of bypassing production checks', () => {
    expectConfigError(
      { NODE_ENV: 'prod' },
      'NODE_ENV must be one of: development, test, production.',
    );
  });

  it('returns safe, deterministic development defaults', () => {
    const config = loadConfig({});

    expect(config).toEqual({
      nodeEnv: 'development',
      host: '0.0.0.0',
      port: 3000,
      logLevel: 'info',
      internalToken: 'dev_internal_token_change_me',
      webhookSecret: 'dev_webhook_secret_change_me',
      webhookToleranceSeconds: 300,
      tenantSeeds: [
        {
          id: 'tenant_demo',
          name: 'Demo tenant',
          apiKey: 'dev_demo_key_change_me',
          planId: 'starter',
        },
      ],
    });
    expect(config).not.toHaveProperty('databaseUrl');
  });

  it('loads explicit settings and multiple tenants from TENANTS_JSON', () => {
    const databaseUrl = 'postgres://app:password@localhost:5432/speech_test';
    const config = loadConfig({
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: '65535',
      LOG_LEVEL: 'debug',
      DATABASE_URL: databaseUrl,
      INTERNAL_TOKEN: 'test_internal_token',
      WEBHOOK_SECRET: 'test_webhook_secret',
      WEBHOOK_TOLERANCE_SECONDS: '1',
      TENANTS_JSON: tenantsJson(
        { ...VALID_TENANT, ignored: 'not copied' },
        {
          id: 'tenant_beta',
          name: 'Beta',
          apiKey: 'beta_api_key_456',
          planId: 'free',
        },
      ),
    });

    expect(config).toEqual({
      nodeEnv: 'test',
      host: '127.0.0.1',
      port: 65535,
      logLevel: 'debug',
      databaseUrl,
      internalToken: 'test_internal_token',
      webhookSecret: 'test_webhook_secret',
      webhookToleranceSeconds: 1,
      tenantSeeds: [
        VALID_TENANT,
        {
          id: 'tenant_beta',
          name: 'Beta',
          apiKey: 'beta_api_key_456',
          planId: 'free',
        },
      ],
    });
  });
});

describe('loadConfig tenant validation', () => {
  it('rejects malformed TENANTS_JSON', () => {
    expectConfigError(
      { TENANTS_JSON: '[{"id":' },
      'TENANTS_JSON must contain valid JSON.',
    );
  });

  it.each(['null', '{}', '"tenant"'])('rejects a non-array TENANTS_JSON value: %s', (value) => {
    expectConfigError({ TENANTS_JSON: value }, 'TENANTS_JSON must be a non-empty array.');
  });

  it('rejects an empty tenant array', () => {
    expectConfigError({ TENANTS_JSON: '[]' }, 'TENANTS_JSON must be a non-empty array.');
  });

  it.each([
    { label: 'a string', value: 'tenant' },
    { label: 'null', value: null },
  ])('rejects a tenant element that is $label', ({ value }) => {
    expectConfigError(
      { TENANTS_JSON: tenantsJson(value) },
      'TENANTS_JSON[0] must be an object.',
    );
  });

  it.each([
    { label: 'missing', id: undefined },
    { label: 'not a string', id: 123 },
    { label: 'too short', id: 'ab' },
    { label: 'starts unsafely', id: '-tenant' },
    { label: 'contains unsafe characters', id: 'tenant acme' },
    { label: 'too long', id: `t${'x'.repeat(64)}` },
  ])('rejects an id that is $label', ({ id }) => {
    expectConfigError(
      { TENANTS_JSON: tenantsJson({ ...VALID_TENANT, id }) },
      'TENANTS_JSON[0].id must be a safe 3-64 character identifier.',
    );
  });

  it.each([
    { label: 'missing', name: undefined },
    { label: 'not a string', name: 123 },
    { label: 'empty', name: '' },
    { label: 'only whitespace', name: '   ' },
    { label: 'too long', name: 'n'.repeat(101) },
  ])('rejects a name that is $label', ({ name }) => {
    expectConfigError(
      { TENANTS_JSON: tenantsJson({ ...VALID_TENANT, name }) },
      'TENANTS_JSON[0].name must contain 1-100 characters.',
    );
  });

  it.each([
    { label: 'missing', apiKey: undefined },
    { label: 'not a string', apiKey: 123 },
    { label: 'too short', apiKey: 'short' },
    { label: 'contains a space', apiKey: 'api key with spaces' },
    { label: 'contains non-ASCII characters', apiKey: 'api_key_with_å' },
    { label: 'too long', apiKey: 'k'.repeat(257) },
  ])('rejects an API key that is $label', ({ apiKey }) => {
    expectConfigError(
      { TENANTS_JSON: tenantsJson({ ...VALID_TENANT, apiKey }) },
      'TENANTS_JSON[0].apiKey must contain 12-256 visible ASCII characters.',
    );
  });

  it.each([
    { label: 'missing', planId: undefined },
    { label: 'not a string', planId: 123 },
    { label: 'unknown', planId: 'enterprise' },
  ])('rejects a plan that is $label', ({ planId }) => {
    expectConfigError(
      { TENANTS_JSON: tenantsJson({ ...VALID_TENANT, planId }) },
      'TENANTS_JSON[0].planId must be one of: free, starter, business.',
    );
  });

  it('rejects duplicate tenant ids', () => {
    expectConfigError(
      {
        TENANTS_JSON: tenantsJson(
          VALID_TENANT,
          { ...VALID_TENANT, name: 'Other name', apiKey: 'other_api_key_456' },
        ),
      },
      'TENANTS_JSON must not contain duplicate tenant ids or API keys.',
    );
  });

  it('rejects duplicate tenant API keys', () => {
    expectConfigError(
      {
        TENANTS_JSON: tenantsJson(
          VALID_TENANT,
          { ...VALID_TENANT, id: 'tenant_other', name: 'Other name' },
        ),
      },
      'TENANTS_JSON must not contain duplicate tenant ids or API keys.',
    );
  });

  it.each([
    {
      label: 'id',
      override: { DEMO_TENANT_ID: 'x' },
      message: 'Demo tenant configuration.id must be a safe 3-64 character identifier.',
    },
    {
      label: 'name',
      override: { DEMO_TENANT_NAME: '   ' },
      message: 'Demo tenant configuration.name must contain 1-100 characters.',
    },
    {
      label: 'API key',
      override: { DEMO_API_KEY: 'short' },
      message: 'Demo tenant configuration.apiKey must contain 12-256 visible ASCII characters.',
    },
    {
      label: 'plan',
      override: { DEMO_PLAN: 'enterprise' },
      message: 'Demo tenant configuration.planId must be one of: free, starter, business.',
    },
  ])('validates the default tenant $label', ({ override, message }) => {
    expectConfigError(override, message);
  });
});

describe('loadConfig numeric validation', () => {
  it.each([
    { label: 'zero', value: '0' },
    { label: 'a non-integer', value: '1.5' },
    { label: 'larger than 65535', value: '65536' },
  ])('rejects a PORT that is $label', ({ value }) => {
    expectConfigError({ PORT: value }, 'PORT must be an integer between 1 and 65535.');
  });

  it('applies the same bounds to WEBHOOK_TOLERANCE_SECONDS', () => {
    expectConfigError(
      { WEBHOOK_TOLERANCE_SECONDS: 'not-a-number' },
      'WEBHOOK_TOLERANCE_SECONDS must be an integer between 1 and 65535.',
    );
  });
});

describe('loadConfig database URL validation', () => {
  it.each([
    {
      label: 'malformed',
      value: 'not a URL',
      message: 'DATABASE_URL must be a valid PostgreSQL connection URL.',
    },
    {
      label: 'using the wrong scheme',
      value: 'mysql://speech_user@localhost/speech',
      message: 'DATABASE_URL must include a PostgreSQL scheme, user, and database name.',
    },
    {
      label: 'missing a user',
      value: 'postgres://localhost/speech',
      message: 'DATABASE_URL must include a PostgreSQL scheme, user, and database name.',
    },
    {
      label: 'missing a database name',
      value: 'postgres://speech_user@localhost/',
      message: 'DATABASE_URL must include a PostgreSQL scheme, user, and database name.',
    },
  ])('rejects a database URL that is $label', ({ value, message }) => {
    expectConfigError({ DATABASE_URL: value }, message);
  });
});

describe('loadConfig production validation', () => {
  it('rejects the default development internal token', () => {
    const env = validProductionEnv();
    delete env.INTERNAL_TOKEN;

    expectConfigError(env, 'Development secrets are not allowed when NODE_ENV=production.');
  });

  it('rejects the default development webhook secret', () => {
    const env = validProductionEnv();
    delete env.WEBHOOK_SECRET;

    expectConfigError(env, 'Development secrets are not allowed when NODE_ENV=production.');
  });

  it.each([
    {
      label: 'a short internal token',
      key: 'INTERNAL_TOKEN' as const,
      value: 'too-short',
      name: 'INTERNAL_TOKEN',
    },
    {
      label: 'whitespace in the internal token',
      key: 'INTERNAL_TOKEN' as const,
      value: `${'i'.repeat(16)} ${'i'.repeat(16)}`,
      name: 'INTERNAL_TOKEN',
    },
    {
      label: 'an overlong internal token',
      key: 'INTERNAL_TOKEN' as const,
      value: 'i'.repeat(513),
      name: 'INTERNAL_TOKEN',
    },
    {
      label: 'a short webhook secret',
      key: 'WEBHOOK_SECRET' as const,
      value: 'too-short',
      name: 'WEBHOOK_SECRET',
    },
    {
      label: 'whitespace in the webhook secret',
      key: 'WEBHOOK_SECRET' as const,
      value: `${'w'.repeat(16)}\n${'w'.repeat(16)}`,
      name: 'WEBHOOK_SECRET',
    },
  ])('rejects $label', ({ key, value, name }) => {
    const env = validProductionEnv();
    env[key] = value;

    expectConfigError(
      env,
      `${name} must contain 32-512 non-whitespace characters in production.`,
    );
  });

  it('requires a database URL', () => {
    const env = validProductionEnv();
    delete env.DATABASE_URL;

    expectConfigError(env, 'DATABASE_URL is required when NODE_ENV=production.');
  });

  it('rejects the development API key', () => {
    const env = validProductionEnv();
    delete env.TENANTS_JSON;

    expectConfigError(
      env,
      'The development API key is not allowed when NODE_ENV=production.',
    );
  });

  it('accepts an explicit, fully valid production configuration', () => {
    const env = validProductionEnv();
    delete env.TENANTS_JSON;
    env.HOST = '::';
    env.PORT = '8443';
    env.LOG_LEVEL = 'warn';
    env.WEBHOOK_TOLERANCE_SECONDS = '600';
    env.DEMO_TENANT_ID = 'tenant_production';
    env.DEMO_TENANT_NAME = 'Production tenant';
    env.DEMO_API_KEY = 'production_api_key_123';
    env.DEMO_PLAN = 'business';

    expect(loadConfig(env)).toEqual({
      nodeEnv: 'production',
      host: '::',
      port: 8443,
      logLevel: 'warn',
      databaseUrl: env.DATABASE_URL,
      internalToken: env.INTERNAL_TOKEN,
      webhookSecret: env.WEBHOOK_SECRET,
      webhookToleranceSeconds: 600,
      tenantSeeds: [
        {
          id: 'tenant_production',
          name: 'Production tenant',
          apiKey: 'production_api_key_123',
          planId: 'business',
        },
      ],
    });
  });
});
