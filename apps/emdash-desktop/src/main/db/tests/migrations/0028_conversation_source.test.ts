/**
 * Migration 0028 (spec #130, ticket #137): `conversations.source` — the
 * machine-local origin of a conversation row ('local' for rows created on this
 * machine, 'imported' for rows that arrived via multi-machine sync).
 *
 * The column is a plain TEXT with a DEFAULT 'local' so existing rows read as
 * locally-created; the sync engine writes 'imported' explicitly on fresh
 * imports (importInsertColumns) and never transports the column — like
 * `session_id`, each machine keeps its own origin.
 */
import { openFixture } from '@tooling/utils/db';
import { afterEach, describe, expect, it } from 'vitest';

describe('0028 conversations.source', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  afterEach(() => {
    fixture?.close();
  });

  it('adds the source column with DEFAULT local', async () => {
    fixture = await openFixture('pre-0028');

    const cols = fixture.sqlite.prepare('PRAGMA table_info(conversations)').all() as {
      name: string;
      dflt_value: string | null;
      notnull: number;
    }[];
    const source = cols.find((c) => c.name === 'source');
    expect(source).toBeDefined();
    expect(source?.dflt_value).toMatch(/local/i);
    expect(source?.notnull).toBe(1);
  });

  it('backfills existing conversation rows as local', async () => {
    fixture = await openFixture('pre-0028');

    const [{ n }] = fixture.sqlite
      .prepare("SELECT COUNT(*) AS n FROM conversations WHERE source = 'local'")
      .all() as unknown as [{ n: number }];
    const [{ total }] = fixture.sqlite
      .prepare('SELECT COUNT(*) AS total FROM conversations')
      .all() as unknown as [{ total: number }];
    expect(n).toBe(total);
  });

  it('accepts the imported value and keeps the default for fresh rows', async () => {
    fixture = await openFixture('pre-0028');

    // The baseline fixture's seeded project/task (FK parents).
    const projectId = '11111111-1111-1111-1111-111111111111';
    const taskId = 'aaaa0001-0000-0000-0000-000000000000';

    fixture.sqlite
      .prepare(
        `INSERT INTO conversations (id, project_id, task_id, title, source, created_at, updated_at)
         VALUES ('conv-imported', ?, ?, 'Imported', 'imported', 0, 0)`
      )
      .run(projectId, taskId);
    fixture.sqlite
      .prepare(
        `INSERT INTO conversations (id, project_id, task_id, title, created_at, updated_at)
         VALUES ('conv-fresh', ?, ?, 'Fresh', 0, 0)`
      )
      .run(projectId, taskId);

    const imported = fixture.sqlite
      .prepare('SELECT source FROM conversations WHERE id = ?')
      .get('conv-imported') as { source: string };
    const fresh = fixture.sqlite
      .prepare('SELECT source FROM conversations WHERE id = ?')
      .get('conv-fresh') as { source: string };
    expect(imported.source).toBe('imported');
    expect(fresh.source).toBe('local');
  });
});
