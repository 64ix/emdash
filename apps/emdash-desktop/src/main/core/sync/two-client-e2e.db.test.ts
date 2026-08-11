/**
 * End-to-end sync across TWO separate client stacks and the REAL relay
 * (spec #130). Two independent app databases stand in for two machines; the
 * relay is the actual Worker code (apps/sync-relay: service.ts + store.ts +
 * schema.ts) over an in-process D1. Nothing here is a fake: pairing derives K0
 * from the pasted secret, bodies are AES-256-GCM encrypted by the real
 * EncryptingRelayTransport, and push/pull run the relay's real service
 * functions. (The service is called directly rather than through the HTTP
 * `handle()` router — that would drag Cloudflare Workers types into this
 * project's typecheck; Bearer-token auth resolution is covered by the relay's
 * own suite.) Proves the headline flow — a task created on machine A appears
 * on machine B — and that the relay only ever stores ciphertext.
 */
import { ok } from '@emdash/shared';
import { openFixture } from '@tooling/utils/db';
import type { FixtureDb } from '@tooling/utils/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { backfillTaskBranches } from '@main/core/tasks/backfill-task-branches';
import { commitCreateTask, type PreparedCreateTask } from '@main/core/tasks/operations/createTask';
import { projects, tasks, workspaces } from '@main/db/schema';
import type { SqlDb } from '../../../../../sync-relay/src/db';
import { ensureSchema } from '../../../../../sync-relay/src/schema';
import {
  type AuthContext,
  createSpace,
  join,
  pull as relayPull,
  push as relayPush,
} from '../../../../../sync-relay/src/service';
import { MemoryD1 } from '../../../../../sync-relay/test/memory-d1';
import { joinCredentialOf, keyIdOf, parseSpaceSecret } from './crypto';
import { EncryptingRelayTransport } from './encrypting-transport';
import { SyncEngine } from './engine';
import type {
  RelayTransport,
  SyncJoinResult,
  SyncMutation,
  SyncPullResult,
  SyncPushResult,
  SyncSpaceCreated,
  SyncDeviceInfo,
} from './transport';

// The createTask module imports the app DB singleton at module scope; the
// tests below only use the pure prepare/commit operations against their own
// fixture databases, so stub the singleton out.
vi.mock('@main/db/client', () => ({ db: {}, sqlite: {} }));

const NOW = 1_800_000_000_000;

/** A RelayTransport backed by the real relay service functions over a shared
 * in-process D1, scoped to one device's AuthContext (as the token would
 * resolve to). */
class InProcessRelayTransport implements RelayTransport {
  constructor(
    private readonly db: SqlDb,
    private readonly auth: AuthContext
  ) {}

  async push(mutations: SyncMutation[]): Promise<SyncPushResult> {
    return (await relayPush(this.db, this.auth, { mutations }, NOW)) as SyncPushResult;
  }
  async pull(cursor: number, limit?: number): Promise<SyncPullResult> {
    return (await relayPull(this.db, this.auth, { cursor, limit }, NOW)) as SyncPullResult;
  }
  async poll(cursor: number, limit?: number): Promise<SyncPullResult> {
    return this.pull(cursor, limit);
  }
  createSpace(): Promise<SyncSpaceCreated> {
    throw new Error('unused: setup uses the relay service directly');
  }
  join(): Promise<SyncJoinResult> {
    throw new Error('unused');
  }
  mintJoinSecret(): Promise<{ join_hash: string }> {
    throw new Error('unused');
  }
  listDevices(): Promise<{ devices: SyncDeviceInfo[] }> {
    throw new Error('unused');
  }
  revokeDevice(_deviceId: string): Promise<{ device_id: string; revoked: boolean }> {
    throw new Error('unused');
  }
}

function keyReader(k0: Uint8Array) {
  return { get: async () => ok({ keyId: keyIdOf(k0), k0 }) };
}

