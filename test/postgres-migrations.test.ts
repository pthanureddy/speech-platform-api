import { describe, expect, it } from 'vitest';
import { orderPostgresMigrationFiles } from '../src/infrastructure/postgres-migrations.js';

describe('PostgreSQL migration ordering', () => {
  it('orders by numeric version and ignores unrelated files', () => {
    expect(
      orderPostgresMigrationFiles([
        'README.md',
        '10_add_later.sql',
        '002_add_second.sql',
        '1_create_base.sql',
      ]),
    ).toEqual(['1_create_base.sql', '002_add_second.sql', '10_add_later.sql']);
  });

  it('rejects duplicate numeric versions even when zero padding differs', () => {
    expect(() => orderPostgresMigrationFiles(['001_first.sql', '1_duplicate.sql'])).toThrow(
      "PostgreSQL migrations '001_first.sql' and '1_duplicate.sql' use the same numeric version.",
    );
  });
});
