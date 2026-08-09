/**
 * SyncEngine integration tests (spec #130, ticket #133).
 *
 * Two engines share one in-process fake relay and keep real (temp) SQLite
 * databases consistent. The fake relay replicates the wire semantics of the
 * relay worker (apps/sync-relay): a per-space monotonic version counter,
 * last-write-wins by receipt order, stale pushes accepted without rejection,
 * and cursor-based pulls ordered by version. The app deliberately does NOT
 * depend on the relay package here: the relay's real `handle()` lives in
 * apps/sync-relay, which the validation gate does not build, so driving it
 * would couple these tests to a possibly stale dist build. The seam under
 * test is the RelayTransport interface; the fake implements exactly the
 * observable contract the relay documents.
 */
import { openFixture } from '@tooling/utils/db';
import type { FixtureDb } from '@tooling/utils/db';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import {
  appSettings,
  automations,
  conversations,
  kv,
  projectRemotes,
  projects,
  projectSettings,
  tasks,
} from '@main/db/schema';
import { encryptBody, keyIdOf, mintK0 } from './crypto';
import { EncryptingRelayTransport } from './encrypting-transport';
import { SyncEngine } from './engine';
import type {
  RelayTransport,
  SyncDeviceInfo,
  SyncJoinResult,
  SyncMutation,
  SyncPatch,
  SyncPushResult,
  SyncPullResult,
  SyncSpaceCreated,
} from './transport';

// ---------------------------------------------------------------------------
// In-process fake relay (wire semantics of apps/sync-relay)
// ---------------------------------------------------------------------------

interface RelayRow {
  version: number;
  client_version: number;
  body: string | null;
  deleted: boolean;
}

class FakeRelayTransport implements RelayTransport {
  private version = 0;
  private readonly rows = new Map<string, Map<string, RelayRow>>();
  readonly pushCalls: SyncMutation[][] = [];
  readonly pullCursors: number[] = [];

  getRow(table: string, pk: string): RelayRow | null {
    return this.rows.get(table)?.get(pk) ?? null;
  }

  allRows(): Array<{ table: string; pk: string; row: RelayRow }> {
    const result: Array<{ table: string; pk: string; row: RelayRow }> = [];
    for (const [table, pks] of this.rows) {
      for (const [pk, row] of pks) {
        result.push({ table, pk, row });
      }
    }
    return result;
  }

  /** Directly seed a row as if another (older) client had pushed it. */
  seedRow(table: string, pk: string, body: string | null, deleted = false): number {
    this.version += 1;
    const version = this.version;
    const tableRows = this.rows.get(table) ?? new Map<string, RelayRow>();
    tableRows.set(pk, { version, client_version: 0, body, deleted });
    this.rows.set(table, tableRows);
    return version;
  }

  get maxVersion(): number {
    return this.version;
  }

  async createSpace(_name?: string): Promise<SyncSpaceCreated> {
    return { space_id: 'space-1', device_id: 'device-1', device_token: 'token', secret: 'secret' };
  }

  async join(_joinHash: string, _spaceId: string, _name?: string): Promise<SyncJoinResult> {
    return { device_id: 'device-2', device_token: 'token-2', space_id: 'space-1' };
  }

  async mintJoinSecret(_joinHash: string): Promise<{ join_hash: string }> {
    return { join_hash: 'x'.repeat(64) };
  }

  async listDevices(): Promise<{ devices: SyncDeviceInfo[] }> {
    return { devices: [] };
  }

  async revokeDevice(deviceId: string): Promise<{ device_id: string; revoked: boolean }> {
    return { device_id: deviceId, revoked: true };
  }

  async push(mutations: SyncMutation[]): Promise<SyncPushResult> {
    this.pushCalls.push(mutations);
    const results: SyncPushResult['results'] = [];
    for (const mutation of mutations) {
      this.version += 1;
      const version = this.version;
      const tableRows = this.rows.get(mutation.table) ?? new Map<string, RelayRow>();
      tableRows.set(mutation.pk, {
        version,
        client_version: mutation.client_version,
        body: mutation.body ?? null,
        deleted: mutation.op === 'delete',
      });
      this.rows.set(mutation.table, tableRows);
      results.push({ table: mutation.table, pk: mutation.pk, version });
    }
    return { results };
  }

  async pull(cursor: number, limit = 1000): Promise<SyncPullResult> {
    this.pullCursors.push(cursor);
    const patches: SyncPatch[] = [];
    for (const [table, pks] of this.rows) {
      for (const [pk, row] of pks) {
        if (row.version <= cursor) continue;
        patches.push({
          space: 'space-1',
          table,
          pk,
          version: row.version,
          client_version: row.client_version,
          op: row.deleted ? 'delete' : 'upsert',
          deleted: row.deleted,
          body: row.body,
        });
      }
    }
    patches.sort((a, b) => a.version - b.version);
    const page = patches.slice(0, limit);
    const nextCursor = page.length > 0 ? page[page.length - 1]!.version : cursor;
    return { cursor: nextCursor, patches: page };
  }

