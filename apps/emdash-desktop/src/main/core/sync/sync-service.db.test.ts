/**
 * SyncService behavior tests (spec #130, ticket #137): the daily-sync
 * lifecycle against an in-process fake relay transport (the seam the relay
 * documents in apps/sync-relay/README.md). The service is fully injectable,
 * so these tests drive launch sync, manual syncNow, offline detection with
 * pending badges, reconnect draining, error recovery, single-flight
 * serialization, and the long-poll loop with reconnect backoff (fake timers).
 *
 * The engine itself is covered by sync-engine.db.test.ts; here the engine
 * runs for real against a temp SQLite database while the *service* behavior
 * (status machine, loop, backoff) is under test.
 */
import { ok } from '@emdash/shared';
import { openFixture, type FixtureDb } from '@tooling/utils/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { projects, tasks } from '@main/db/schema';
import type { SyncStatus } from '@shared/core/sync/status';
import { SyncEngine } from './engine';
import type { SpaceKey } from './space-key-store';
import type { SyncCredential } from './sync-credentials';
import { SyncService, type SyncServiceDeps } from './sync-service';
import type {
  RelayTransport,
  SyncDeviceInfo,
  SyncJoinResult,
  SyncMutation,
  SyncPatch,
  SyncPullResult,
  SyncPushResult,
  SyncSpaceCreated,
} from './transport';
import { RelayHttpError } from './transport';

// The service composes the engine with the production auto-attach hook, whose
// module graph imports the electron-backed db client and the runtime/project
// managers (via settings-service and the SSH secrets store); the service
// itself is handed an explicit sqlite connection, so the electron-bound
// modules are mocked to keep the graph importable in the node test
// environment (same idiom as auto-attach.db.test.ts).
const clientMock = vi.hoisted(() => ({
  db: undefined as Awaited<ReturnType<typeof openFixture>>['db'] | undefined,
}));

vi.mock('@main/db/client', () => ({
  get db() {
    if (!clientMock.db) throw new Error('Test database not initialized');
    return clientMock.db;
  },
}));

vi.mock('@main/core/runtime/runtime-manager', () => ({
  runtimeManager: { acquire: vi.fn() },
}));

vi.mock('@main/core/projects/project-manager', () => ({
  projectManager: { openProject: vi.fn(), getProject: vi.fn() },
}));

// ---------------------------------------------------------------------------
// In-process fake relay (wire semantics of apps/sync-relay)
// ---------------------------------------------------------------------------

type FailureMode = 'ok' | 'offline' | 'server-error';

interface RelayRow {
  version: number;
  client_version: number;
  body: string | null;
  deleted: boolean;
}

class FakeRelay implements RelayTransport {
  private version = 0;
  private readonly rows = new Map<string, Map<string, RelayRow>>();

  pushMode: FailureMode = 'ok';
  pollMode: FailureMode = 'ok';
  pushCalls = 0;
  pullCalls = 0;
  pollCalls = 0;
  deferNextPush = false;
  pendingDeferred: { mutations: SyncMutation[]; resolve: (r: SyncPushResult) => void } | null =
    null;

  seedRow(table: string, pk: string, body: string | null, deleted = false): number {
    this.version += 1;
    const tableRows = this.rows.get(table) ?? new Map<string, RelayRow>();
    tableRows.set(pk, { version: this.version, client_version: 0, body, deleted });
    this.rows.set(table, tableRows);
    return this.version;
  }

  /** Rows currently stored on the relay. */
  storedRows(): Array<{ table: string; pk: string; row: RelayRow }> {
    const result: Array<{ table: string; pk: string; row: RelayRow }> = [];
    for (const [table, pks] of this.rows) {
      for (const [pk, row] of pks) {
        result.push({ table, pk, row });
      }
    }
    return result;
  }

