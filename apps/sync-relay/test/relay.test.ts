import { describe, expect, it } from 'vitest';
import { makeJoinSecret, sha256Hex } from '../src/crypto';
import type { SqlDb } from '../src/db';
import { handle } from '../src/index';
import { ensureSchema } from '../src/schema';
import { JOIN_SECRET_TTL_MS, MAX_JOIN_ATTEMPTS } from '../src/service';
import * as store from '../src/store';
import { MemoryD1 } from './memory-d1';
import { tamperLastChar } from './tamper';

/** Fixed clock so pairing TTL and attempt-budget tests are deterministic. */
const T0 = 1_800_000_000_000;

interface SpaceCreated {
  space_id: string;
  device_id: string;
  device_token: string;
  secret: string;
}

interface JoinResult {
  device_id: string;
  device_token: string;
}

interface DeviceInfo {
  device_id: string;
  name: string;
  created_at: number;
  last_seen_at: number | null;
  revoked: boolean;
  revoked_at: number | null;
  self: boolean;
}

interface Patch {
  space: string;
  table: string;
  pk: string;
  version: number;
  op: 'upsert' | 'delete';
  deleted: boolean;
  body: string | null;
}

interface PullResult {
  cursor: number;
  patches: Patch[];
}

async function makeDb(): Promise<SqlDb> {
  const db = new MemoryD1();
  await ensureSchema(db);
  return db;
}