  async poll(cursor: number, _timeoutMs?: number): Promise<SyncPullResult> {
    return this.pull(cursor);
  }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const PROJECT_A = '11111111-1111-1111-1111-111111111111';
const TASK_1 = 'aaaa0001-0000-0000-0000-000000000000';
const CONV_1 = 'cccc0001-0000-0000-0000-000000000000';
const AUTO_1 = 'dddd0001-0000-0000-0000-000000000000';

async function openDb(): Promise<FixtureDb> {
  return openFixture('empty');
}

function makeEngine(fixture: FixtureDb, relay: RelayTransport, deviceId = 'device-a'): SyncEngine {
  return new SyncEngine({ sqlite: fixture.sqlite, transport: relay, deviceId });
}

function expectOk(summary: { success: boolean }): void {
  expect(summary.success, `expected ok, got ${JSON.stringify(summary)}`).toBe(true);
}

function bodyColumns(
  relay: FakeRelayTransport,
  table: string,
  pk: string
): Record<string, unknown> | null {
  const row = relay.getRow(table, pk);
  if (row === null || row.body === null) return null;
  const parsed = JSON.parse(row.body) as { columns?: Record<string, unknown> };
  return parsed.columns ?? null;
}

function rawGet(
  fixture: FixtureDb,
  sql: string,
  ...params: unknown[]
): Record<string, unknown> | undefined {
  return fixture.sqlite.prepare(sql).get(...params) as Record<string, unknown> | undefined;
}

async function seedProject(
  fixture: FixtureDb,
  id: string,
  overrides: Record<string, unknown> = {}
): Promise<void> {
  await fixture.db.insert(projects).values({
    id,
    name: 'Repo',
    ...overrides,
  });
}

async function seedTask(
  fixture: FixtureDb,
  id: string,
  projectId: string,
  overrides: Record<string, unknown> = {}
): Promise<void> {
  await fixture.db.insert(tasks).values({
    id,
    projectId,
    name: 'Fix bug',
    status: 'todo',
    ...overrides,
  });
}

async function seedConversation(
  fixture: FixtureDb,
  id: string,
  projectId: string,
  taskId: string,
  overrides: Record<string, unknown> = {}
): Promise<void> {
  await fixture.db.insert(conversations).values({
    id,
    projectId,
    taskId,
    title: 'Conversation',
    ...overrides,
  });
}

describe('SyncEngine', () => {
  let fixtureA: FixtureDb;
  let fixtureB: FixtureDb;
  let fixtureC: FixtureDb;

  afterEach(() => {
    fixtureA?.close();
    fixtureB?.close();
    fixtureC?.close();
  });

  describe('push/pull of the allowlisted tables', () => {
    it('pushes and pulls every allowlisted table through the fake relay', async () => {
      fixtureA = await openDb();
      fixtureB = await openDb();
      const relay = new FakeRelayTransport();
      const engineA = makeEngine(fixtureA, relay, 'device-a');

      await seedProject(fixtureA, PROJECT_A);
      await fixtureA.db.insert(projectSettings).values({
        projectId: PROJECT_A,
        baseProjectSettingsJson: JSON.stringify({ defaultBranch: 'main' }),
        shareableProjectSettingsJson: JSON.stringify({ preservePatterns: ['.env'] }),
      });
      await fixtureA.db.insert(projectRemotes).values({
        projectId: PROJECT_A,
        remoteName: 'origin',
        remoteUrl: 'https://github.com/example/repo.git',
      });
      await seedTask(fixtureA, TASK_1, PROJECT_A, { status: 'in-progress' });
      await seedConversation(fixtureA, CONV_1, PROJECT_A, TASK_1, {
        title: 'First conv',
        provider: 'claude',
        type: 'acp',
      });
      await fixtureA.db.insert(automations).values({
        id: AUTO_1,
        name: 'Daily',
        projectId: PROJECT_A,
        createdAt: 0,
        updatedAt: 0,
      });
      await fixtureA.db.insert(kv).values({
        key: 'prompt-library:prompts',
        value: JSON.stringify([{ id: 'review-prompt', title: 'Review', prompt: 'Check' }]),
      });
      await fixtureA.db.insert(appSettings).values({
        key: 'interface',
        value: JSON.stringify({ taskHoverAction: 'delete' }),
      });

      const result = await engineA.syncNow();
      expectOk(result);

      // Relay holds every allowlisted table.
      const relayTables = new Set(relay.allRows().map((r) => r.table));
      expect(relayTables).toEqual(
        new Set([
          'projects',
          'project_remotes',
          'project_settings',
          'tasks',
          'conversations',
          'automations',
          'kv:prompt-library',
          'app_settings',
        ])
      );

      // A second engine pulls everything and reconstructs the same rows.
      const engineB = makeEngine(fixtureB, relay, 'device-b');
      const pullResult = await engineB.syncNow();
      expectOk(pullResult);

      const project = rawGet(fixtureB, 'SELECT * FROM projects WHERE id = ?', PROJECT_A);
      expect(project?.name).toBe('Repo');
      const settings = rawGet(
        fixtureB,
        'SELECT * FROM project_settings WHERE project_id = ?',
        PROJECT_A
      );
      expect(JSON.parse(settings?.base_project_settings_json as string)).toEqual({
        defaultBranch: 'main',
      });
      const remote = rawGet(
        fixtureB,
        'SELECT * FROM project_remotes WHERE project_id = ? AND remote_name = ?',
        PROJECT_A,
        'origin'
      );
      expect(remote?.remote_url).toBe('https://github.com/example/repo.git');
      const task = rawGet(fixtureB, 'SELECT * FROM tasks WHERE id = ?', TASK_1);
      expect(task?.status).toBe('in-progress');
      const conv = rawGet(fixtureB, 'SELECT * FROM conversations WHERE id = ?', CONV_1);
      expect(conv?.title).toBe('First conv');
      expect(conv?.provider).toBe('claude');
      expect(conv?.type).toBe('acp');
      const auto = rawGet(fixtureB, 'SELECT * FROM automations WHERE id = ?', AUTO_1);
      expect(auto?.name).toBe('Daily');
      const prompt = rawGet(fixtureB, "SELECT * FROM kv WHERE key = 'prompt-library:prompts'");
      expect(JSON.parse(prompt?.value as string)).toEqual([
        { id: 'review-prompt', title: 'Review', prompt: 'Check' },
      ]);
      const setting = rawGet(fixtureB, "SELECT * FROM app_settings WHERE key = 'interface'");
      expect(JSON.parse(setting?.value as string)).toEqual({ taskHoverAction: 'delete' });
    });

    it('excludes derived, dead and machine-specific columns from the payload', async () => {
      fixtureA = await openDb();
      const relay = new FakeRelayTransport();
      const engineA = makeEngine(fixtureA, relay, 'device-a');

      await seedProject(fixtureA, PROJECT_A, {
        path: '/local/repo',
        repositoryWorkspaceId: 'ws-a',
        workspaceProvider: 'local',
        baseRef: 'main',
      });
      await fixtureA.db.insert(projectSettings).values({
        projectId: PROJECT_A,
        baseProjectSettingsJson: JSON.stringify({
          worktreeDirectory: '/local/worktrees',
          workspaceProvider: { type: 'script', provisionCommand: 'x', terminateCommand: 'y' },
          defaultBranch: 'main',
        }),
        shareableProjectSettingsJson: JSON.stringify({ shellSetup: 'alias g=git' }),
      });
      await seedTask(fixtureA, TASK_1, PROJECT_A, {
        status: 'in-progress',
        boardRank: 'a0|h0000',
        workspaceProviderData: JSON.stringify({ type: 'local' }),
        workspaceIntent: JSON.stringify({ git: {}, workspace: {} }),
        isPinned: 1,
        type: 'task',
      });
      await seedConversation(fixtureA, CONV_1, PROJECT_A, TASK_1, {
        title: 'Conv',
        sessionId: 'sess-1',
        agentStatus: 'thinking',
        agentStatusSeen: 1,
        isInitialConversation: true,
      });
      await fixtureA.db.insert(automations).values({
        id: AUTO_1,
        name: 'Daily',
        projectId: PROJECT_A,
        enabled: 1,
        createdAt: 0,
        updatedAt: 0,
      });
      await fixtureA.db.insert(appSettings).values({
        key: 'terminal',
        value: JSON.stringify({ fontSize: 12, defaultShell: 'fish' }),
      });
      await fixtureA.db.insert(appSettings).values({
        key: 'notifications',
        value: JSON.stringify({ sound: true, customSoundPath: '/sounds/ding.wav' }),
      });
      await fixtureA.db.insert(appSettings).values({
        key: 'localProject',
        value: JSON.stringify({ defaultProjectsDirectory: '/local/projects' }),
      });
      await fixtureA.db.insert(appSettings).values({
        key: 'providerConfigs',
        value: JSON.stringify({ claude: { defaultModel: 'opus' } }),
      });

      expectOk(await engineA.syncNow());

      const taskColumns = bodyColumns(relay, 'tasks', TASK_1);
      expect(taskColumns).not.toHaveProperty('board_rank');
      expect(taskColumns).not.toHaveProperty('workspace_provider_data');
      expect(taskColumns).not.toHaveProperty('workspace_intent');
      expect(taskColumns?.is_pinned).toBe('1');
      expect(taskColumns?.type).toBe('task');

      const projectColumns = bodyColumns(relay, 'projects', PROJECT_A);
      expect(projectColumns).not.toHaveProperty('path');
      expect(projectColumns?.repository_workspace_id).toBe('ws-a');

      const convColumns = bodyColumns(relay, 'conversations', CONV_1);
      expect(convColumns).not.toHaveProperty('session_id');
      expect(convColumns).not.toHaveProperty('agent_status');
      expect(convColumns).not.toHaveProperty('agent_status_seen');
      expect(convColumns?.is_initial_conversation).toBe('1');

      const autoColumns = bodyColumns(relay, 'automations', AUTO_1);
      expect(autoColumns).not.toHaveProperty('enabled');

      const settingsColumns = bodyColumns(relay, 'project_settings', PROJECT_A);
      const base = JSON.parse(settingsColumns?.base_project_settings_json as string) as Record<
        string,
        unknown
      >;
      expect(base).not.toHaveProperty('worktreeDirectory');
      expect(base).not.toHaveProperty('workspaceProvider');
      expect(base.defaultBranch).toBe('main');

      // app_settings: machine-specific keys never reach the relay, and the
      // nested machine-specific fields are stripped from portable values.
      expect(relay.getRow('app_settings', 'localProject')).toBeNull();
      expect(relay.getRow('app_settings', 'providerConfigs')).toBeNull();
      const terminal = JSON.parse(
        bodyColumns(relay, 'app_settings', 'terminal')?.value as string
      ) as Record<string, unknown>;
      expect(terminal.fontSize).toBe(12);
      expect(terminal).not.toHaveProperty('defaultShell');
      const notifications = JSON.parse(
        bodyColumns(relay, 'app_settings', 'notifications')?.value as string
      ) as Record<string, unknown>;
      expect(notifications.sound).toBe(true);
      expect(notifications).not.toHaveProperty('customSoundPath');
    });

    it('transports versioned JSON columns as raw strings (future-version preserved)', async () => {
      fixtureA = await openDb();
      fixtureB = await openDb();
      const relay = new FakeRelayTransport();
      const engineA = makeEngine(fixtureA, relay, 'device-a');

      await seedProject(fixtureA, PROJECT_A);
      await seedTask(fixtureA, TASK_1, PROJECT_A);
      // A future-version blob (version "99") this build cannot parse: the
      // engine must carry it verbatim, never re-serialize it.
      const futureLinkedIssues = JSON.stringify({
        version: '99',
        origin: { provider: 'github', url: 'https://github.com/example/repo/issues/9' },
      });
      fixtureA.sqlite
        .prepare('UPDATE tasks SET linked_issue = ? WHERE id = ?')
        .run(futureLinkedIssues, TASK_1);
      const futureConversationConfig = JSON.stringify({ version: '99', tone: 'calm' });
      await seedConversation(fixtureA, CONV_1, PROJECT_A, TASK_1, { title: 'Conv' });
      fixtureA.sqlite
        .prepare('UPDATE conversations SET config = ? WHERE id = ?')
        .run(futureConversationConfig, CONV_1);
      const futureTriggerConfig = JSON.stringify({ version: '99', cron: '0 * * * *' });
      await fixtureA.db.insert(automations).values({
        id: AUTO_1,
        name: 'Daily',
        projectId: PROJECT_A,
        createdAt: 0,
        updatedAt: 0,
      });
      fixtureA.sqlite
        .prepare('UPDATE automations SET trigger_config = ? WHERE id = ?')
        .run(futureTriggerConfig, AUTO_1);

      expectOk(await engineA.syncNow());

      const taskColumns = bodyColumns(relay, 'tasks', TASK_1);
      expect(taskColumns?.linked_issue).toBe(futureLinkedIssues);
      const convColumns = bodyColumns(relay, 'conversations', CONV_1);
      expect(convColumns?.config).toBe(futureConversationConfig);
      const autoColumns = bodyColumns(relay, 'automations', AUTO_1);
      expect(autoColumns?.trigger_config).toBe(futureTriggerConfig);

      const engineB = makeEngine(fixtureB, relay, 'device-b');
      expectOk(await engineB.syncNow());

      const applied = rawGet(fixtureB, 'SELECT linked_issue FROM tasks WHERE id = ?', TASK_1);
      expect(applied?.linked_issue).toBe(futureLinkedIssues);
      const appliedConv = rawGet(fixtureB, 'SELECT config FROM conversations WHERE id = ?', CONV_1);
      expect(appliedConv?.config).toBe(futureConversationConfig);
      const appliedAuto = rawGet(
        fixtureB,
        'SELECT trigger_config FROM automations WHERE id = ?',
        AUTO_1
      );
      expect(appliedAuto?.trigger_config).toBe(futureTriggerConfig);

      // Reading through the ORM yields null (future-version degrades), but the
      // stored raw string is untouched — the round trip did not destroy it.
      const [ormRead] = await fixtureB.db
        .select({ linkedIssues: tasks.linkedIssues })
        .from(tasks)
        .where(eq(tasks.id, TASK_1));
      expect(ormRead.linkedIssues).toBeNull();
      expect(applied?.linked_issue).toBe(futureLinkedIssues);
    });
  });

  describe('LWW, tombstones and stale pushes', () => {
    it('applies last-write-wins by server version, never by client order', async () => {
      fixtureA = await openDb();
      fixtureB = await openDb();
      const relay = new FakeRelayTransport();
      const engineA = makeEngine(fixtureA, relay, 'device-a');
      const engineB = makeEngine(fixtureB, relay, 'device-b');

      await seedProject(fixtureA, PROJECT_A);
      await seedTask(fixtureA, TASK_1, PROJECT_A, { status: 'todo' });
      await seedProject(fixtureB, PROJECT_A);
      await seedTask(fixtureB, TASK_1, PROJECT_A, { status: 'todo' });

      // A edits first (older server version), B edits second (newer version).
      await fixtureA.db.update(tasks).set({ status: 'in-progress' }).where(eq(tasks.id, TASK_1));
      expectOk(await engineA.syncNow());
      await fixtureB.db.update(tasks).set({ status: 'done' }).where(eq(tasks.id, TASK_1));
      expectOk(await engineB.syncNow());
      expectOk(await engineA.syncNow());

      // Both machines converge to the server-authoritative (newest) content.
      expect(rawGet(fixtureA, 'SELECT status FROM tasks WHERE id = ?', TASK_1)?.status).toBe(
        'done'
      );
      expect(rawGet(fixtureB, 'SELECT status FROM tasks WHERE id = ?', TASK_1)?.status).toBe(
        'done'
      );

      // Now A edits again; it wins because its push is received after B's.
      await fixtureA.db.update(tasks).set({ status: 'blocked' }).where(eq(tasks.id, TASK_1));
      expectOk(await engineA.syncNow());
      expectOk(await engineB.syncNow());
      expect(rawGet(fixtureA, 'SELECT status FROM tasks WHERE id = ?', TASK_1)?.status).toBe(
        'blocked'
      );
      expect(rawGet(fixtureB, 'SELECT status FROM tasks WHERE id = ?', TASK_1)?.status).toBe(
        'blocked'
      );
    });

    it('propagates deletions as tombstones and resurrects on a newer upsert', async () => {
      fixtureA = await openDb();
      fixtureB = await openDb();
      const relay = new FakeRelayTransport();
      const engineA = makeEngine(fixtureA, relay, 'device-a');
      const engineB = makeEngine(fixtureB, relay, 'device-b');

      await seedProject(fixtureA, PROJECT_A);
      await seedTask(fixtureA, TASK_1, PROJECT_A);
      expectOk(await engineA.syncNow());
      expectOk(await engineB.syncNow());
      expect(rawGet(fixtureB, 'SELECT id FROM tasks WHERE id = ?', TASK_1)).toBeDefined();

      // A deletes the task; the tombstone propagates to B.
      await fixtureA.db.delete(tasks).where(eq(tasks.id, TASK_1));
      expectOk(await engineA.syncNow());
      expectOk(await engineB.syncNow());
      expect(rawGet(fixtureB, 'SELECT id FROM tasks WHERE id = ?', TASK_1)).toBeUndefined();
      expect(relay.getRow('tasks', TASK_1)?.deleted).toBe(true);

      // B re-creates the task: a newer upsert resurrects it on A.
      await seedTask(fixtureB, TASK_1, PROJECT_A, { name: 'Resurrected', status: 'todo' });
      expectOk(await engineB.syncNow());
      expectOk(await engineA.syncNow());
      expect(rawGet(fixtureA, 'SELECT name FROM tasks WHERE id = ?', TASK_1)?.name).toBe(
        'Resurrected'
      );
      expect(rawGet(fixtureB, 'SELECT name FROM tasks WHERE id = ?', TASK_1)?.name).toBe(
        'Resurrected'
      );
    });

    it('lets a dirty local edit beat a tombstone, then resurrects via push', async () => {
      fixtureA = await openDb();
      fixtureB = await openDb();
      const relay = new FakeRelayTransport();
      const engineA = makeEngine(fixtureA, relay, 'device-a');
      const engineB = makeEngine(fixtureB, relay, 'device-b');

      await seedProject(fixtureA, PROJECT_A);
      await seedTask(fixtureA, TASK_1, PROJECT_A);
      expectOk(await engineA.syncNow());
      expectOk(await engineB.syncNow());

      // B has an unpushed edit; A deletes the task and syncs the tombstone.
      await fixtureB.db.update(tasks).set({ status: 'in-progress' }).where(eq(tasks.id, TASK_1));
      await fixtureA.db.delete(tasks).where(eq(tasks.id, TASK_1));
      expectOk(await engineA.syncNow());

      // B pulls: the tombstone must not clobber the dirty local edit.
      const pull = await engineB.pull();
      expectOk(pull);
      expect(pull.data.skippedDirty).toBeGreaterThan(0);
      expect(rawGet(fixtureB, 'SELECT status FROM tasks WHERE id = ?', TASK_1)?.status).toBe(
        'in-progress'
      );

      // B pushes its edit: it wins at the relay and resurrects the row on A.
      expectOk(await engineB.syncNow());
      expectOk(await engineA.syncNow());
      expect(rawGet(fixtureA, 'SELECT status FROM tasks WHERE id = ?', TASK_1)?.status).toBe(
        'in-progress'
      );
      expect(rawGet(fixtureB, 'SELECT status FROM tasks WHERE id = ?', TASK_1)?.status).toBe(
        'in-progress'
      );
    });

    it('keeps local dirty rows on pull (strict push-then-pull ordering)', async () => {
      fixtureA = await openDb();
      fixtureB = await openDb();
      const relay = new FakeRelayTransport();
      const engineA = makeEngine(fixtureA, relay, 'device-a');
      const engineB = makeEngine(fixtureB, relay, 'device-b');

      await seedProject(fixtureA, PROJECT_A);
      await seedTask(fixtureA, TASK_1, PROJECT_A, { status: 'todo' });
      await seedProject(fixtureB, PROJECT_A);
      await seedTask(fixtureB, TASK_1, PROJECT_A, { status: 'todo' });

      // B edits locally (unpushed). A edits and syncs.
      await fixtureB.db.update(tasks).set({ status: 'in-progress' }).where(eq(tasks.id, TASK_1));
      await fixtureA.db.update(tasks).set({ status: 'done' }).where(eq(tasks.id, TASK_1));
      expectOk(await engineA.syncNow());

      // B syncs: its push is acknowledged BEFORE the pull, so the remote
      // patch for the same row is skipped (already seen at a newer version).
      const before = rawGet(fixtureB, 'SELECT status FROM tasks WHERE id = ?', TASK_1)?.status;
      expectOk(await engineB.syncNow());
      expect(rawGet(fixtureB, 'SELECT status FROM tasks WHERE id = ?', TASK_1)?.status).toBe(
        before
      );

      // Both converge to B's content (B's push was received after A's).
      expectOk(await engineA.syncNow());
      expect(rawGet(fixtureA, 'SELECT status FROM tasks WHERE id = ?', TASK_1)?.status).toBe(
        'in-progress'
      );
    });

    it('accepts a stale push without corrupting state or looping', async () => {
      fixtureA = await openDb();
      fixtureB = await openDb();
      const relay = new FakeRelayTransport();
      const engineA = makeEngine(fixtureA, relay, 'device-a');
      const engineB = makeEngine(fixtureB, relay, 'device-b');

      await seedProject(fixtureA, PROJECT_A);
      await seedTask(fixtureA, TASK_1, PROJECT_A, { status: 'todo' });
      expectOk(await engineA.syncNow());
      expectOk(await engineB.syncNow());

      // B's newer edit wins…
      await fixtureB.db.update(tasks).set({ status: 'done' }).where(eq(tasks.id, TASK_1));
      expectOk(await engineB.syncNow());
      expectOk(await engineA.syncNow());
      expect(rawGet(fixtureA, 'SELECT status FROM tasks WHERE id = ?', TASK_1)?.status).toBe(
        'done'
      );

      // …then a stale client re-pushes the old body. The relay never rejects
      // it: it stamps a new version and everyone converges to it. The engines
      // must stay consistent and must not enter a retry/echo loop.
      const staleBody = relay.getRow('tasks', TASK_1)?.body;
      const versionBefore = relay.getRow('tasks', TASK_1)?.version ?? 0;
      const stalePush = await relay.push([
        { table: 'tasks', pk: TASK_1, client_version: 1, body: staleBody ?? null, op: 'upsert' },
      ]);
      expect(stalePush.results[0]?.version).toBeGreaterThan(versionBefore);

      expectOk(await engineA.syncNow());
      expectOk(await engineB.syncNow());
      const staleContent = JSON.parse(staleBody ?? '{}') as { columns: Record<string, unknown> };
      expect(rawGet(fixtureA, 'SELECT status FROM tasks WHERE id = ?', TASK_1)?.status).toBe(
        staleContent.columns.status
      );
      expect(rawGet(fixtureB, 'SELECT status FROM tasks WHERE id = ?', TASK_1)?.status).toBe(
        staleContent.columns.status
      );

      // No echo: two more cycles and the server version stays put.
      const versionAfter = relay.getRow('tasks', TASK_1)?.version ?? 0;
      const pushCallsBefore = relay.pushCalls.length;
      expectOk(await engineA.syncNow());
      expectOk(await engineB.syncNow());
      expect(relay.getRow('tasks', TASK_1)?.version).toBe(versionAfter);
      expect(relay.pushCalls.length).toBe(pushCallsBefore);
    });
  });

  describe('dirty-row tracking and the trigger re-stamp loop', () => {
    it('never re-pushes an applied remote row (server version stays stable)', async () => {
      fixtureA = await openDb();
      fixtureB = await openDb();
      const relay = new FakeRelayTransport();
      const engineA = makeEngine(fixtureA, relay, 'device-a');
      const engineB = makeEngine(fixtureB, relay, 'device-b');

      await seedProject(fixtureA, PROJECT_A);
      await seedTask(fixtureA, TASK_1, PROJECT_A);
      expectOk(await engineA.syncNow());
      const versionAfterA = relay.getRow('tasks', TASK_1)?.version ?? 0;

      // B pulls and applies the row; then run several full cycles.
      const bPushesStart = relay.pushCalls.length;
      expectOk(await engineB.syncNow());
      const pushesBefore = relay.pushCalls.length;
      for (let i = 0; i < 4; i += 1) {
        expectOk(await engineB.syncNow());
      }
      // B never pushed anything (no local rows), and the applied row was not
      // echoed back — the server version is stable and no mutation for the
      // row was ever sent by B.
      expect(relay.getRow('tasks', TASK_1)?.version).toBe(versionAfterA);
      const bMutations = relay.pushCalls
        .slice(bPushesStart)
        .flat()
        .filter((m) => m.table === 'tasks');
      expect(bMutations).toHaveLength(0);
      expect(relay.pushCalls.length).toBe(pushesBefore);

      // The row is recorded as clean in B's side table.
      const state = rawGet(
        fixtureB,
        'SELECT * FROM sync_row_state WHERE table_name = ? AND pk = ?',
        'tasks',
        TASK_1
      );
      expect(state?.dirty).toBe(0);
      expect(state?.server_version).toBe(versionAfterA);
    });

    it('pushes genuine local edits to applied rows (clock differs from recorded)', async () => {
      fixtureA = await openDb();
      fixtureB = await openDb();
      const relay = new FakeRelayTransport();
      const engineA = makeEngine(fixtureA, relay, 'device-a');
      const engineB = makeEngine(fixtureB, relay, 'device-b');

      await seedProject(fixtureA, PROJECT_A);
      await seedTask(fixtureA, TASK_1, PROJECT_A, { status: 'todo' });
      expectOk(await engineA.syncNow());
      expectOk(await engineB.syncNow());

      // B edits the applied row: the trigger re-stamps the clock, so the row
      // becomes a push candidate again.
      await fixtureB.db.update(tasks).set({ status: 'in-progress' }).where(eq(tasks.id, TASK_1));
      const bPushesStart = relay.pushCalls.length;
      expectOk(await engineB.syncNow());
      const bMutations = relay.pushCalls
        .slice(bPushesStart)
        .flat()
        .filter((m) => m.table === 'tasks');
      expect(bMutations).toHaveLength(1);
      expect(
        (JSON.parse(bMutations[0]!.body ?? '{}') as { columns: Record<string, unknown> }).columns
          .status
      ).toBe('in-progress');

      expectOk(await engineA.syncNow());
      expect(rawGet(fixtureA, 'SELECT status FROM tasks WHERE id = ?', TASK_1)?.status).toBe(
        'in-progress'
      );

      // No echo afterwards: B's own push was acked and the row is clean.
      const version = relay.getRow('tasks', TASK_1)?.version ?? 0;
      expectOk(await engineB.syncNow());
      expectOk(await engineB.syncNow());
      expect(relay.getRow('tasks', TASK_1)?.version).toBe(version);
    });

    it('re-pulling from an old cursor skips already-seen patches (idempotent)', async () => {
      fixtureA = await openDb();
      fixtureB = await openDb();
      const relay = new FakeRelayTransport();
      const engineA = makeEngine(fixtureA, relay, 'device-a');
      const engineB = makeEngine(fixtureB, relay, 'device-b');

      await seedProject(fixtureA, PROJECT_A);
      await seedTask(fixtureA, TASK_1, PROJECT_A, { status: 'todo' });
      await seedConversation(fixtureA, CONV_1, PROJECT_A, TASK_1, { title: 'Conv' });
      expectOk(await engineA.syncNow());
      expectOk(await engineB.syncNow());

      const before = rawGet(fixtureB, 'SELECT * FROM tasks WHERE id = ?', TASK_1);
      // Rewind the cursor so every patch is re-fetched.
      fixtureB.sqlite.prepare("UPDATE kv SET value = '0' WHERE key = 'sync:cursor'").run();
      const pull = await engineB.pull();
      expectOk(pull);
      expect(pull.data.skippedSeen).toBeGreaterThan(0);
      expect(pull.data.applied).toBe(0);
      const after = rawGet(fixtureB, 'SELECT * FROM tasks WHERE id = ?', TASK_1);
      expect(after).toEqual(before);
    });
  });

  describe('initial-only project_remotes', () => {
    it('carries remotes once with the project, then never syncs them again', async () => {
      fixtureA = await openDb();
      fixtureB = await openDb();
      const relay = new FakeRelayTransport();
      const engineA = makeEngine(fixtureA, relay, 'device-a');
      const engineB = makeEngine(fixtureB, relay, 'device-b');

      await seedProject(fixtureA, PROJECT_A);
      await fixtureA.db.insert(projectRemotes).values({
        projectId: PROJECT_A,
        remoteName: 'origin',
        remoteUrl: 'https://github.com/example/repo.git',
      });
      await fixtureA.db.insert(projectRemotes).values({
        projectId: PROJECT_A,
        remoteName: 'upstream',
        remoteUrl: 'https://github.com/example/upstream.git',
      });

      expectOk(await engineA.syncNow());
      expect(relay.allRows().filter((r) => r.table === 'project_remotes')).toHaveLength(2);

      // B receives the carried remotes (the auto-attach hint).
      expectOk(await engineB.syncNow());
      expect(
        rawGet(
          fixtureB,
          'SELECT remote_url FROM project_remotes WHERE project_id = ? AND remote_name = ?',
          PROJECT_A,
          'origin'
        )?.remote_url
      ).toBe('https://github.com/example/repo.git');

      // A edits a remote, adds a third one, and runs several cycles: nothing
      // more is ever pushed for project_remotes.
      await fixtureA.db
        .update(projectRemotes)
        .set({ remoteUrl: 'https://github.com/example/repo-new.git' })
        .where(eq(projectRemotes.remoteName, 'origin'));
      await fixtureA.db.insert(projectRemotes).values({
        projectId: PROJECT_A,
        remoteName: 'fork',
        remoteUrl: 'https://github.com/example/fork.git',
      });
      for (let i = 0; i < 3; i += 1) {
        expectOk(await engineA.syncNow());
        expectOk(await engineB.syncNow());
      }

      const relayRemotes = relay.allRows().filter((r) => r.table === 'project_remotes');
      expect(relayRemotes).toHaveLength(2);
      const originBody = JSON.parse(
        relayRemotes.find((r) => r.pk === `["${PROJECT_A}","origin"]`)!.row.body ?? '{}'
      ) as { columns: Record<string, unknown> };
      expect(originBody.columns.remote_url).toBe('https://github.com/example/repo.git');

      // B's own remote edits are never pushed either.
      await fixtureB.db
        .update(projectRemotes)
        .set({ remoteUrl: 'https://github.com/example/b-local.git' })
        .where(eq(projectRemotes.remoteName, 'origin'));
      expectOk(await engineB.syncNow());
      expect(relay.allRows().filter((r) => r.table === 'project_remotes')).toHaveLength(2);
      expect(
        rawGet(
          fixtureB,
          'SELECT remote_url FROM project_remotes WHERE project_id = ? AND remote_name = ?',
          PROJECT_A,
          'origin'
        )?.remote_url
      ).toBe('https://github.com/example/b-local.git');
    });
  });

  describe('import transforms', () => {
    it('nulls repository_workspace_id on import and preserves the local path', async () => {
      fixtureA = await openDb();
      fixtureB = await openDb();
      const relay = new FakeRelayTransport();
      const engineA = makeEngine(fixtureA, relay, 'device-a');
      const engineB = makeEngine(fixtureB, relay, 'device-b');

      // The ssh_connections row the project references (out-of-scope table).
      fixtureA.sqlite
        .prepare('INSERT INTO ssh_connections (id, name, host, username) VALUES (?, ?, ?, ?)')
        .run('ssh-a', 'prod', 'example.com', 'alice');
      await seedProject(fixtureA, PROJECT_A, {
        path: '/local/a/repo',
        repositoryWorkspaceId: 'ws-a',
        sshConnectionId: 'ssh-a',
      });
      expectOk(await engineA.syncNow());

      // Fresh import: no path, no workspace/SSH reference — B regenerates its own.
      expectOk(await engineB.syncNow());
      const imported = rawGet(fixtureB, 'SELECT * FROM projects WHERE id = ?', PROJECT_A);
      expect(imported?.path).toBeNull();
      expect(imported?.repository_workspace_id).toBeNull();
      expect(imported?.ssh_connection_id).toBeNull();

      // B provisions locally and syncs its version of the row first…
      fixtureB.sqlite
        .prepare('INSERT INTO ssh_connections (id, name, host, username) VALUES (?, ?, ?, ?)')
        .run('ssh-b', 'prod', 'example.com', 'bob');
      fixtureB.sqlite
        .prepare(
          'UPDATE projects SET path = ?, repository_workspace_id = ?, ssh_connection_id = ? WHERE id = ?'
        )
        .run('/local/b/repo', 'ws-b', 'ssh-b', PROJECT_A);
      expectOk(await engineB.syncNow());

      // …then A renames the project; A's later push wins LWW, and each
      // machine keeps its own path and workspace/SSH references.
      await fixtureA.db
        .update(projects)
        .set({ name: 'Repo renamed' })
        .where(eq(projects.id, PROJECT_A));
      expectOk(await engineA.syncNow());
      expectOk(await engineB.syncNow());

      expect(rawGet(fixtureB, 'SELECT name FROM projects WHERE id = ?', PROJECT_A)?.name).toBe(
        'Repo renamed'
      );
      const bAfter = rawGet(fixtureB, 'SELECT * FROM projects WHERE id = ?', PROJECT_A);
      expect(bAfter?.path).toBe('/local/b/repo');
      expect(bAfter?.repository_workspace_id).toBe('ws-b');
      expect(bAfter?.ssh_connection_id).toBe('ssh-b');
      const aAfter = rawGet(fixtureA, 'SELECT * FROM projects WHERE id = ?', PROJECT_A);
      expect(aAfter?.path).toBe('/local/a/repo');
      expect(aAfter?.repository_workspace_id).toBe('ws-a');
      expect(aAfter?.ssh_connection_id).toBe('ssh-a');
    });

    it('nulls assigned_pr_url on import when the PR row is absent, preserves it when present', async () => {
      fixtureA = await openDb();
      fixtureB = await openDb();
      const relay = new FakeRelayTransport();
      const engineA = makeEngine(fixtureA, relay, 'device-a');
      const engineB = makeEngine(fixtureB, relay, 'device-b');

      await seedProject(fixtureA, PROJECT_A);
      // A has the referenced PR row (its own GitHub integration).
      fixtureA.sqlite
        .prepare(
          `INSERT INTO pull_requests (url, repository_url, base_ref_name, base_ref_oid, head_repository_url, head_ref_name, head_ref_oid, title)
           VALUES (?, 'https://github.com/example/repo', 'main', 'abc', 'https://github.com/example/repo', 'fix', 'def', 'PR 42')`
        )
        .run('https://github.com/example/repo/pull/42');
      await seedTask(fixtureA, TASK_1, PROJECT_A, {
        status: 'done',
        assignedPrUrl: 'https://github.com/example/repo/pull/42',
      });
      expectOk(await engineA.syncNow());

      // B has no pull_requests rows: the FK would abort the apply, so the
      // import nulls the assignment.
      expectOk(await engineB.syncNow());
      expect(
        rawGet(fixtureB, 'SELECT assigned_pr_url FROM tasks WHERE id = ?', TASK_1)?.assigned_pr_url
      ).toBeNull();

      // B does have the PR row: the assignment is preserved.
      fixtureB.sqlite
        .prepare(
          `INSERT INTO pull_requests (url, repository_url, base_ref_name, base_ref_oid, head_repository_url, head_ref_name, head_ref_oid, title)
           VALUES (?, 'https://github.com/example/repo', 'main', 'abc', 'https://github.com/example/repo', 'fix', 'def', 'PR 42')`
        )
        .run('https://github.com/example/repo/pull/42');
      fixtureB.sqlite.prepare('DELETE FROM tasks WHERE id = ?').run(TASK_1);
      fixtureB.sqlite
        .prepare('DELETE FROM sync_row_state WHERE table_name = ? AND pk = ?')
        .run('tasks', TASK_1);
      // Re-import by rewinding the cursor and pulling again.
      fixtureB.sqlite.prepare("UPDATE kv SET value = '0' WHERE key = 'sync:cursor'").run();
      expectOk(await engineB.pull());
      expect(
        rawGet(fixtureB, 'SELECT assigned_pr_url FROM tasks WHERE id = ?', TASK_1)?.assigned_pr_url
      ).toBe('https://github.com/example/repo/pull/42');
    });

    it('imports automations as disabled; enabled stays machine-local', async () => {
      fixtureA = await openDb();
      fixtureB = await openDb();
      const relay = new FakeRelayTransport();
      const engineA = makeEngine(fixtureA, relay, 'device-a');
      const engineB = makeEngine(fixtureB, relay, 'device-b');

      await seedProject(fixtureA, PROJECT_A);
      await fixtureA.db.insert(automations).values({
        id: AUTO_1,
        name: 'Daily',
        projectId: PROJECT_A,
        enabled: 1,
        createdAt: 0,
        updatedAt: 0,
      });
      expectOk(await engineA.syncNow());
      expectOk(await engineB.syncNow());

      // Fresh import defaults to disabled.
      expect(
        rawGet(fixtureB, 'SELECT enabled FROM automations WHERE id = ?', AUTO_1)?.enabled
      ).toBe(0);

      // B enables it locally; the payload still carries no `enabled` and A's
      // own value is untouched when B's row wins LWW.
      fixtureB.sqlite.prepare('UPDATE automations SET enabled = 1 WHERE id = ?').run(AUTO_1);
      expectOk(await engineB.syncNow());
      expect(bodyColumns(relay, 'automations', AUTO_1)).not.toHaveProperty('enabled');
      expectOk(await engineA.syncNow());
      expect(
        rawGet(fixtureA, 'SELECT enabled FROM automations WHERE id = ?', AUTO_1)?.enabled
      ).toBe(1);
      expect(
        rawGet(fixtureB, 'SELECT enabled FROM automations WHERE id = ?', AUTO_1)?.enabled
      ).toBe(1);
    });

    it('syncs portable app_settings and preserves machine-specific fields locally', async () => {
      fixtureA = await openDb();
      fixtureB = await openDb();
      const relay = new FakeRelayTransport();
      const engineA = makeEngine(fixtureA, relay, 'device-a');
      const engineB = makeEngine(fixtureB, relay, 'device-b');

      await fixtureA.db.insert(appSettings).values({
        key: 'terminal',
        value: JSON.stringify({ fontSize: 12, defaultShell: 'fish' }),
      });
      await fixtureA.db.insert(appSettings).values({
        key: 'interface',
        value: JSON.stringify({ taskHoverAction: 'delete' }),
      });

      expectOk(await engineA.syncNow());
      // B joins with no terminal row of its own: the portable fields land.
      expectOk(await engineB.syncNow());
      const bTerminalAfterImport = JSON.parse(
        rawGet(fixtureB, "SELECT value FROM app_settings WHERE key = 'terminal'")?.value as string
      ) as Record<string, unknown>;
      expect(bTerminalAfterImport.fontSize).toBe(12);
      const bInterface = JSON.parse(
        rawGet(fixtureB, "SELECT value FROM app_settings WHERE key = 'interface'")?.value as string
      ) as Record<string, unknown>;
      expect(bInterface.taskHoverAction).toBe('delete');

      // B sets its own shell; its push carries no defaultShell, and A's own
      // defaultShell survives the LWW round trip on both machines.
      await fixtureB.db
        .update(appSettings)
        .set({ value: JSON.stringify({ fontSize: 12, defaultShell: 'bash' }) })
        .where(eq(appSettings.key, 'terminal'));
      expectOk(await engineB.syncNow());
      expect(
        (bodyColumns(relay, 'app_settings', 'terminal') as Record<string, unknown>).value
      ).not.toContain('defaultShell');
      expectOk(await engineA.syncNow());

      const aTerminal = JSON.parse(
        rawGet(fixtureA, "SELECT value FROM app_settings WHERE key = 'terminal'")?.value as string
      ) as Record<string, unknown>;
      const bTerminal = JSON.parse(
        rawGet(fixtureB, "SELECT value FROM app_settings WHERE key = 'terminal'")?.value as string
      ) as Record<string, unknown>;
      expect(aTerminal.fontSize).toBe(12);
      expect(aTerminal.defaultShell).toBe('fish');
      expect(bTerminal.fontSize).toBe(12);
      expect(bTerminal.defaultShell).toBe('bash');

      // B's localProject stays machine-local in both directions.
      await fixtureB.db.insert(appSettings).values({
        key: 'localProject',
        value: JSON.stringify({ defaultProjectsDirectory: '/local/projects' }),
      });
      expectOk(await engineB.syncNow());
      expect(relay.getRow('app_settings', 'localProject')).toBeNull();
      expectOk(await engineA.syncNow());
      expect(
        rawGet(fixtureA, "SELECT value FROM app_settings WHERE key = 'localProject'")
      ).toBeUndefined();
    });

    it('syncs conversation metadata but never session/agent state', async () => {
      fixtureA = await openDb();
      fixtureB = await openDb();
      const relay = new FakeRelayTransport();
      const engineA = makeEngine(fixtureA, relay, 'device-a');
      const engineB = makeEngine(fixtureB, relay, 'device-b');

      await seedProject(fixtureA, PROJECT_A);
      await seedTask(fixtureA, TASK_1, PROJECT_A);
      await seedConversation(fixtureA, CONV_1, PROJECT_A, TASK_1, {
        title: 'Meta conv',
        provider: 'codex',
        type: 'acp',
        lastInteractedAt: '2026-08-09T10:00:00Z',
        isInitialConversation: true,
        sessionId: 'sess-1',
        agentStatus: 'thinking',
        agentStatusSeen: 1,
      });
      expectOk(await engineA.syncNow());
      expectOk(await engineB.syncNow());

      const imported = rawGet(fixtureB, 'SELECT * FROM conversations WHERE id = ?', CONV_1);
      expect(imported?.title).toBe('Meta conv');
      expect(imported?.provider).toBe('codex');
      expect(imported?.type).toBe('acp');
      expect(imported?.last_interacted_at).toBe('2026-08-09T10:00:00Z');
      expect(imported?.is_initial_conversation).toBe(1);
      // Machine-specific columns are never transported.
      expect(imported?.session_id).toBeNull();
      expect(imported?.agent_status).toBeNull();
      expect(imported?.agent_status_seen).toBe(1); // untouched local default
    });

    it('propagates app_settings reset-to-default as a tombstone', async () => {
      fixtureA = await openDb();
      fixtureB = await openDb();
      const relay = new FakeRelayTransport();
      const engineA = makeEngine(fixtureA, relay, 'device-a');
      const engineB = makeEngine(fixtureB, relay, 'device-b');

      await fixtureA.db.insert(appSettings).values({
        key: 'terminal',
        value: JSON.stringify({ fontSize: 12 }),
      });
      await fixtureA.db.insert(kv).values({
        key: 'prompt-library:prompts',
        value: JSON.stringify([{ id: 'p', title: 'P', prompt: 'x' }]),
      });
      expectOk(await engineA.syncNow());
      expectOk(await engineB.syncNow());
      expect(
        rawGet(fixtureB, "SELECT value FROM app_settings WHERE key = 'terminal'")
      ).toBeDefined();
      expect(
        rawGet(fixtureB, "SELECT value FROM kv WHERE key = 'prompt-library:prompts'")
      ).toBeDefined();

      // A resets the setting and clears the prompt library.
      await fixtureA.db.delete(appSettings).where(eq(appSettings.key, 'terminal'));
      await fixtureA.db.delete(kv).where(eq(kv.key, 'prompt-library:prompts'));
      expectOk(await engineA.syncNow());
      expectOk(await engineB.syncNow());

      expect(
        rawGet(fixtureB, "SELECT value FROM app_settings WHERE key = 'terminal'")
      ).toBeUndefined();
      expect(
        rawGet(fixtureB, "SELECT value FROM kv WHERE key = 'prompt-library:prompts'")
      ).toBeUndefined();
      expect(relay.getRow('app_settings', 'terminal')?.deleted).toBe(true);
      expect(relay.getRow('kv:prompt-library', 'prompt-library:prompts')?.deleted).toBe(true);
    });
  });

  describe('bookkeeping and robustness', () => {
    it('persists watermarks and cursor; an unchanged second sync is a no-op', async () => {
      fixtureA = await openDb();
      const relay = new FakeRelayTransport();
      const engineA = makeEngine(fixtureA, relay, 'device-a');

      await seedProject(fixtureA, PROJECT_A);
      await seedTask(fixtureA, TASK_1, PROJECT_A);
      expectOk(await engineA.syncNow());

      const lastPushed = rawGet(
        fixtureA,
        "SELECT value FROM kv WHERE key = 'sync:lastPushed:tasks'"
      );
      expect(JSON.parse(lastPushed?.value as string)).toBeGreaterThan(0);
      const cursor = rawGet(fixtureA, "SELECT value FROM kv WHERE key = 'sync:cursor'");
      expect(JSON.parse(cursor?.value as string)).toBeGreaterThan(0);
      // Bookkeeping keys are machine-local: never pushed.
      expect(relay.getRow('kv:prompt-library', 'sync:lastPushed:tasks')).toBeNull();

      const pushesBefore = relay.pushCalls.length;
      const second = await engineA.syncNow();
      expectOk(second);
      expect(second.data).toMatchObject({ pushed: 0, pulled: 0 });
      expect(relay.pushCalls.length).toBe(pushesBefore);
    });

    it('skips unknown tables and non-portable keys on pull', async () => {
      fixtureA = await openDb();
      fixtureB = await openDb();
      const relay = new FakeRelayTransport();
      const engineA = makeEngine(fixtureA, relay, 'device-a');
      const engineB = makeEngine(fixtureB, relay, 'device-b');

      await seedProject(fixtureA, PROJECT_A);
      expectOk(await engineA.syncNow());
      // Foreign rows from other/older clients: an out-of-scope table, a
      // non-portable kv key and a non-portable app_settings key.
      relay.seedRow('terminals', 'term-1', JSON.stringify({ columns: { id: 'term-1' } }));
      relay.seedRow('kv:prompt-library', 'kv:other', JSON.stringify({ columns: { value: 'x' } }));
      relay.seedRow('app_settings', 'localProject', JSON.stringify({ columns: { value: '{}' } }));

      const pull = await engineB.syncNow();
      expectOk(pull);
      expect(pull.data.skippedSeen).toBe(3);
      expect(rawGet(fixtureB, 'SELECT id FROM terminals WHERE id = ?', 'term-1')).toBeUndefined();
      expect(rawGet(fixtureB, "SELECT value FROM kv WHERE key = 'kv:other'")).toBeUndefined();
      expect(
        rawGet(fixtureB, "SELECT value FROM app_settings WHERE key = 'localProject'")
      ).toBeUndefined();
      // The cursor still advanced past them.
      expect(
        JSON.parse(
          rawGet(fixtureB, "SELECT value FROM kv WHERE key = 'sync:cursor'")?.value as string
        )
      ).toBe(relay.maxVersion);
    });

    it('skips orphaned child upserts (in-scope FK parent missing locally)', async () => {
      fixtureA = await openDb();
      fixtureB = await openDb();
      const relay = new FakeRelayTransport();
      const engineA = makeEngine(fixtureA, relay, 'device-a');
      const engineB = makeEngine(fixtureB, relay, 'device-b');

      await seedProject(fixtureA, PROJECT_A);
      await seedTask(fixtureA, TASK_1, PROJECT_A);
      expectOk(await engineA.syncNow());
      expectOk(await engineB.syncNow());

      // B deletes the project (cascade removes B's task); A edits the task
      // before the deletion reaches it. B syncs FIRST, so the relay holds B's
      // tombstones (lower versions) and A's task edit lands after them — the
      // task upsert arrives at B with no project row to attach to.
      await fixtureB.db.delete(projects).where(eq(projects.id, PROJECT_A));
      await fixtureA.db.update(tasks).set({ status: 'in-progress' }).where(eq(tasks.id, TASK_1));
      expectOk(await engineB.syncNow());
      expectOk(await engineA.syncNow());

      // B's pull must not abort on the orphaned task upsert: it records the
      // version and moves on, and the task's own tombstone (pushed by A after
      // its cascade) converges the row.
      const pull = await engineB.syncNow();
      expectOk(pull);
      expect(pull.data.skippedOrphan).toBeGreaterThan(0);
      expectOk(await engineA.syncNow());
      expectOk(await engineB.syncNow());
      expect(rawGet(fixtureB, 'SELECT id FROM projects WHERE id = ?', PROJECT_A)).toBeUndefined();
      expect(rawGet(fixtureB, 'SELECT id FROM tasks WHERE id = ?', TASK_1)).toBeUndefined();
      expect(rawGet(fixtureA, 'SELECT id FROM projects WHERE id = ?', PROJECT_A)).toBeUndefined();
      expect(rawGet(fixtureA, 'SELECT id FROM tasks WHERE id = ?', TASK_1)).toBeUndefined();
      expect(relay.getRow('tasks', TASK_1)?.deleted).toBe(true);
    });

    it('a machine joining after a project delete skips the carried remotes', async () => {
      fixtureA = await openDb();
      fixtureB = await openDb();
      fixtureC = await openDb();
      const relay = new FakeRelayTransport();
      const engineA = makeEngine(fixtureA, relay, 'device-a');
      const engineB = makeEngine(fixtureB, relay, 'device-b');

      await seedProject(fixtureA, PROJECT_A);
      await fixtureA.db.insert(projectRemotes).values({
        projectId: PROJECT_A,
        remoteName: 'origin',
        remoteUrl: 'https://github.com/example/repo.git',
      });
      expectOk(await engineA.syncNow());
      expectOk(await engineB.syncNow());

      // B deletes the project; the remotes stay on the relay forever
      // (initial-only rows are never tombstoned). A fresh machine C now has
      // remotes upserts with no project row to attach to.
      await fixtureB.db.delete(projects).where(eq(projects.id, PROJECT_A));
      expectOk(await engineB.syncNow());
      expect(relay.getRow('projects', PROJECT_A)?.deleted).toBe(true);
      expect(relay.allRows().filter((r) => r.table === 'project_remotes')).toHaveLength(1);

      const engineC = makeEngine(fixtureC, relay, 'device-c');
      expectOk(await engineC.syncNow());
      expect(rawGet(fixtureC, 'SELECT id FROM projects WHERE id = ?', PROJECT_A)).toBeUndefined();
      expect(
        rawGet(fixtureC, 'SELECT project_id FROM project_remotes WHERE project_id = ?', PROJECT_A)
      ).toBeUndefined();
      expectOk(await engineC.syncNow());
    });

    it('does not push tombstones for rows that still exist locally', async () => {
      fixtureA = await openDb();
      fixtureB = await openDb();
      const relay = new FakeRelayTransport();
      const engineA = makeEngine(fixtureA, relay, 'device-a');
      const engineB = makeEngine(fixtureB, relay, 'device-b');

      await seedProject(fixtureA, PROJECT_A);
      await seedTask(fixtureA, TASK_1, PROJECT_A);
      await fixtureA.db.insert(kv).values({
        key: 'prompt-library:prompts',
        value: JSON.stringify([{ id: 'p', title: 'P', prompt: 'x' }]),
      });
      expectOk(await engineA.syncNow());
      expectOk(await engineB.syncNow());

      // Delete and re-create the kv row before any sync: the pending
      // tombstone must be dropped in favour of the live upsert.
      await fixtureA.db.delete(kv).where(eq(kv.key, 'prompt-library:prompts'));
      await fixtureA.db.insert(kv).values({
        key: 'prompt-library:prompts',
        value: JSON.stringify([{ id: 'p', title: 'P', prompt: 'y' }]),
      });
      expectOk(await engineA.syncNow());
      const relayRow = relay.getRow('kv:prompt-library', 'prompt-library:prompts');
      expect(relayRow?.deleted).toBe(false);
      expect(
        (JSON.parse(relayRow?.body ?? '{}') as { columns: Record<string, unknown> }).columns.value
      ).toContain('"y"');
      expectOk(await engineB.syncNow());
      expect(
        JSON.parse(
          rawGet(fixtureB, "SELECT value FROM kv WHERE key = 'prompt-library:prompts'")
            ?.value as string
        )
      ).toEqual([{ id: 'p', title: 'P', prompt: 'y' }]);
    });
  });

  describe('two-engine convergence (the ticket integration test)', () => {
    it('converges statuses, settings, prompt library and conversation metadata', async () => {
      fixtureA = await openDb();
      fixtureB = await openDb();
      const relay = new FakeRelayTransport();
      const engineA = makeEngine(fixtureA, relay, 'device-a');
      const engineB = makeEngine(fixtureB, relay, 'device-b');

      // Machine A seeds its world: project, task, settings, prompts, conversation.
      await seedProject(fixtureA, PROJECT_A, { name: 'Converge Repo' });
      await seedTask(fixtureA, TASK_1, PROJECT_A, { name: 'Fix bug', status: 'todo' });
      await seedConversation(fixtureA, CONV_1, PROJECT_A, TASK_1, {
        title: 'Converge conv',
        provider: 'claude',
        type: 'acp',
      });
      await fixtureA.db.insert(projectSettings).values({
        projectId: PROJECT_A,
        baseProjectSettingsJson: JSON.stringify({ defaultBranch: 'main' }),
        shareableProjectSettingsJson: JSON.stringify({}),
      });
      await fixtureA.db.insert(appSettings).values({
        key: 'interface',
        value: JSON.stringify({ taskHoverAction: 'delete' }),
      });
      await fixtureA.db.insert(kv).values({
        key: 'prompt-library:prompts',
        value: JSON.stringify([
          { id: 'review-prompt', title: 'Review', prompt: 'Check it' },
          { id: 'a-only', title: 'A prompt', prompt: 'From A' },
        ]),
      });

      expectOk(await engineA.syncNow());

      // Machine B joins the space: pulls A's world.
      expectOk(await engineB.syncNow());
      expect(rawGet(fixtureB, 'SELECT name FROM projects WHERE id = ?', PROJECT_A)?.name).toBe(
        'Converge Repo'
      );
      expect(rawGet(fixtureB, 'SELECT status FROM tasks WHERE id = ?', TASK_1)?.status).toBe(
        'todo'
      );

      // B works on the task and tunes its own settings/prompts; A does the same.
      await fixtureB.db.update(tasks).set({ status: 'in-progress' }).where(eq(tasks.id, TASK_1));
      await fixtureB.db
        .update(conversations)
        .set({ title: 'Converge conv (edited on B)' })
        .where(eq(conversations.id, CONV_1));
      await fixtureB.db
        .update(appSettings)
        .set({ value: JSON.stringify({ taskHoverAction: 'archive' }) })
        .where(eq(appSettings.key, 'interface'));
      await fixtureB.db
        .update(kv)
        .set({
          value: JSON.stringify([
            { id: 'review-prompt', title: 'Review', prompt: 'Check it' },
            { id: 'b-only', title: 'B prompt', prompt: 'From B' },
          ]),
        })
        .where(eq(kv.key, 'prompt-library:prompts'));
      await fixtureA.db
        .update(tasks)
        .set({ name: 'Fix bug (renamed on A)' })
        .where(eq(tasks.id, TASK_1));

      // Alternating sync cycles converge everything.
      for (let i = 0; i < 3; i += 1) {
        expectOk(await engineA.syncNow());
        expectOk(await engineB.syncNow());
      }

      const readWorld = (fixture: FixtureDb) => ({
        project: rawGet(fixture, 'SELECT name FROM projects WHERE id = ?', PROJECT_A)?.name,
        taskName: rawGet(fixture, 'SELECT name FROM tasks WHERE id = ?', TASK_1)?.name,
        taskStatus: rawGet(fixture, 'SELECT status FROM tasks WHERE id = ?', TASK_1)?.status,
        convTitle: rawGet(fixture, 'SELECT title FROM conversations WHERE id = ?', CONV_1)?.title,
        interfaceSetting: JSON.parse(
          rawGet(fixture, "SELECT value FROM app_settings WHERE key = 'interface'")?.value as string
        ),
        prompts: JSON.parse(
          rawGet(fixture, "SELECT value FROM kv WHERE key = 'prompt-library:prompts'")
            ?.value as string
        ),
      });

      const worldA = readWorld(fixtureA);
      const worldB = readWorld(fixtureB);

      // B's later pushes win by server version; A's later pushes win where A
      // pushed after B (task name). Both machines must agree on everything.
      expect(worldA).toEqual(worldB);
      expect(worldA.taskStatus).toBe('in-progress');
      expect(worldA.convTitle).toBe('Converge conv (edited on B)');
      expect(worldA.interfaceSetting).toEqual({ taskHoverAction: 'archive' });
      expect(worldA.prompts).toHaveLength(2);

      // Converged machines stay converged: more cycles change nothing.
      const versionBefore = relay.maxVersion;
      for (let i = 0; i < 2; i += 1) {
        expectOk(await engineA.syncNow());
        expectOk(await engineB.syncNow());
      }
      expect(relay.maxVersion).toBe(versionBefore);
      expect(readWorld(fixtureA)).toEqual(worldB);
    });
  });

  describe('end-to-end encryption (ticket #134)', () => {
    // One space, one K0, two machines: the same key both machines derived
    // from the pairing secret.
    const k0 = mintK0();
    const keyId = keyIdOf(k0);
    const keyReader = { get: async () => ({ success: true as const, data: { keyId, k0 } }) };

    function encryptedEngine(
      fixture: FixtureDb,
      relay: RelayTransport,
      deviceId: string
    ): SyncEngine {
      return new SyncEngine({
        sqlite: fixture.sqlite,
        transport: new EncryptingRelayTransport(relay, keyReader),
        deviceId,
      });
    }

    it('pushes envelopes (no plaintext on the wire) and decrypts on pull', async () => {
      fixtureA = await openDb();
      fixtureB = await openDb();
      const relay = new FakeRelayTransport();
      const engineA = encryptedEngine(fixtureA, relay, 'device-a');
      const engineB = encryptedEngine(fixtureB, relay, 'device-b');

      await seedProject(fixtureA, PROJECT_A);
      expectOk(await engineA.syncNow());

      // The fake relay's stored body is a versioned envelope — the plaintext
      // JSON payload (device id, column names, values) never leaves A.
      const stored = relay.getRow('projects', PROJECT_A)?.body;
      expect(stored).not.toBeNull();
      const envelope = JSON.parse(stored!) as Record<string, unknown>;
      expect(Object.keys(envelope).sort()).toEqual(['alg', 'ct', 'key_id', 'nonce']);
      expect(envelope.alg).toBe('AES-256-GCM');
      expect(envelope.key_id).toBe(keyId);
      expect(stored).not.toContain('Repo');
      expect(stored).not.toContain('"columns"');
      expect(stored).not.toContain('device-a');

      // B pulls and decrypts: the local row content equals A's.
      expectOk(await engineB.syncNow());
      expect(rawGet(fixtureB, 'SELECT name FROM projects WHERE id = ?', PROJECT_A)?.name).toBe(
        'Repo'
      );
    });

    it('sends the client_version on push and decrypts with the stored one on pull', async () => {
      fixtureA = await openDb();
      fixtureB = await openDb();
      const relay = new FakeRelayTransport();
      const engineA = encryptedEngine(fixtureA, relay, 'device-a');
      const engineB = encryptedEngine(fixtureB, relay, 'device-b');

      await seedProject(fixtureA, PROJECT_A);
      expectOk(await engineA.syncNow());
      // First push of a never-synced row carries client_version 0.
      expect(relay.getRow('projects', PROJECT_A)?.client_version).toBe(0);

      // B applies the row (server version 1), edits it, and pushes the edit
      // bound to its last-known server version.
      expectOk(await engineB.syncNow());
      await fixtureB.db
        .update(projects)
        .set({ name: 'Renamed on B' })
        .where(eq(projects.id, PROJECT_A));
      expectOk(await engineB.syncNow());
      expect(relay.getRow('projects', PROJECT_A)?.client_version).toBe(1);

      // A pulls the re-encrypted patch and decrypts it under client_version 1.
      expectOk(await engineA.syncNow());
      expect(rawGet(fixtureA, 'SELECT name FROM projects WHERE id = ?', PROJECT_A)?.name).toBe(
        'Renamed on B'
      );
    });

    it('continues the pull past an undecryptable patch (rekeyed body) and counts it', async () => {
      fixtureA = await openDb();
      fixtureB = await openDb();
      const relay = new FakeRelayTransport();
      const engineB = encryptedEngine(fixtureB, relay, 'device-b');

      // One row encrypted under the space key (decryptable), one under a
      // foreign key (another machine rekeyed the space) and one tampered.
      const good = encryptBody(
        k0,
        keyId,
        { table: 'projects', pk: PROJECT_A, version: 0, keyId },
        JSON.stringify({ deviceId: 'a', columns: { id: PROJECT_A, name: 'Repo' } })
      );
      const foreignK0 = mintK0();
      const foreignKeyId = keyIdOf(foreignK0);
      const foreign = encryptBody(
        foreignK0,
        foreignKeyId,
        { table: 'tasks', pk: TASK_1, version: 0, keyId: foreignKeyId },
        JSON.stringify({ deviceId: 'x', columns: { id: TASK_1, project_id: PROJECT_A, name: 'X' } })
      );
      const tamperedEnvelope = JSON.parse(
        encryptBody(k0, keyId, { table: 'conversations', pk: CONV_1, version: 0, keyId }, 'old')
      ) as { ct: string };
      const tamperedBits = Buffer.from(tamperedEnvelope.ct, 'base64url');
      tamperedBits[0] = tamperedBits[0]! ^ 1;
      const tampered = JSON.stringify({
        ...tamperedEnvelope,
        ct: tamperedBits.toString('base64url'),
      });

      relay.seedRow('projects', PROJECT_A, good);
      relay.seedRow('tasks', TASK_1, foreign);
      relay.seedRow('conversations', CONV_1, tampered);

      const pull = await engineB.syncNow();
      expectOk(pull);
      if (!pull.success) return;
      expect(pull.data.skippedUndecryptable).toBe(2);
      // The decryptable row was applied; the undecryptable ones were skipped
      // without aborting the batch, and the cursor still advanced past all.
      expect(rawGet(fixtureB, 'SELECT id FROM projects WHERE id = ?', PROJECT_A)).toBeDefined();
      expect(rawGet(fixtureB, 'SELECT id FROM tasks WHERE id = ?', TASK_1)).toBeUndefined();
      expect(rawGet(fixtureB, 'SELECT id FROM conversations WHERE id = ?', CONV_1)).toBeUndefined();
      expect(
        JSON.parse(
          rawGet(fixtureB, "SELECT value FROM kv WHERE key = 'sync:cursor'")?.value as string
        )
      ).toBe(relay.maxVersion);

      // The skipped rows are recorded as seen: no re-push, no re-fetch wedge.
      const state = rawGet(fixtureB, 'SELECT * FROM sync_row_state WHERE pk = ?', TASK_1);
      expect(state?.server_version).toBe(2);
      expect(state?.dirty).toBe(0);
    });

    it('keeps the last good content when a newer patch fails to decrypt, and applies later good patches', async () => {
      fixtureA = await openDb();
      fixtureB = await openDb();
      const relay = new FakeRelayTransport();
      const engineA = encryptedEngine(fixtureA, relay, 'device-a');
      const engineB = encryptedEngine(fixtureB, relay, 'device-b');

      await seedProject(fixtureA, PROJECT_A);
      expectOk(await engineA.syncNow());
      expectOk(await engineB.syncNow());
      expect(rawGet(fixtureB, 'SELECT name FROM projects WHERE id = ?', PROJECT_A)?.name).toBe(
        'Repo'
      );

      // A rekeys and re-encrypts the row under a new key id (simulated by
      // seeding); B cannot decrypt that patch but keeps its last good row.
      const foreignK0 = mintK0();
      const foreignKeyId = keyIdOf(foreignK0);
      const foreign = encryptBody(
        foreignK0,
        foreignKeyId,
        { table: 'projects', pk: PROJECT_A, version: 1, keyId: foreignKeyId },
        JSON.stringify({ deviceId: 'a', columns: { id: PROJECT_A, name: 'Rekeyed' } })
      );
      relay.seedRow('projects', PROJECT_A, foreign);

      const pull = await engineB.syncNow();
      expectOk(pull);
      if (!pull.success) return;
      expect(pull.data.skippedUndecryptable).toBe(1);
      expect(rawGet(fixtureB, 'SELECT name FROM projects WHERE id = ?', PROJECT_A)?.name).toBe(
        'Repo'
      );

      // A (still holding K0) pushes a decryptable edit at a newer version;
      // B applies it once it arrives — the skipped version does not wedge
      // the row.
      await fixtureA.db
        .update(projects)
        .set({ name: 'Renamed on A' })
        .where(eq(projects.id, PROJECT_A));
      expectOk(await engineA.syncNow());
      expectOk(await engineB.syncNow());
      expect(rawGet(fixtureB, 'SELECT name FROM projects WHERE id = ?', PROJECT_A)?.name).toBe(
        'Renamed on A'
      );
    });
  });
});
