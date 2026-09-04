import { defineConfig } from 'vitest/config';

const runInfrastructureTests =
  process.env.RUN_INFRA_TESTS === '1' &&
  (process.env.DATABASE_URL?.length ?? 0) > 0 &&
  process.env.CONFIRM_DATABASE_RESET === 'speech-platform-integration-tests';

export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/server.ts',
        ...(runInfrastructureTests ? [] : ['src/infrastructure/postgres-*.ts']),
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        statements: 80,
        branches: 75,
      },
    },
    include: ['test/**/*.test.ts'],
    pool: 'forks',
    restoreMocks: true,
    testTimeout: 15_000,
  },
});
