import process from 'node:process';
import { URL } from 'node:url';

const expectedConfirmation = 'speech-platform-integration-tests';
const databaseUrl = process.env.DATABASE_URL;

if (process.env.RUN_INFRA_TESTS !== '1') {
  throw new Error('RUN_INFRA_TESTS=1 is required for the PostgreSQL integration suite.');
}
if (databaseUrl === undefined || databaseUrl.length === 0) {
  throw new Error('DATABASE_URL is required for the PostgreSQL integration suite.');
}
if (process.env.CONFIRM_DATABASE_RESET !== expectedConfirmation) {
  throw new Error(
    `CONFIRM_DATABASE_RESET=${expectedConfirmation} is required for the PostgreSQL integration suite.`,
  );
}

let parsed;
try {
  parsed = new URL(databaseUrl);
} catch {
  throw new Error('The integration DATABASE_URL must be a valid PostgreSQL URL.');
}
const databaseName = decodeURIComponent(parsed.pathname.slice(1));
if (
  (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') ||
  !databaseName.endsWith('_test')
) {
  throw new Error('The integration DATABASE_URL database name must end in _test.');
}