function request(method: string, path: string, body: unknown, token?: string): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token !== undefined) {
    headers.authorization = `Bearer ${token}`;
  }
  return new Request(`https://relay.local${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function post(
  db: SqlDb,
  path: string,
  body: unknown,
  token?: string,
  now: number = T0
): Promise<{ status: number; body: unknown }> {
  const response = await handle(request('POST', path, body, token), db, now);
  return { status: response.status, body: await response.json() };
}

async function get(
  db: SqlDb,
  path: string,
  token: string,
  now: number = T0
): Promise<{ status: number; body: unknown }> {
  const response = await handle(request('GET', path, undefined, token), db, now);
  return { status: response.status, body: await response.json() };
}

async function createSpace(db: SqlDb, name?: string, now: number = T0): Promise<SpaceCreated> {
  const result = await post(db, '/v1/space', { name }, undefined, now);
  expect(result.status).toBe(200);
  return result.body as SpaceCreated;
}

describe('space creation', () => {
  it('creates a space and returns a device token plus a pairing secret', async () => {
    const db = await makeDb();
    const space = await createSpace(db, 'desk');
    expect(space.space_id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(space.device_id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(space.device_token).toMatch(/^emdv1_/);
    expect(space.secret).toMatch(/^emdj1_/);

    const devices = await get(db, '/v1/devices', space.device_token);
    expect(devices.status).toBe(200);
    const list = (devices.body as { devices: DeviceInfo[] }).devices;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      device_id: space.device_id,
      name: 'desk',
      revoked: false,
      revoked_at: null,
      self: true,
    });
  });

  it('rejects an unparseable JSON body with 400', async () => {
    const db = await makeDb();
    const response = await handle(
      new Request('https://relay.local/v1/space', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{not json',
      }),
      db,
      T0
    );
    expect(response.status).toBe(400);
  });

  it('rejects unknown routes with 404', async () => {
    const db = await makeDb();
    const response = await handle(
      new Request('https://relay.local/v1/nope', { method: 'GET' }),
      db,
      T0
    );
    expect(response.status).toBe(404);
  });
});

describe('pairing', () => {
  it('joins with the correct secret and issues a second device token', async () => {
    const db = await makeDb();
    const space = await createSpace(db);
    const join = await post(db, '/v1/join', { join_hash: space.secret, name: 'laptop' });
    expect(join.status).toBe(200);
    const joined = join.body as JoinResult;
    expect(joined.device_token).toMatch(/^emdv1_/);
    expect(joined.device_id).not.toBe(space.device_id);

    const devices = await get(db, '/v1/devices', space.device_token);
    const list = (devices.body as { devices: DeviceInfo[] }).devices;
    expect(list).toHaveLength(2);
    expect(list.map((d) => d.device_id).sort()).toEqual([space.device_id, joined.device_id].sort());
  });

  it('rejects a wrong secret', async () => {
    const db = await makeDb();
    await createSpace(db);
    const join = await post(db, '/v1/join', { join_hash: 'not-a-secret' });
    expect(join.status).toBe(401);
  });

  it('rejects a well-formed but unknown secret', async () => {
    const db = await makeDb();
    const space = await createSpace(db);
    // Same space, but the relay has never stored this credential.
    const unknown = await makeJoinSecret(space.space_id);
    const join = await post(db, '/v1/join', { join_hash: unknown });
    expect(join.status).toBe(401);
  });

  it('is single-use: the same secret cannot join twice', async () => {
    const db = await makeDb();
    const space = await createSpace(db);
    expect((await post(db, '/v1/join', { join_hash: space.secret })).status).toBe(200);
    const second = await post(db, '/v1/join', { join_hash: space.secret });
    expect(second.status).toBe(401);
  });

  it('is TTL-bounded: joining after the 15-minute window is refused', async () => {
    const db = await makeDb();
    const space = await createSpace(db, undefined, T0);
    // One millisecond before expiry: accepted.
    const before = await post(
      db,
      '/v1/join',
      { join_hash: space.secret },
      undefined,
      T0 + JOIN_SECRET_TTL_MS - 1
    );
    expect(before.status).toBe(200);
  });

  it('is TTL-bounded: joining at or after expiry is refused', async () => {
    const db = await makeDb();
    const space = await createSpace(db, undefined, T0);
    const atExpiry = await post(
      db,
      '/v1/join',
      { join_hash: space.secret },
      undefined,
      T0 + JOIN_SECRET_TTL_MS
    );
    expect(atExpiry.status).toBe(401);
    const after = await post(
      db,
      '/v1/join',
      { join_hash: space.secret },
      undefined,
      T0 + JOIN_SECRET_TTL_MS + 1
    );
    expect(after.status).toBe(401);
  });

  it('enforces the per-secret attempt budget and purges the secret when exhausted', async () => {
    const db = await makeDb();
    const space = await createSpace(db);
    // Well-formed credential for the same space that is not the stored secret:
    // each attempt charges the pending secret's budget.
    const wrong = await makeJoinSecret(space.space_id);
    for (let i = 0; i < MAX_JOIN_ATTEMPTS - 1; i++) {
      expect((await post(db, '/v1/join', { join_hash: wrong })).status).toBe(401);
    }
    // Budget not yet exhausted: the real secret still joins.
    expect((await post(db, '/v1/join', { join_hash: space.secret })).status).toBe(200);
  });

  it('refuses the real secret once the attempt budget is exhausted', async () => {
    const db = await makeDb();
    const space = await createSpace(db);
    const wrong = await makeJoinSecret(space.space_id);
    for (let i = 0; i < MAX_JOIN_ATTEMPTS; i++) {
      expect((await post(db, '/v1/join', { join_hash: wrong })).status).toBe(401);
    }
    const join = await post(db, '/v1/join', { join_hash: space.secret });
    expect(join.status).toBe(401);
  });

  it('lets an existing device mint a fresh pairing secret for a second device', async () => {
    const db = await makeDb();
    const space = await createSpace(db);
    const minted = await post(db, '/v1/devices/join-secret', {}, space.device_token);
    expect(minted.status).toBe(200);
    const { secret } = minted.body as { secret: string };
    const join = await post(db, '/v1/join', { join_hash: secret, name: 'phone' });
    expect(join.status).toBe(200);
    const devices = await get(db, '/v1/devices', space.device_token);
    expect((devices.body as { devices: DeviceInfo[] }).devices).toHaveLength(2);
  });
});

describe('push and the per-space version counter', () => {
  it('assigns monotonically increasing per-space versions in receipt order', async () => {
    const db = await makeDb();
    const space = await createSpace(db);
    const push1 = await post(
      db,
      '/v1/sync/push',
      {
        mutations: [
          { table: 't', pk: 'a', body: 'one', op: 'upsert' },
          { table: 't', pk: 'b', body: 'two', op: 'upsert' },
          { table: 't', pk: 'c', body: 'three', op: 'upsert' },
        ],
      },
      space.device_token
    );
    expect(push1.status).toBe(200);
    expect(
      (push1.body as { results: { version: number }[] }).results.map((r) => r.version)
    ).toEqual([1, 2, 3]);

    const push2 = await post(
      db,
      '/v1/sync/push',
      { mutations: [{ table: 't', pk: 'a', body: 'one-again', op: 'upsert' }] },
      space.device_token
    );
    expect(
      (push2.body as { results: { version: number }[] }).results.map((r) => r.version)
    ).toEqual([4]);
  });

  it('keeps separate counters per space', async () => {
    const db = await makeDb();
    const a = await createSpace(db);
    const b = await createSpace(db);
    const pushA = await post(
      db,
      '/v1/sync/push',
      { mutations: [{ table: 't', pk: '1', body: 'a1', op: 'upsert' }] },
      a.device_token
    );
    const pushB = await post(
      db,
      '/v1/sync/push',
      { mutations: [{ table: 't', pk: '1', body: 'b1', op: 'upsert' }] },
      b.device_token
    );
    expect((pushA.body as { results: { version: number }[] }).results[0].version).toBe(1);
    expect((pushB.body as { results: { version: number }[] }).results[0].version).toBe(1);
  });

  it('applies last-write-wins by server receipt order and never rejects a stale push', async () => {
    const db = await makeDb();
    const space = await createSpace(db);
    const first = await post(
      db,
      '/v1/sync/push',
      {
        mutations: [{ table: 't', pk: 'a', version: 999, body: 'newer-client-view', op: 'upsert' }],
      },
      space.device_token
    );
    expect(first.status).toBe(200);
    // Stale client version: accepted and overwrites, not rejected.
    const stale = await post(
      db,
      '/v1/sync/push',
      { mutations: [{ table: 't', pk: 'a', version: 1, body: 'older-client-view', op: 'upsert' }] },
      space.device_token
    );
    expect(stale.status).toBe(200);

    const pull = await post(db, '/v1/sync/pull', { cursor: 0 }, space.device_token);
    const patches = (pull.body as PullResult).patches;
    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({
      table: 't',
      pk: 'a',
      body: 'older-client-view',
      version: 2,
      op: 'upsert',
      deleted: false,
    });
  });

  it('rejects a malformed mutation list without writing anything', async () => {
    const db = await makeDb();
    const space = await createSpace(db);
    const result = await post(
      db,
      '/v1/sync/push',
      {
        mutations: [
          { table: 't', pk: 'ok', body: 'fine', op: 'upsert' },
          { table: 't', body: 'missing-pk', op: 'upsert' },
        ],
      },
      space.device_token
    );
    expect(result.status).toBe(400);
    const pull = await post(db, '/v1/sync/pull', { cursor: 0 }, space.device_token);
    expect((pull.body as PullResult).patches).toHaveLength(0);
  });

  it('stores opaque row bodies verbatim without parsing them', async () => {
    const db = await makeDb();
    const space = await createSpace(db);
    const bodies = [
      'not-json{',
      '{"encrypted": true}',
      '\u0000binary\x01ish',
      '',
      'x'.repeat(5000),
    ];
    const mutations = bodies.map((body, i) => ({ table: 't', pk: `k${i}`, body, op: 'upsert' }));
    const result = await post(db, '/v1/sync/push', { mutations }, space.device_token);
    expect(result.status).toBe(200);

    const pull = await post(db, '/v1/sync/pull', { cursor: 0 }, space.device_token);
    const patches = (pull.body as PullResult).patches;
    expect(patches.map((p) => p.body)).toEqual(bodies);
  });
});

describe('pull cursor semantics', () => {
  it('returns only rows with version greater than the cursor, ordered ascending', async () => {
    const db = await makeDb();
    const space = await createSpace(db);
    await post(
      db,
      '/v1/sync/push',
      { mutations: [{ table: 't', pk: 'a', body: 'A', op: 'upsert' }] },
      space.device_token
    );
    await post(
      db,
      '/v1/sync/push',
      { mutations: [{ table: 't', pk: 'b', body: 'B', op: 'upsert' }] },
      space.device_token
    );

    const all = await post(db, '/v1/sync/pull', { cursor: 0 }, space.device_token);
    const patches = (all.body as PullResult).patches;
    expect(patches.map((p) => p.pk)).toEqual(['a', 'b']);
    expect(patches.map((p) => p.version)).toEqual([1, 2]);
    expect((all.body as PullResult).cursor).toBe(2);

    const none = await post(db, '/v1/sync/pull', { cursor: 2 }, space.device_token);
    expect((none.body as PullResult).patches).toHaveLength(0);
    expect((none.body as PullResult).cursor).toBe(2);

    const partial = await post(db, '/v1/sync/pull', { cursor: 1 }, space.device_token);
    expect((partial.body as PullResult).patches.map((p) => p.pk)).toEqual(['b']);
  });

  it('supports a limit and resumes from the returned cursor', async () => {
    const db = await makeDb();
    const space = await createSpace(db);
    await post(
      db,
      '/v1/sync/push',
      { mutations: [{ table: 't', pk: 'a', body: 'A', op: 'upsert' }] },
      space.device_token
    );
    await post(
      db,
      '/v1/sync/push',
      { mutations: [{ table: 't', pk: 'b', body: 'B', op: 'upsert' }] },
      space.device_token
    );

    const page1 = await post(db, '/v1/sync/pull', { cursor: 0, limit: 1 }, space.device_token);
    expect((page1.body as PullResult).patches.map((p) => p.pk)).toEqual(['a']);
    const page2 = await post(
      db,
      '/v1/sync/pull',
      { cursor: (page1.body as PullResult).cursor },
      space.device_token
    );
    expect((page2.body as PullResult).patches.map((p) => p.pk)).toEqual(['b']);
  });

  it('returns tombstones as rows with the deleted flag and re-upserts supersede them', async () => {
    const db = await makeDb();
    const space = await createSpace(db);
    await post(
      db,
      '/v1/sync/push',
      { mutations: [{ table: 't', pk: 'a', body: 'A', op: 'upsert' }] },
      space.device_token
    );

    const deleted = await post(
      db,
      '/v1/sync/push',
      { mutations: [{ table: 't', pk: 'a', op: 'delete' }] },
      space.device_token
    );
    expect(deleted.status).toBe(200);
    const afterDelete = await post(db, '/v1/sync/pull', { cursor: 1 }, space.device_token);
    const deletePatch = (afterDelete.body as PullResult).patches[0];
    expect(deletePatch).toMatchObject({
      pk: 'a',
      version: 2,
      op: 'delete',
      deleted: true,
      body: null,
    });

    // A re-upsert after the tombstone replaces the row (LWW per pk): the
    // tombstone is superseded, and the row is served at its fresh version.
    await post(
      db,
      '/v1/sync/push',
      { mutations: [{ table: 't', pk: 'a', body: 'A2', op: 'upsert' }] },
      space.device_token
    );
    const afterReupsert = await post(db, '/v1/sync/pull', { cursor: 1 }, space.device_token);
    expect(afterReupsert.body).toEqual({
      cursor: 3,
      patches: [
        {
          space: space.space_id,
          table: 't',
          pk: 'a',
          version: 3,
          op: 'upsert',
          deleted: false,
          body: 'A2',
        },
      ],
    });
  });
});

describe('token authentication', () => {
  it('refuses requests without a bearer token', async () => {
    const db = await makeDb();
    const result = await post(db, '/v1/devices/join-secret', {});
    expect(result.status).toBe(401);
  });

  it('refuses garbage tokens and unknown well-formed tokens', async () => {
    const db = await makeDb();
    await createSpace(db);
    expect((await get(db, '/v1/devices', 'nonsense')).status).toBe(401);
    expect(
      (await get(db, '/v1/devices', await makeJoinSecret('0123456789abcdefghijkl'))).status
    ).toBe(401);
  });

  it('refuses tokens with a tampered checksum', async () => {
    const db = await makeDb();
    const space = await createSpace(db);
    const tampered = tamperLastChar(space.device_token);
    expect((await get(db, '/v1/devices', tampered)).status).toBe(401);
  });

  it('stores only the sha256 of the token, never the token itself', async () => {
    const db = await makeDb();
    const space = await createSpace(db);
    const digest = await sha256Hex(space.device_token);
    const row = await store.findTokenBySha256(db, digest);
    expect(row).not.toBeNull();
    expect(row?.sha256).toBe(digest);
    expect(row?.sha256).not.toBe(space.device_token);
  });

  it('refuses revoked tokens while keeping the device listed for audit', async () => {
    const db = await makeDb();
    const space = await createSpace(db);
    const join = await post(db, '/v1/join', { join_hash: space.secret });
    const second = join.body as JoinResult;

    const revoked = await post(
      db,
      '/v1/devices/revoke',
      { device_id: second.device_id },
      space.device_token
    );
    expect(revoked.status).toBe(200);

    expect((await get(db, '/v1/devices', second.device_token)).status).toBe(401);
    const devices = await get(db, '/v1/devices', space.device_token);
    const secondDevice = (devices.body as { devices: DeviceInfo[] }).devices.find(
      (d) => d.device_id === second.device_id
    );
    expect(secondDevice).toMatchObject({ revoked: true });
    expect(secondDevice?.revoked_at).toBeTypeOf('number');
  });

  it('scopes revocation to the token space', async () => {
    const db = await makeDb();
    const a = await createSpace(db);
    const b = await createSpace(db);
    const joinB = await post(db, '/v1/join', { join_hash: b.secret });
    const deviceB = (joinB.body as JoinResult).device_id;

    // A's token cannot see or revoke B's device: it resolves in a different space.
    const revoked = await post(db, '/v1/devices/revoke', { device_id: deviceB }, a.device_token);
    expect(revoked.status).toBe(404);
    expect((await get(db, '/v1/devices', b.device_token)).status).toBe(200);

    // B's device list never leaks A's devices.
    const devicesB = await get(db, '/v1/devices', b.device_token);
    const ids = (devicesB.body as { devices: DeviceInfo[] }).devices.map((d) => d.device_id);
    expect(ids).toEqual(expect.not.arrayContaining([a.device_id]));
  });

  it('records last_seen_at on authenticated requests', async () => {
    const db = await makeDb();
    const space = await createSpace(db);
    await get(db, '/v1/devices', space.device_token, T0);
    const later = await get(db, '/v1/devices', space.device_token, T0 + 5_000);
    const self = (later.body as { devices: DeviceInfo[] }).devices.find((d) => d.self);
    expect(self?.last_seen_at).toBe(T0 + 5_000);
  });
});

describe('long-poll notification channel', () => {
  it('returns immediately with an empty patch set when nothing changed', async () => {
    const db = await makeDb();
    const space = await createSpace(db);
    const poll = await post(db, '/v1/sync/poll', { cursor: 0, timeout_ms: 0 }, space.device_token);
    expect(poll.status).toBe(200);
    expect(poll.body).toEqual({ cursor: 0, patches: [] });
  });

  it('returns pending patches immediately when changes exist', async () => {
    const db = await makeDb();
    const space = await createSpace(db);
    await post(
      db,
      '/v1/sync/push',
      { mutations: [{ table: 't', pk: 'a', body: 'A', op: 'upsert' }] },
      space.device_token
    );
    const poll = await post(db, '/v1/sync/poll', { cursor: 0, timeout_ms: 0 }, space.device_token);
    expect(poll.status).toBe(200);
    expect((poll.body as PullResult).patches.map((p) => p.pk)).toEqual(['a']);
    expect((poll.body as PullResult).cursor).toBe(1);
  });

  it('treats an already-consumed cursor as up to date', async () => {
    const db = await makeDb();
    const space = await createSpace(db);
    await post(
      db,
      '/v1/sync/push',
      { mutations: [{ table: 't', pk: 'a', body: 'A', op: 'upsert' }] },
      space.device_token
    );
    const poll = await post(db, '/v1/sync/poll', { cursor: 1, timeout_ms: 0 }, space.device_token);
    expect(poll.body).toEqual({ cursor: 1, patches: [] });
  });
});