  async push(mutations: SyncMutation[]): Promise<SyncPushResult> {
    this.pushCalls += 1;
    if (this.pushMode === 'offline') {
      throw new RelayHttpError(0, 'relay unreachable: fetch failed');
    }
    if (this.pushMode === 'server-error') {
      throw new RelayHttpError(500, 'server exploded');
    }
    if (this.deferNextPush) {
      // Single-flight test: hold the request until the test resolves it.
      this.deferNextPush = false;
      return new Promise<SyncPushResult>((resolve) => {
        this.pendingDeferred = { mutations, resolve };
      });
    }
    return this.ack(mutations);
  }

  private ack(mutations: SyncMutation[]): SyncPushResult {
    const results: SyncPushResult['results'] = [];
    for (const mutation of mutations) {
      this.version += 1;
      const tableRows = this.rows.get(mutation.table) ?? new Map<string, RelayRow>();
      tableRows.set(mutation.pk, {
        version: this.version,
        client_version: mutation.client_version,
        body: mutation.body ?? null,
        deleted: mutation.op === 'delete',
      });
      this.rows.set(mutation.table, tableRows);
      results.push({ table: mutation.table, pk: mutation.pk, version: this.version });
    }
    return { results };
  }

  async pull(cursor: number, limit = 1000): Promise<SyncPullResult> {
    this.pullCalls += 1;
    return this.patchesSince(cursor, limit);
  }

  async poll(cursor: number, _timeoutMs?: number): Promise<SyncPullResult> {
    this.pollCalls += 1;
    if (this.pollMode === 'offline') {
      throw new RelayHttpError(0, 'relay unreachable: fetch failed');
    }
    if (this.pollMode === 'server-error') {
      throw new RelayHttpError(500, 'server exploded');
    }
    return this.patchesSince(cursor, 1000);
  }

