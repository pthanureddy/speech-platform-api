import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type postgres from 'postgres';
import { sha256 } from '../security.js';

const MIGRATION_FILE = /^(\d+)_[a-z0-9_]+\.sql$/;
const MIGRATION_LOCK = 'speech-platform-api:schema-migrations:v1';

interface MigrationRecord {
  name: string;
  checksum: string;
}

interface MigrationFile {
  name: string;
  version: bigint;
}

export function orderPostgresMigrationFiles(names: readonly string[]): string[] {
  const versions = new Map<bigint, string>();
  const files: MigrationFile[] = [];
  for (const name of names) {
    const match = MIGRATION_FILE.exec(name);
    const versionText = match?.[1];
    if (versionText === undefined) {
      continue;
    }
    const version = BigInt(versionText);
    const previous = versions.get(version);
    if (previous !== undefined) {
      throw new Error(
        `PostgreSQL migrations '${previous}' and '${name}' use the same numeric version.`,
      );
    }
    versions.set(version, name);
    files.push({ name, version });
  }
  files.sort((left, right) => (left.version < right.version ? -1 : 1));
  return files.map((file) => file.name);
}

function migrationsDirectory(): string {
  // Both src/infrastructure/*.ts and dist/infrastructure/*.js are two levels
  // below the project root. The runtime image copies migrations there.
  return fileURLToPath(new URL('../../migrations/', import.meta.url));
}

export async function runPostgresMigrations(sql: postgres.Sql): Promise<void> {
  const directory = migrationsDirectory();
  const names = orderPostgresMigrationFiles(await readdir(directory));

  if (names.length === 0) {
    throw new Error(`No PostgreSQL migrations were found in '${directory}'.`);
  }

  const migrations = await Promise.all(
    names.map(async (name) => {
      const body = await readFile(new URL(`../../migrations/${name}`, import.meta.url), 'utf8');
      return { name, body, checksum: sha256(body) };
    }),
  );

  await sql.begin(async (transaction) => {
    await transaction`
      SELECT pg_advisory_xact_lock(hashtextextended(${MIGRATION_LOCK}, 0))
    `;
    await transaction`
      CREATE TABLE IF NOT EXISTS platform_schema_migrations (
        name text PRIMARY KEY,
        checksum char(64) NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `;

    const applied = await transaction<MigrationRecord[]>`
      SELECT name, checksum
      FROM platform_schema_migrations
    `;
    const checksums = new Map(applied.map((record) => [record.name, record.checksum]));

    for (const migration of migrations) {
      const previousChecksum = checksums.get(migration.name);
      if (previousChecksum !== undefined) {
        if (previousChecksum !== migration.checksum) {
          throw new Error(
            `Applied migration '${migration.name}' does not match its checked-in checksum.`,
          );
        }
        continue;
      }

      await transaction.unsafe(migration.body);
      await transaction`
        INSERT INTO platform_schema_migrations (name, checksum)
        VALUES (${migration.name}, ${migration.checksum})
      `;
    }
  });
}