type TwoClients = {
  relayDb: SqlDb;
  fixtureA: FixtureDb;
  fixtureB: FixtureDb;
  engineA: SyncEngine;
  engineB: SyncEngine;
};

/**
 * Boots the real relay (Worker code over an in-process D1), pairs machine A
 * (creates the space) and machine B (joins with the pasted secret), and returns
 * two independent client stacks sharing the space's K0.
 */
async function setupTwoClients(): Promise<TwoClients> {
  const relayDb = new MemoryD1();
  await ensureSchema(relayDb);

  const space = await createSpace(relayDb, { name: 'machine-a' }, NOW);
  const parts = parseSpaceSecret(space.secret);
  if (parts === null) throw new Error('expected parseable space secret');
  const k0 = parts.k0; // both machines derive the SAME K0 from the secret

  const joined = await join(
    relayDb,
    { join_hash: joinCredentialOf(parts.joinHalf), space_id: parts.spaceId, name: 'machine-b' },
    NOW
  );
  expect(joined.space_id).toBe(parts.spaceId);

  const authA: AuthContext = { spaceId: parts.spaceId, tokenId: space.device_id };
  const authB: AuthContext = { spaceId: parts.spaceId, tokenId: joined.device_id };

  const fixtureA = await openFixture('empty');
  const fixtureB = await openFixture('empty');

  const engineA = new SyncEngine({
    sqlite: fixtureA.sqlite,
    transport: new EncryptingRelayTransport(
      new InProcessRelayTransport(relayDb, authA),
      keyReader(k0),
      parts.spaceId
    ),
    deviceId: 'device-a',
  });
  const engineB = new SyncEngine({
    sqlite: fixtureB.sqlite,
    transport: new EncryptingRelayTransport(
      new InProcessRelayTransport(relayDb, authB),
      keyReader(k0),
      parts.spaceId
    ),
    deviceId: 'device-b',
  });

  return { relayDb, fixtureA, fixtureB, engineA, engineB };
}