  private patchesSince(cursor: number, limit: number): SyncPullResult {
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

  async createSpace(_name?: string): Promise<SyncSpaceCreated> {
    return { space_id: 'space-1', device_id: 'device-1', device_token: 'token', secret: 's' };
  }
  async join(_j: string, _s: string, _n?: string): Promise<SyncJoinResult> {
    return { device_id: 'device-2', device_token: 'token-2', space_id: 'space-1' };
  }
  async mintJoinSecret(_j: string): Promise<{ join_hash: string }> {
    return { join_hash: 'x'.repeat(64) };
  }
  async listDevices(): Promise<{ devices: SyncDeviceInfo[] }> {
    return { devices: [] };
  }
  async revokeDevice(deviceId: string): Promise<{ device_id: string; revoked: boolean }> {
    return { device_id: deviceId, revoked: true };
  }
}

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

const CREDENTIAL: SyncCredential = { token: 'emdv1_token', spaceId: 'space-1', deviceName: 'mac' };
const KEY: SpaceKey = { keyId: 'k1', k0: new Uint8Array(32).fill(7) };

const PROJECT_A = '11111111-1111-1111-1111-111111111111';
const TASK_A1 = 'aaaa0001-0000-0000-0000-000000000000';

describe('SyncService', () => {
  let fixture: FixtureDb;
  let relay: FakeRelay;
  let credential: SyncCredential | null;
  let spaceKey: SpaceKey | null;
  let statuses: SyncStatus[];
  let service: SyncService;
  let connectivity: {
    online: () => void;
    offline: () => void;
    onOnline: (cb: () => void) => () => void;
    onOffline: (cb: () => void) => () => void;
  };

  beforeEach(async () => {
    fixture = await openFixture('empty');
    clientMock.db = fixture.db;
    relay = new FakeRelay();
    credential = CREDENTIAL;
    spaceKey = KEY;
    statuses = [];
    let onlineCb: () => void = () => undefined;
    let offlineCb: () => void = () => undefined;
    connectivity = {
      online: () => onlineCb(),
      offline: () => offlineCb(),
      onOnline: (cb) => {
        onlineCb = cb;
        return () => {
          onlineCb = () => undefined;
        };
      },
      onOffline: (cb) => {
        offlineCb = cb;
        return () => {
          offlineCb = () => undefined;
        };
      },
    };
    service = makeService();
  });

  afterEach(() => {
    service.stop();
    fixture?.close();
    vi.useRealTimers();
  });

  function makeService(overrides: Partial<SyncServiceDeps> = {}): SyncService {
    return new SyncService({
      sqlite: fixture.sqlite,
      getCredentials: async () => ok(credential),
      getSpaceKey: async () => ok(spaceKey),
      getDeviceIdentity: async () => ({ deviceId: 'device-a', deviceName: 'mac' }),
      createTransport: () => relay,
      projectAttachHook: async () => undefined,
      onStatusChange: (status) => {
        statuses.push(status);
      },
      now: () => 1_800_000_000_000,
      // Small, deterministic timings for the loop tests.
      retryBaseMs: 100,
      retryMaxMs: 400,
      notPairedRecheckMs: 200,
      pollIdleDelayMs: 100,
      pollTimeoutMs: 1000,
      connectivity,
      ...overrides,
    });
  }

  async function seedLocalProject(id = PROJECT_A): Promise<void> {
    await fixture.db.insert(projects).values({
      id,
      name: 'Repo',
      path: '/dev/repo',
      workspaceProvider: 'local',
      baseRef: 'main',
    });
  }

  function lastStatus(): SyncStatus {
    return service.getStatus();
  }

  /** Lets the whole async cycle settle (macrotask turn drains all microtasks). */
  async function flush(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  describe('launch sync', () => {
    it('runs a push+pull cycle and reports up-to-date', async () => {
      await seedLocalProject();
      await service.syncNow();

      expect(relay.pushCalls).toBe(1);
      expect(relay.pullCalls).toBe(1);
      const status = lastStatus();
      expect(status.state).toBe('up-to-date');
      expect(status.paired).toBe(true);
      expect(status.lastSyncAt).toBe(1_800_000_000_000);
      expect(status.lastError).toBeNull();
      expect(status.pendingCount).toBe(0);
      // The transition was emitted: syncing first, then up-to-date.
      expect(statuses.map((s) => s.state)).toContain('syncing');
      expect(statuses[statuses.length - 1]?.state).toBe('up-to-date');
    });

    it('stays idle when no space credential exists', async () => {
      credential = null;
      spaceKey = null;
      await service.syncNow();

      expect(relay.pushCalls).toBe(0);
      expect(relay.pullCalls).toBe(0);
      expect(lastStatus()).toMatchObject({ state: 'idle', paired: false, pendingCount: 0 });
    });
  });

  describe('offline behavior', () => {
    it('marks offline-with-pending when the relay is unreachable and rows are pending', async () => {
      await seedLocalProject();
      relay.pushMode = 'offline';

      await service.syncNow();

      const status = lastStatus();
      expect(status.state).toBe('offline-with-pending');
      expect(status.pendingCount).toBeGreaterThan(0);
      expect(status.lastError).toContain('Could not reach the sync relay');
      // The failed cycle emitted a status event carrying the badge count.
      expect(statuses[statuses.length - 1]?.pendingCount).toBeGreaterThan(0);
    });

    it('reports error (not offline-with-pending) when the relay errors and rows are pending', async () => {
      // A pending row forces a real push attempt; the relay's 500 is not an
      // offline condition, so the state is `error` — never offline-with-pending.
      await seedLocalProject();
      relay.pushMode = 'server-error';
      await service.syncNow();

      const status = lastStatus();
      expect(status.state).toBe('error');
      expect(status.pendingCount).toBeGreaterThan(0);
      expect(status.lastError).toBeTruthy();
      expect(status.lastError).not.toContain('reconnect');
    });

    it('drains pending rows on reconnect', async () => {
      await seedLocalProject();
      relay.pushMode = 'offline';
      await service.syncNow();
      expect(lastStatus().state).toBe('offline-with-pending');

      // Connection returns; the next sync pushes the pending row.
      relay.pushMode = 'ok';
      await service.syncNow();

      const status = lastStatus();
      expect(status.state).toBe('up-to-date');
      expect(status.pendingCount).toBe(0);
      expect(status.lastError).toBeNull();
      expect(relay.storedRows().some((r) => r.table === 'projects' && r.pk === PROJECT_A)).toBe(
        true
      );
    });

    it('recovers from an error state after a successful cycle', async () => {
      await seedLocalProject();
      relay.pushMode = 'server-error';
      await service.syncNow();
      expect(lastStatus().state).toBe('error');

      relay.pushMode = 'ok';
      await service.syncNow();
      expect(lastStatus().state).toBe('up-to-date');
      expect(lastStatus().lastError).toBeNull();
    });
  });

  describe('single-flight', () => {
    it('coalesces concurrent syncNow calls onto one cycle', async () => {
      await seedLocalProject();
      const first = service.syncNow();
      const second = service.syncNow();
      expect(service.syncNow()).toBe(second); // same in-flight promise

      await Promise.all([first, second]);
      expect(relay.pushCalls).toBe(1);
      expect(lastStatus().state).toBe('up-to-date');
    });

    it('serializes when the first cycle is slow', async () => {
      await seedLocalProject();
      relay.deferNextPush = true;
      const first = service.syncNow();
      const second = service.syncNow();

      await flush();
      // Exactly one push in flight; the second call coalesced onto it.
      expect(relay.pendingDeferred).not.toBeNull();
      expect(relay.pushCalls).toBe(1);

      const deferred = relay.pendingDeferred!;
      deferred.resolve({
        results: deferred.mutations.map((m, i) => ({ table: m.table, pk: m.pk, version: i + 1 })),
      });
      await Promise.all([first, second]);

      expect(relay.pushCalls).toBe(1);
      expect(lastStatus().state).toBe('up-to-date');
    });
  });

  describe('poll loop', () => {
    it('applies patches delivered by the relay, including through the poll channel', async () => {
      // Machine B pushes PLAINTEXT bodies (no encryption), so A must read
      // them without the encrypting wrapper: no space key on A.
      spaceKey = null;
      // Machine B pushes a task through a real engine against the same relay.
      const fixtureB = await openFixture('empty');
      const other = new SyncEngine({
        sqlite: fixtureB.sqlite,
        transport: relay,
        deviceId: 'device-b',
      });
      await fixtureB.db.insert(projects).values({
        id: PROJECT_A,
        name: 'Repo',
        path: '/other/repo',
        workspaceProvider: 'local',
        baseRef: 'main',
      });
      await fixtureB.db.insert(tasks).values({
        id: TASK_A1,
        projectId: PROJECT_A,
        name: 'Remote task',
        status: 'todo',
      });
      await other.syncNow();

      try {
        vi.useFakeTimers();
        service.start();
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(0);

        // The launch sync's pull applied B's rows.
        const row = fixture.sqlite.prepare('SELECT name FROM tasks WHERE id = ?').get(TASK_A1) as
          | { name: string }
          | undefined;
        expect(row?.name).toBe('Remote task');

        // B pushes another task while A is running: the poll channel wakes
        // A's loop, which applies it.
        const taskA2 = 'aaaa0002-0000-0000-0000-000000000000';
        await fixtureB.db.insert(tasks).values({
          id: taskA2,
          projectId: PROJECT_A,
          name: 'Polled task',
          status: 'todo',
        });
        await other.syncNow();

        // A's loop: idle poll delay, then the poll returns the new patches.
        await vi.advanceTimersByTimeAsync(100);
        await vi.advanceTimersByTimeAsync(100);
        const polled = fixture.sqlite.prepare('SELECT name FROM tasks WHERE id = ?').get(taskA2) as
          | { name: string }
          | undefined;
        expect(polled?.name).toBe('Polled task');
      } finally {
        service.stop();
        fixtureB.close();
        vi.useRealTimers();
      }
    });

    it('reconnects with backoff after poll failures and syncs on reconnect', async () => {
      await seedLocalProject();
      vi.useFakeTimers();
      const sleepDurations: number[] = [];
      service = makeService({
        sleep: async (ms) => {
          sleepDurations.push(ms);
          await new Promise((resolve) => setTimeout(resolve, ms));
        },
      });

      // Offline from the start: the launch sync fails with the row pending,
      // and every poll failure extends the backoff.
      relay.pushMode = 'offline';
      relay.pollMode = 'offline';
      service.start();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(0);

      expect(relay.pollCalls).toBeGreaterThanOrEqual(1);
      expect(sleepDurations.length).toBeGreaterThan(0);
      expect(sleepDurations[0]).toBe(100); // first backoff wait

      // Offline for a while: delays grow 100 → 200 → 400 (cap).
      await vi.advanceTimersByTimeAsync(100);
      expect(sleepDurations[1]).toBe(200);
      await vi.advanceTimersByTimeAsync(200);
      expect(sleepDurations[2]).toBe(400);
      expect(lastStatus().state).toBe('offline-with-pending');

      // Connection returns: the next poll succeeds, is recognized as a
      // reconnect, and a full push+pull drains the pending row.
      relay.pushMode = 'ok';
      relay.pollMode = 'ok';
      await vi.advanceTimersByTimeAsync(400);
      expect(lastStatus().state).toBe('up-to-date');
      expect(lastStatus().pendingCount).toBe(0);
      expect(relay.storedRows().some((r) => r.table === 'projects' && r.pk === PROJECT_A)).toBe(
        true
      );
    });

    it('kicks a sync when the OS reports the connection back', async () => {
      service.start();
      await flush();
      // A local edit arrives while the machine is offline.
      await seedLocalProject();
      relay.pushMode = 'offline';
      await service.syncNow();
      expect(lastStatus().state).toBe('offline-with-pending');

      relay.pushMode = 'ok';
      connectivity.online();
      await flush();

      expect(lastStatus().state).toBe('up-to-date');
      expect(lastStatus().pendingCount).toBe(0);
      // The launch pushed nothing (no local rows); the offline attempt and
      // the reconnect kick each ran one push.
      expect(relay.pushCalls).toBe(2);
    });
  });

  describe('engine status surface', () => {
    it('counts pending rows (unpushed edits) and tombstones', async () => {
      await seedLocalProject();
      const engine = new SyncEngine({
        sqlite: fixture.sqlite,
        transport: relay,
        deviceId: 'device-a',
      });
      expect(engine.pendingCount()).toBe(1);

      await fixture.db.insert(tasks).values({
        id: TASK_A1,
        projectId: PROJECT_A,
        name: 'Fix bug',
        status: 'todo',
      });
      expect(engine.pendingCount()).toBe(2);

      await engine.syncNow();
      expect(engine.pendingCount()).toBe(0);

      // A tombstone (delete) is pending until pushed.
      await fixture.db.delete(tasks).where(eq(tasks.id, TASK_A1));
      expect(engine.pendingCount()).toBe(1);

      await engine.syncNow();
      expect(engine.pendingCount()).toBe(0);
    });

    it('advances the pull cursor after a pull', async () => {
      const engine = new SyncEngine({
        sqlite: fixture.sqlite,
        transport: relay,
        deviceId: 'device-a',
      });
      expect(engine.lastCursor).toBe(0);

      relay.seedRow(
        'app_settings',
        'theme',
        JSON.stringify({ deviceId: 'device-b', columns: { value: '"dark"' } })
      );
      await engine.syncNow();
      expect(engine.lastCursor).toBeGreaterThan(0);
    });
  });
});
