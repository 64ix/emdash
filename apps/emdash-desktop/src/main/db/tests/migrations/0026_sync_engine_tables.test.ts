/**
 * Migration 0026 (spec #130, ticket #133): sync engine side tables and the
 * remaining sync clocks.
 *
 * - app_settings and kv gain a sync_ts clock with AFTER INSERT/UPDATE
 *   triggers (the kv-style tables the engine's prompt-library and portable
 *   settings rows need for push detection), backfilled with the migration-time
 *   epoch.
 * - sync_row_state / sync_tombstones are created for the engine's LWW guard
 *   and pending-deletion tracking.
 * - AFTER DELETE triggers on every allowlisted table record tombstones;
 *   composite primary keys are encoded with json_array() so the relay-side pk
 *   matches the engine's JSON.stringify([...]) encoding.
 */
import { openFixture } from '@tooling/utils/db';
import { count, eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { appSettings, automations, conversations, kv, projects, tasks } from '@main/db/schema';

describe('0026 sync engine tables (kv clocks, row state, tombstones)', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  afterEach(() => {
    fixture?.close();
  });

  it('adds sync_ts to app_settings and kv and backfills existing rows', async () => {
    fixture = await openFixture('pre-0026');

    for (const table of ['app_settings', 'kv'] as const) {
      const cols = fixture.sqlite.prepare(`PRAGMA table_info(${table})`).all() as {
        name: string;
      }[];
      expect(cols.map((c) => c.name)).toContain('sync_ts');
    }

    const [{ value: staleSettings }] = await fixture.db
      .select({ value: count() })
      .from(appSettings)
      .where(eq(appSettings.syncTs, 0));
    const [{ value: staleKv }] = await fixture.db
      .select({ value: count() })
      .from(kv)
      .where(eq(kv.syncTs, 0));
    expect(staleSettings).toBe(0);
    expect(staleKv).toBe(0);
  });

  it('stamps sync_ts on insert/update of app_settings and kv via triggers', async () => {
    fixture = await openFixture('pre-0026');

    await fixture.db.insert(appSettings).values({ key: 'terminal', value: '{}' });
    const [inserted] = await fixture.db
      .select({ syncTs: appSettings.syncTs })
      .from(appSettings)
      .where(eq(appSettings.key, 'terminal'));
    expect(inserted.syncTs).toBeGreaterThan(0);

    await fixture.db.insert(kv).values({ key: 'prompt-library:prompts', value: '[]' });
    const [kvInserted] = await fixture.db
      .select({ syncTs: kv.syncTs })
      .from(kv)
      .where(eq(kv.key, 'prompt-library:prompts'));
    expect(kvInserted.syncTs).toBeGreaterThan(0);
  });

  it('stamps a same-millisecond re-create strictly after the recorded row clock', async () => {
    fixture = await openFixture('pre-0026');

    const projectId = '11111111-1111-1111-1111-111111111111';
    const taskId = 'eeee0001-0000-0000-0000-000000000000';
    fixture.sqlite
      .prepare(`INSERT INTO tasks (id, project_id, name, status) VALUES (?, ?, 'Fresh', 'todo')`)
      .run(taskId, projectId);
    const taskStamp = fixture.sqlite
      .prepare('SELECT sync_ts FROM tasks WHERE id = ?')
      .get(taskId) as { sync_ts: number };
    expect(taskStamp.sync_ts).toBeGreaterThan(0);

    // Mimic the engine's push-ack: the recorded clock equals the row's stamp.
    // A delete + re-create in the same millisecond must NOT reproduce that
    // recorded clock — the engine's "applied-untouched" guard would otherwise
    // never push the resurrected row.
    fixture.sqlite
      .prepare(
        `INSERT INTO sync_row_state (table_name, pk, server_version, dirty, row_sync_ts)
         VALUES ('tasks', ?, 7, 0, ?)`
      )
      .run(taskId, taskStamp.sync_ts);
    await fixture.sqlite.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
    fixture.sqlite
      .prepare(
        `INSERT INTO tasks (id, project_id, name, status) VALUES (?, ?, 'Re-created', 'todo')`
      )
      .run(taskId, projectId);

    const recreated = fixture.sqlite
      .prepare('SELECT sync_ts FROM tasks WHERE id = ?')
      .get(taskId) as { sync_ts: number };
    // Same-millisecond re-create: the stamp must land strictly after the
    // recorded clock (MAX(now, row_sync_ts + 1)), never equal to it.
    expect(recreated.sync_ts).toBeGreaterThan(taskStamp.sync_ts);
  });

  it('stamps new rows after the engine watermark so push detection always fires', async () => {
    fixture = await openFixture('pre-0026');

    // A watermark from a previous push cycle, newer than the current wall clock.
    fixture.sqlite
      .prepare(
        `INSERT INTO kv (key, value, updated_at) VALUES ('sync:lastPushed:tasks', '9999999999999', 0)`
      )
      .run();
    fixture.sqlite
      .prepare(
        `INSERT INTO tasks (id, project_id, name, status) VALUES ('eeee0001-0000-0000-0000-000000000000', '11111111-1111-1111-1111-111111111111', 'New', 'todo')`
      )
      .run();

    const stamp = fixture.sqlite
      .prepare("SELECT sync_ts FROM tasks WHERE id = 'eeee0001-0000-0000-0000-000000000000'")
      .get() as { sync_ts: number };
    expect(stamp.sync_ts).toBe(10000000000000);
  });

  it('creates sync_row_state and sync_tombstones', async () => {
    fixture = await openFixture('pre-0026');

    const tables = (
      fixture.sqlite.prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('sync_row_state', 'sync_tombstones')`
      ).all() as { name: string }[]
    ).map((r) => r.name);
    expect(tables.sort()).toEqual(['sync_row_state', 'sync_tombstones']);
  });

  it('records tombstones on delete, with json_array encoding for composite pks', async () => {
    fixture = await openFixture('pre-0026');

    const projectId = '11111111-1111-1111-1111-111111111111';
    const taskId = 'aaaa0001-0000-0000-0000-000000000000';

    await fixture.db.delete(tasks).where(eq(tasks.id, taskId));
    const taskTombstone = fixture.sqlite
      .prepare('SELECT * FROM sync_tombstones WHERE table_name = ? AND pk = ?')
      .get('tasks', taskId) as { table_name: string; pk: string; created_at: number } | undefined;
    expect(taskTombstone?.pk).toBe(taskId);
    expect(taskTombstone?.created_at).toBeGreaterThan(0);

    // Composite pk (project_remotes) uses the json_array() encoding.
    await fixture.db.insert(projects).values({ id: '33333333-3333-3333-3333-333333333333', name: 'x' });
    await fixture.sqlite
      .prepare('INSERT INTO project_remotes (project_id, remote_name, remote_url) VALUES (?, ?, ?)')
      .run('33333333-3333-3333-3333-333333333333', 'origin', 'https://example.com/r.git');
    await fixture.sqlite
      .prepare('DELETE FROM project_remotes WHERE project_id = ? AND remote_name = ?')
      .run('33333333-3333-3333-3333-333333333333', 'origin');
    const remoteTombstone = fixture.sqlite
      .prepare("SELECT pk FROM sync_tombstones WHERE table_name = 'project_remotes'")
      .get() as { pk: string } | undefined;
    expect(remoteTombstone?.pk).toBe('["33333333-3333-3333-3333-333333333333","origin"]');
  });

  it('records tombstones for kv and app_settings deletes', async () => {
    fixture = await openFixture('pre-0026');

    await fixture.db.insert(appSettings).values({ key: 'terminal', value: '{}' });
    await fixture.db.delete(appSettings).where(eq(appSettings.key, 'terminal'));
    const settingTombstone = fixture.sqlite
      .prepare("SELECT pk FROM sync_tombstones WHERE table_name = 'app_settings'")
      .get() as { pk: string } | undefined;
    expect(settingTombstone?.pk).toBe('terminal');

    await fixture.db.insert(kv).values({ key: 'prompt-library:prompts', value: '[]' });
    await fixture.db.delete(kv).where(eq(kv.key, 'prompt-library:prompts'));
    const kvTombstone = fixture.sqlite
      .prepare("SELECT pk FROM sync_tombstones WHERE table_name = 'kv:prompt-library'")
      .get() as { pk: string } | undefined;
    expect(kvTombstone?.pk).toBe('prompt-library:prompts');
  });

  it('keeps existing behaviour intact (sync clock triggers, cascades)', async () => {
    fixture = await openFixture('pre-0026');

    // 0025 clock triggers still work on the portable tables.
    await fixture.db.insert(automations).values({
      id: 'dddd0001-0000-0000-0000-000000000000',
      name: 'Daily',
      createdAt: 0,
      updatedAt: 0,
    });
    const [auto] = await fixture.db
      .select({ syncTs: automations.syncTs })
      .from(automations)
      .where(eq(automations.id, 'dddd0001-0000-0000-0000-000000000000'));
    expect(auto.syncTs).toBeGreaterThan(0);

    // Deleting a project cascades to children and records their tombstones.
    const projectId = '11111111-1111-1111-1111-111111111111';
    await fixture.db.delete(projects).where(eq(projects.id, projectId));
    const [{ value: orphanConversations }] = await fixture.db
      .select({ value: count() })
      .from(conversations)
      .where(eq(conversations.projectId, projectId));
    expect(orphanConversations).toBe(0);
    const cascadedTombstones = fixture.sqlite
      .prepare('SELECT table_name FROM sync_tombstones ORDER BY table_name')
      .all() as { table_name: string }[];
    expect(cascadedTombstones.map((r) => r.table_name)).toContain('tasks');
    expect(cascadedTombstones.map((r) => r.table_name)).toContain('conversations');
  });
});
