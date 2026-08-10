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
import { afterEach, describe, expect, it } from 'vitest';
import { projects, tasks } from '@main/db/schema';
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

describe('two-client end-to-end through the real relay', () => {
  let fixtureA: FixtureDb | undefined;
  let fixtureB: FixtureDb | undefined;

  afterEach(() => {
    fixtureA?.close();
    fixtureB?.close();
    fixtureA = undefined;
    fixtureB = undefined;
  });

  it('a task created on machine A appears on machine B, encrypted end-to-end', async () => {
    // ── Relay: the real Worker code over an in-process D1 ──────────────────
    const relayDb = new MemoryD1();
    await ensureSchema(relayDb);

    // ── Pairing: A creates the space, B joins with the pasted secret ───────
    const space = await createSpace(relayDb, { name: 'machine-a' }, NOW);
    const parts = parseSpaceSecret(space.secret);
    expect(parts).not.toBeNull();
    if (parts === null) return;
    const k0 = parts.k0; // both machines derive the SAME K0 from the secret

    const joined = await join(
      relayDb,
      { join_hash: joinCredentialOf(parts.joinHalf), space_id: parts.spaceId, name: 'machine-b' },
      NOW
    );
    expect(joined.space_id).toBe(parts.spaceId);

    // Each device's AuthContext, as its Bearer token would resolve on the relay
    // (the tokens table keys the row id on the device id at create/join time).
    const authA: AuthContext = { spaceId: parts.spaceId, tokenId: space.device_id };
    const authB: AuthContext = { spaceId: parts.spaceId, tokenId: joined.device_id };

    // ── Two independent machines ───────────────────────────────────────────
    fixtureA = await openFixture('empty');
    fixtureB = await openFixture('empty');

    const engineA = new SyncEngine({
      sqlite: fixtureA.sqlite,
      transport: new EncryptingRelayTransport(
        new InProcessRelayTransport(relayDb, authA),
        keyReader(k0)
      ),
      deviceId: 'device-a',
    });
    const engineB = new SyncEngine({
      sqlite: fixtureB.sqlite,
      transport: new EncryptingRelayTransport(
        new InProcessRelayTransport(relayDb, authB),
        keyReader(k0)
      ),
      deviceId: 'device-b',
    });

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
});
