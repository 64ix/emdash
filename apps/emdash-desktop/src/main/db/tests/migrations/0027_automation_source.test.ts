/**
 * Migration 0027 (spec #130, ticket #138): `automations.source` — the
 * machine-local origin of an automation row ('local' for rows created on this
 * machine, 'imported' for rows that arrived via multi-machine sync).
 *
 * The column is a plain TEXT with a DEFAULT 'local' so existing rows read as
 * locally-created; the sync engine writes 'imported' explicitly on fresh
 * imports (importInsertColumns) and never transports the column.
 */
import { openFixture } from '@tooling/utils/db';
import { afterEach, describe, expect, it } from 'vitest';

describe('0027 automations.source', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  afterEach(() => {
    fixture?.close();
  });

  it('adds the source column with DEFAULT local', async () => {
    fixture = await openFixture('pre-0027');

    const cols = fixture.sqlite.prepare('PRAGMA table_info(automations)').all() as {
      name: string;
      dflt_value: string | null;
      notnull: number;
    }[];
    const source = cols.find((c) => c.name === 'source');
    expect(source).toBeDefined();
    expect(source?.dflt_value).toMatch(/local/i);
    expect(source?.notnull).toBe(1);
  });

  it('backfills existing automation rows as local', async () => {
    fixture = await openFixture('pre-0027');

    const [{ n }] = fixture.sqlite
      .prepare("SELECT COUNT(*) AS n FROM automations WHERE source = 'local'")
      .all() as unknown as [{ n: number }];
    const [{ total }] = fixture.sqlite
      .prepare('SELECT COUNT(*) AS total FROM automations')
      .all() as unknown as [{ total: number }];
    expect(n).toBe(total);
  });

  it('accepts the imported value and keeps the default for fresh rows', async () => {
    fixture = await openFixture('pre-0027');

    fixture.sqlite
      .prepare(
        `INSERT INTO automations (id, name, source, created_at, updated_at)
         VALUES ('auto-imported', 'Imported', 'imported', 0, 0)`
      )
      .run();
    fixture.sqlite
      .prepare(
        `INSERT INTO automations (id, name, created_at, updated_at)
         VALUES ('auto-fresh', 'Fresh', 0, 0)`
      )
      .run();

    const imported = fixture.sqlite
      .prepare('SELECT source FROM automations WHERE id = ?')
      .get('auto-imported') as { source: string };
    const fresh = fixture.sqlite
      .prepare('SELECT source FROM automations WHERE id = ?')
      .get('auto-fresh') as { source: string };
    expect(imported.source).toBe('imported');
    expect(fresh.source).toBe('local');
  });
});
