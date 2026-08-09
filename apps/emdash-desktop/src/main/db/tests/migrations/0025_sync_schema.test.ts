import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openFixture } from '@tooling/utils/db';
import { eq, count } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { initializeDatabase } from '@main/db/initialize';
import {
  automations,
  conversations,
  projectRemotes,
  projects,
  projectSettings,
  tasks,
  terminals,
} from '@main/db/schema';

const PROJECT_A_ID = '11111111-1111-1111-1111-111111111111';
const TASK_A1_ID = 'aaaa0001-0000-0000-0000-000000000000';
const CONV_A1_ID = 'cccc0001-0000-0000-0000-000000000000';

const fixturesDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  '../../../../../tooling/fixtures'
);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('0025 sync schema (nullable projects.path + sync_ts + triggers)', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  afterEach(() => {
    fixture?.close();
  });

  it('preserves every seeded project child through the projects rebuild', async () => {
    fixture = await openFixture('pre-0025');

    const [{ value: projectCount }] = await fixture.db.select({ value: count() }).from(projects);
    const [{ value: taskCount }] = await fixture.db.select({ value: count() }).from(tasks);
    const [{ value: conversationCount }] = await fixture.db
      .select({ value: count() })
      .from(conversations);
    const [{ value: settingsCount }] = await fixture.db
      .select({ value: count() })
      .from(projectSettings);
    const [{ value: remotesCount }] = await fixture.db.select({ value: count() }).from(projectRemotes);

    expect(projectCount).toBe(2);
    expect(taskCount).toBe(4);
    expect(conversationCount).toBe(2);
    expect(settingsCount).toBe(2);
    expect(remotesCount).toBe(2);
  });

  it('preserves transitive children (terminals, editor buffers, messages, automation runs)', async () => {
    // The baseline fixture has no terminals/editor_buffers/messages/automation
    // rows, and the cascade trap fires exactly when dropping `conversations`
    // (→ messages) and `automations` (→ automation_runs), so seed them into a
    // pre-migration copy and apply only the 0025 migration on top.
    const tmpPath = path.join(os.tmpdir(), `emdash-test-pre25-${crypto.randomUUID()}.db`);
    fs.copyFileSync(path.join(fixturesDir, 'pre-0025.db'), tmpPath);
    const sqlite = new Database(tmpPath);
    sqlite.pragma('journal_mode = WAL');
    sqlite.pragma('busy_timeout = 5000');
    try {
      sqlite.exec(`
        INSERT INTO terminals (id, project_id, task_id, ssh, name, shell_id, created_at, updated_at)
        VALUES ('term-1', '${PROJECT_A_ID}', '${TASK_A1_ID}', 0, 'main', 'system', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
        INSERT INTO editor_buffers (id, project_id, workspace_id, file_path, content, updated_at)
        VALUES ('buf-1', '${PROJECT_A_ID}', 'ws-1', '/repo/src/a.ts', 'const a = 1;', 1);
        INSERT INTO automations (id, name, project_id, enabled, created_at, updated_at)
        VALUES ('auto-1', 'Daily', '${PROJECT_A_ID}', 1, 0, 0);
        INSERT INTO automation_runs (id, automation_id, status, trigger_kind)
        VALUES ('run-1', 'auto-1', 'done', 'manual');
        INSERT INTO messages (id, conversation_id, content, sender, timestamp)
        VALUES ('msg-1', '${CONV_A1_ID}', 'hello', 'user', CURRENT_TIMESTAMP);
      `);

      await initializeDatabase(sqlite);

      const counts = (sqlite
        .prepare(
          `SELECT 'terminals' AS t, count(*) AS n FROM terminals
           UNION ALL SELECT 'editor_buffers', count(*) FROM editor_buffers
           UNION ALL SELECT 'messages', count(*) FROM messages
           UNION ALL SELECT 'automations', count(*) FROM automations
           UNION ALL SELECT 'automation_runs', count(*) FROM automation_runs`
        )
        .all() as { t: string; n: number }[]).map((r) => [r.t, r.n]);

      expect(counts).toEqual([
        ['terminals', 1],
        ['editor_buffers', 1],
        ['messages', 1],
        ['automations', 1],
        ['automation_runs', 1],
      ]);

      const fkViolations = sqlite.prepare('PRAGMA foreign_key_check').all();
      expect(fkViolations).toEqual([]);
    } finally {
      sqlite.close();
      for (const suffix of ['', '-wal', '-shm']) {
        fs.rmSync(`${tmpPath}${suffix}`, { force: true });
      }
    }
  });

  it('rewrites renamed-table FK references to the final table names', async () => {
    fixture = await openFixture('pre-0025');

    const fkTargets = (fixture.sqlite
      .prepare(
        `SELECT name, sql FROM sqlite_master
         WHERE type = 'table' AND name IN ('messages', 'automation_runs', 'conversations', 'tasks', 'automations')`
      )
      .all() as { name: string; sql: string }[]).map((r) => [r.name, r.sql]);

    const byName = Object.fromEntries(fkTargets);
    expect(byName.messages).toContain('REFERENCES "conversations"');
    expect(byName.automation_runs).toContain('REFERENCES "automations"');
    expect(byName.conversations).toContain('REFERENCES "projects"');
    expect(byName.conversations).toContain('REFERENCES "tasks"');
    expect(byName.automations).toContain('REFERENCES "projects"');
    expect(byName.automations).toContain('ON DELETE set null');
    expect(byName.tasks).toContain('REFERENCES `pull_requests`');
  });

  it('accepts NULL paths and keeps the unique index on path', async () => {
    fixture = await openFixture('pre-0025');

    // Insert a project with no local path (synced from another machine).
    await fixture.db.insert(projects).values({
      id: '33333333-3333-3333-3333-333333333333',
      name: 'remote-only',
      path: null,
    });

    // An existing project may lose its local path.
    await fixture.db
      .update(projects)
      .set({ path: null })
      .where(eq(projects.id, PROJECT_A_ID));

    const rows = await fixture.db.select().from(projects);
    const nullPaths = rows.filter((r) => r.path === null);
    expect(nullPaths).toHaveLength(2); // multiple NULLs in the unique index are legal

    // The unique index still rejects duplicate non-null paths.
    await expect(
      fixture.db.insert(projects).values({
        id: '44444444-4444-4444-4444-444444444444',
        name: 'dup-path',
        path: '/home/dev/projects/my-api',
      })
    ).rejects.toThrow(/UNIQUE constraint failed/i);
  });

  it('backs the sync clock into every pre-existing portable row', async () => {
    fixture = await openFixture('pre-0025');

    for (const table of [
      projects,
      projectRemotes,
      projectSettings,
      tasks,
      conversations,
      automations,
    ]) {
      const [{ value: stale }] = await fixture.db
        .select({ value: count() })
        .from(table)
        .where(eq(table.syncTs, 0));
      expect(stale).toBe(0);
    }
  });

  it('stamps sync_ts on insert and advances it on update via triggers', async () => {
    fixture = await openFixture('pre-0025');

    await fixture.db.insert(tasks).values({
      id: 'dddd0001-0000-0000-0000-000000000000',
      projectId: PROJECT_A_ID,
      name: 'sync clock test',
      status: 'todo',
    });
    const [afterInsert] = await fixture.db
      .select({ syncTs: tasks.syncTs })
      .from(tasks)
      .where(eq(tasks.id, 'dddd0001-0000-0000-0000-000000000000'));
    expect(afterInsert.syncTs).toBeGreaterThan(0);

    await sleep(5);
    await fixture.db
      .update(tasks)
      .set({ name: 'sync clock test (updated)' })
      .where(eq(tasks.id, 'dddd0001-0000-0000-0000-000000000000'));
    const [afterUpdate] = await fixture.db
      .select({ syncTs: tasks.syncTs })
      .from(tasks)
      .where(eq(tasks.id, 'dddd0001-0000-0000-0000-000000000000'));
    expect(afterUpdate.syncTs).toBeGreaterThan(afterInsert.syncTs);

    // Plain SELECTs must not touch the clock.
    await fixture.db.select().from(tasks).where(eq(tasks.id, 'dddd0001-0000-0000-0000-000000000000'));
    const [afterSelect] = await fixture.db
      .select({ syncTs: tasks.syncTs })
      .from(tasks)
      .where(eq(tasks.id, 'dddd0001-0000-0000-0000-000000000000'));
    expect(afterSelect.syncTs).toBe(afterUpdate.syncTs);
  });

  it('maintains sync_ts on composite-primary-key tables (project_remotes)', async () => {
    fixture = await openFixture('pre-0025');

    await fixture.db.insert(projectRemotes).values({
      projectId: PROJECT_A_ID,
      remoteName: 'upstream',
      remoteUrl: 'https://github.com/example/upstream.git',
    });
    const [row] = await fixture.db
      .select({ syncTs: projectRemotes.syncTs })
      .from(projectRemotes)
      .where(eq(projectRemotes.remoteName, 'upstream'));
    expect(row.syncTs).toBeGreaterThan(0);
  });

  it('creates the sync_ts triggers for exactly the portable tables', async () => {
    fixture = await openFixture('pre-0025');

    const triggers = (fixture.sqlite
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name`)
      .all() as { name: string }[]).map((r) => r.name);

    const expected = [
      'trg_automations_sync_ts_ins',
      'trg_automations_sync_ts_upd',
      'trg_conversations_sync_ts_ins',
      'trg_conversations_sync_ts_upd',
      'trg_project_remotes_sync_ts_ins',
      'trg_project_remotes_sync_ts_upd',
      'trg_project_settings_sync_ts_ins',
      'trg_project_settings_sync_ts_upd',
      'trg_projects_sync_ts_ins',
      'trg_projects_sync_ts_upd',
      'trg_tasks_sync_ts_ins',
      'trg_tasks_sync_ts_upd',
    ];
    expect(triggers).toEqual(expected);

    // sync_ts exists only on the six portable tables.
    const portable = ['projects', 'project_remotes', 'project_settings', 'tasks', 'conversations', 'automations'];
    const nonPortable = ['terminals', 'editor_buffers', 'messages', 'automation_runs', 'kv', 'app_settings'];
    for (const table of portable) {
      const cols = fixture.sqlite.prepare(`PRAGMA table_info(${table})`).all() as {
        name: string;
      }[];
      expect(cols.map((c) => c.name)).toContain('sync_ts');
    }
    for (const table of nonPortable) {
      const cols = fixture.sqlite.prepare(`PRAGMA table_info(${table})`).all() as {
        name: string;
      }[];
      expect(cols.map((c) => c.name)).not.toContain('sync_ts');
    }
  });

  it('keeps child FK enforcement intact after the rebuild (cascade still works)', async () => {
    fixture = await openFixture('pre-0025');

    // Deleting a project must still cascade to its children…
    await fixture.db.delete(projects).where(eq(projects.id, PROJECT_A_ID));
    const [{ value: orphanTasks }] = await fixture.db
      .select({ value: count() })
      .from(tasks)
      .where(eq(tasks.projectId, PROJECT_A_ID));
    expect(orphanTasks).toBe(0);

    // …and non-nullable child FKs still reject orphans.
    await expect(
      fixture.db.insert(terminals).values({
        id: 'term-orphan',
        projectId: 'does-not-exist',
        taskId: 'aaaa0001-0000-0000-0000-000000000000',
        name: 'x',
      })
    ).rejects.toThrow(/FOREIGN KEY/i);
  });
});