describe('two-client end-to-end through the real relay', () => {
  let clients: TwoClients | undefined;

  afterEach(() => {
    clients?.fixtureA.close();
    clients?.fixtureB.close();
    clients = undefined;
  });

  it('a task created on machine A appears on machine B, encrypted end-to-end', async () => {
    clients = await setupTwoClients();
    const { relayDb, fixtureA, fixtureB, engineA, engineB } = clients;

    // ── A creates a project + task and syncs ───────────────────────────────
    const SECRET_TASK_NAME = 'Ship the multi-machine sync';
    await fixtureA.db.insert(projects).values({ id: 'proj-1', name: 'ProtoRTS', path: '/local/a' });
    await fixtureA.db.insert(tasks).values({
      id: 'task-1',
      projectId: 'proj-1',
      name: SECRET_TASK_NAME,
      status: 'in_progress',
      workflowStage: 'implementing',
      taskBranch: 'task/sync',
    });
    const pushA = await engineA.syncNow();
    expect(pushA.success, JSON.stringify(pushA)).toBe(true);

    // ── B syncs and receives the task + project ────────────────────────────
    const pullB = await engineB.syncNow();
    expect(pullB.success, JSON.stringify(pullB)).toBe(true);

    const taskOnB = fixtureB.sqlite
      .prepare('SELECT name, workflow_stage, task_branch, project_id FROM tasks WHERE id = ?')
      .get('task-1') as
      | { name: string; workflow_stage: string; task_branch: string; project_id: string }
      | undefined;
    expect(taskOnB?.name).toBe(SECRET_TASK_NAME);
    expect(taskOnB?.workflow_stage).toBe('implementing');
    expect(taskOnB?.task_branch).toBe('task/sync');

    // The project arrives Unattached (its machine-local path never travels).
    const projectOnB = fixtureB.sqlite
      .prepare('SELECT name, path FROM projects WHERE id = ?')
      .get('proj-1') as { name: string; path: string | null } | undefined;
    expect(projectOnB?.name).toBe('ProtoRTS');
    expect(projectOnB?.path).toBeNull();

    // ── The relay stored ONLY ciphertext ───────────────────────────────────
    const stored = (await relayDb.prepare('SELECT table_name, body FROM sync_rows').all())
      .results as Array<{ table_name: string; body: string | null }>;
    const taskRow = stored.find((r) => r.table_name === 'tasks');
    expect(taskRow?.body).toBeDefined();
    expect(taskRow!.body).not.toBeNull();
    // The plaintext task name must never appear in what the relay holds.
    for (const row of stored) {
      expect(row.body ?? '').not.toContain(SECRET_TASK_NAME);
    }
    // The stored body is a versioned AES-256-GCM envelope, not our JSON.
    const envelope = JSON.parse(taskRow!.body!) as { alg?: string; ct?: string };
    expect(envelope.alg).toBe('AES-256-GCM');
    expect(typeof envelope.ct).toBe('string');
  });

  it('a modern-created task and a backfilled task both carry their branch to machine B', async () => {
    clients = await setupTwoClients();
    const { fixtureA, fixtureB, engineA, engineB } = clients;

    await fixtureA.db.insert(projects).values({ id: 'proj-1', name: 'ProtoRTS', path: '/local/a' });

    // Machine A creates a task through the real modern path: the branch lives
    // in the machine-local workspaces.config, and commitCreateTask mirrors it
    // onto the synced task row (spec #130 story 25).
    const workspaceConfig = {
      version: '3' as const,
      git: {
        kind: 'create-branch' as const,
        branchName: 'task/sync',
        fromBranch: { type: 'local' as const, branch: 'main' },
        pushBranch: true,
      },
      workspace: { kind: 'new-worktree' as const },
    };
    const prepared: PreparedCreateTask = {
      params: {
        id: 'task-2',
        projectId: 'proj-1',
        taskConfig: { version: '1', name: 'Modern task' },
        workspaceConfig,
      },
      initialStatus: 'in_progress',
      workspaceId: 'ws-2',
      newWorkspaceValues: {
        id: 'ws-2',
        kind: 'worktree',
        location: 'local',
        type: 'local',
        config: workspaceConfig,
      },
      convInsert: undefined,
      taskBranch: 'task/sync',
    };
    fixtureA.db.transaction((tx) => {
      commitCreateTask(prepared, tx);
    });

    // An older task (created before the mirror existed) carries no branch on
    // its own row; the startup backfill repairs it from the workspace config.
    await fixtureA.db.insert(workspaces).values({
      id: 'ws-3',
      kind: 'worktree',
      location: 'local',
      type: 'local',
      config: {
        version: '3',
        git: { kind: 'use-branch', branchName: 'feature/backfilled' },
        workspace: { kind: 'new-worktree' },
      },
    });
    await fixtureA.db.insert(tasks).values({
      id: 'task-3',
      projectId: 'proj-1',
      name: 'Old task',
      status: 'in_progress',
      workspaceId: 'ws-3',
      taskBranch: null,
    });
    backfillTaskBranches(fixtureA.db);

    const pushA = await engineA.syncNow();
    expect(pushA.success, JSON.stringify(pushA)).toBe(true);
    const pullB = await engineB.syncNow();
    expect(pullB.success, JSON.stringify(pullB)).toBe(true);

    const tasksOnB = fixtureB.sqlite
      .prepare('SELECT id, task_branch, workspace_id FROM tasks ORDER BY id')
      .all() as Array<{ id: string; task_branch: string | null; workspace_id: string | null }>;
    expect(tasksOnB).toEqual([
      { id: 'task-2', task_branch: 'task/sync', workspace_id: null },
      { id: 'task-3', task_branch: 'feature/backfilled', workspace_id: null },
    ]);
  });
});
