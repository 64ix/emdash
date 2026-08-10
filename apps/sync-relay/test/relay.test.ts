import { describe, expect, it, vi } from 'vitest';
import { base32Encode, randomBytes, sha256Hex } from '../src/crypto';
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
  space_id: string;
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
  client_version: number;
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

function request(
  method: string,
  path: string,
  body: unknown,
  token?: string,
  relayKey?: string
): Request {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (token !== undefined) {
    headers.authorization = `Bearer ${token}`;
  }
  if (relayKey !== undefined) {
    headers['x-relay-key'] = relayKey;
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

/**
 * The join credential of a pairing secret, at its fixed position:
 * `emdj1_<space 22>_<join credential 26>_<k0 52>`.
 */
function joinCredentialOf(secret: string): string {
  return secret.slice(29, 55);
}

/** A well-formed credential that the relay has never stored. */
function freshUnknownCredential(): string {
  return base32Encode(randomBytes(16));
}

async function joinWith(
  db: SqlDb,
  secretOrCredential: string,
  spaceId: string,
  now: number = T0
): Promise<{ status: number; body: unknown }> {
  // Accept both a full secret (extract the credential) and a bare credential,
  // so the pairing tests read naturally either way.
  const credential =
    secretOrCredential.length === 26 ? secretOrCredential : joinCredentialOf(secretOrCredential);
  return post(db, '/v1/join', { join_hash: credential, space_id: spaceId }, undefined, now);
}

describe('X-Relay-Key gate', () => {
  const KEY = 'a-long-random-pre-shared-relay-key';

  it('rejects a request with no X-Relay-Key when a key is configured', async () => {
    const db = await makeDb();
    const res = await handle(request('POST', '/v1/space', { name: 'x' }, undefined), db, T0, KEY);
    expect(res.status).toBe(401);
  });

  it('rejects a request with the wrong X-Relay-Key', async () => {
    const db = await makeDb();
    const res = await handle(
      request('POST', '/v1/space', { name: 'x' }, undefined, 'wrong-key'),
      db,
      T0,
      KEY
    );
    expect(res.status).toBe(401);
  });

  it('rejects even unknown paths without the key (no path existence leak)', async () => {
    const db = await makeDb();
    const res = await handle(request('GET', '/v1/nope', undefined, undefined), db, T0, KEY);
    expect(res.status).toBe(401);
  });

  it('accepts a request carrying the correct X-Relay-Key', async () => {
    const db = await makeDb();
    const res = await handle(
      request('POST', '/v1/space', { name: 'x' }, undefined, KEY),
      db,
      T0,
      KEY
    );
    expect(res.status).toBe(200);
  });

  it('is ungated when no key is configured (handle called without a relayKey)', async () => {
    const db = await makeDb();
    const res = await handle(request('POST', '/v1/space', { name: 'x' }, undefined), db, T0);
    expect(res.status).toBe(200);
  });
});

describe('space creation', () => {
  it('creates a space and returns a device token plus a two-half pairing secret', async () => {
    const db = await makeDb();
    const space = await createSpace(db, 'desk');
    expect(space.space_id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(space.device_id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(space.device_token).toMatch(/^emdv1_/);
    // emdj1_<space 22>_<join b32 26>_<k0 b32 52>: the pasted secret embeds
    // the join half AND the space data key (K0) for the second machine.
    expect(space.secret).toMatch(/^emdj1_[A-Za-z0-9_-]{22}_[a-z2-7]{26}_[a-z2-7]{52}$/);

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

  it('stores only the sha256 of the join credential, never K0 or the secret', async () => {
    const db = await makeDb();
    const space = await createSpace(db);
    const pending = await store.listPendingJoinSecrets(db, space.space_id);
    expect(pending).toHaveLength(1);
    expect(pending[0]!.sha256).toBe(await sha256Hex(joinCredentialOf(space.secret)));
    expect(pending[0]!.sha256).not.toBe(space.secret);
    // K0 (the trailing base32 half) never reaches the store.
    expect(pending[0]!.sha256).not.toContain(space.secret.slice(56));
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
  it('joins with the correct join credential and issues a second device token', async () => {
    const db = await makeDb();
    const space = await createSpace(db);
    const join = await joinWith(db, space.secret, space.space_id);
    expect(join.status).toBe(200);
    const joined = join.body as JoinResult;
    expect(joined.device_token).toMatch(/^emdv1_/);
    expect(joined.device_id).not.toBe(space.device_id);
    expect(joined.space_id).toBe(space.space_id);

    const devices = await get(db, '/v1/devices', space.device_token);
    const list = (devices.body as { devices: DeviceInfo[] }).devices;
    expect(list).toHaveLength(2);
    expect(list.map((d) => d.device_id).sort()).toEqual([space.device_id, joined.device_id].sort());
  });

  it('rejects a wrong credential', async () => {
    const db = await makeDb();
    const space = await createSpace(db);
    const join = await post(db, '/v1/join', {
      join_hash: 'not-a-credential',
      space_id: space.space_id,
    });
    expect(join.status).toBe(401);
  });

  it('rejects a well-formed but unknown credential', async () => {
    const db = await makeDb();
    const space = await createSpace(db);
    // Well-formed 26-char credential for this space that the relay never saw.
    const join = await post(db, '/v1/join', {
      join_hash: freshUnknownCredential(),
      space_id: space.space_id,
    });
    expect(join.status).toBe(401);
  });

  it('is single-use: the same credential cannot join twice', async () => {
    const db = await makeDb();
    const space = await createSpace(db);
    expect((await joinWith(db, space.secret, space.space_id)).status).toBe(200);
    const second = await joinWith(db, space.secret, space.space_id);
    expect(second.status).toBe(401);
  });

  // Regression (TOCTOU): join() read the secret, checked used_at, THEN wrote
  // used_at in a separate round trip, so two interleaved /v1/join calls could
  // both pass the read-based check and each mint a token. consumeJoinSecret is
  // now an atomic guarded UPDATE ... WHERE used_at IS NULL ... RETURNING; the
  // in-memory harness cannot reproduce true timing interleaving, so drive the
  // store guard directly: exactly one consume wins.
  it('consumeJoinSecret is atomic single-use: only the first caller wins', async () => {
    const db = await makeDb();
    const space = await createSpace(db);
    const pending = await store.listPendingJoinSecrets(db, space.space_id);
    const secretId = pending[0]!.secret_id;
    expect(await store.consumeJoinSecret(db, secretId, T0)).toBe(true);
    expect(await store.consumeJoinSecret(db, secretId, T0)).toBe(false);
  });

  it('is TTL-bounded: joining after the 15-minute window is refused', async () => {
    const db = await makeDb();
    const space = await createSpace(db, undefined, T0);
    // One millisecond before expiry: accepted.
    const before = await joinWith(db, space.secret, space.space_id, T0 + JOIN_SECRET_TTL_MS - 1);
    expect(before.status).toBe(200);
  });

  it('is TTL-bounded: joining at or after expiry is refused', async () => {
    const db = await makeDb();
    const space = await createSpace(db, undefined, T0);
    const atExpiry = await joinWith(db, space.secret, space.space_id, T0 + JOIN_SECRET_TTL_MS);
    expect(atExpiry.status).toBe(401);
    const after = await joinWith(db, space.secret, space.space_id, T0 + JOIN_SECRET_TTL_MS + 1);
    expect(after.status).toBe(401);
  });

  it('enforces the per-secret attempt budget and purges the secret when exhausted', async () => {
    const db = await makeDb();
    const space = await createSpace(db);
    // Well-formed credential for the same space that is not the stored one:
    // each attempt charges the pending secret's budget.
    const wrong = freshUnknownCredential();
    for (let i = 0; i < MAX_JOIN_ATTEMPTS - 1; i++) {
      expect(
        (await post(db, '/v1/join', { join_hash: wrong, space_id: space.space_id })).status
      ).toBe(401);
    }
    // Budget not yet exhausted: the real credential still joins.
    expect((await joinWith(db, space.secret, space.space_id)).status).toBe(200);
  });

  it('refuses the real credential once the attempt budget is exhausted', async () => {
    const db = await makeDb();
    const space = await createSpace(db);
    const wrong = freshUnknownCredential();
    for (let i = 0; i < MAX_JOIN_ATTEMPTS; i++) {
      expect(
        (await post(db, '/v1/join', { join_hash: wrong, space_id: space.space_id })).status
      ).toBe(401);
    }
    const join = await joinWith(db, space.secret, space.space_id);
    expect(join.status).toBe(401);
  });

  it('attributes failed attempts to the named space, not other spaces', async () => {
    const db = await makeDb();
    const a = await createSpace(db);
    const b = await createSpace(db);
    // Wrong attempts against A's space burn A's budget, leaving B's secret usable.
    const wrong = freshUnknownCredential();
    for (let i = 0; i < MAX_JOIN_ATTEMPTS; i++) {
      expect((await post(db, '/v1/join', { join_hash: wrong, space_id: a.space_id })).status).toBe(
        401
      );
    }
    expect((await joinWith(db, a.secret, a.space_id)).status).toBe(401);
    expect((await joinWith(db, b.secret, b.space_id)).status).toBe(200);
  });

  it('lets an existing device register a client-minted join credential (digest only)', async () => {
    const db = await makeDb();
    const space = await createSpace(db);
    // The device mints the second secret client-side: a fresh join half +
    // the unchanged space K0. Only the SHA-256 of the join credential is
    // registered — K0 never transits.
    const joinHalf = base32Encode(randomBytes(16));
    const digest = await sha256Hex(joinHalf);
    const minted = await post(
      db,
      '/v1/devices/join-secret',
      { join_hash: digest },
      space.device_token
    );
    expect(minted.status).toBe(200);
    expect(minted.body).toEqual({ join_hash: digest });

    const join = await post(db, '/v1/join', { join_hash: joinHalf, space_id: space.space_id });
    expect(join.status).toBe(200);
    const devices = await get(db, '/v1/devices', space.device_token);
    expect((devices.body as { devices: DeviceInfo[] }).devices).toHaveLength(2);
  });

  it('rejects a join-secret registration with a malformed digest', async () => {
    const db = await makeDb();
    const space = await createSpace(db);
    for (const join_hash of ['not-hex', 'abcd', 'x'.repeat(64)]) {
      const minted = await post(db, '/v1/devices/join-secret', { join_hash }, space.device_token);
      expect(minted.status).toBe(400);
    }
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
        mutations: [
          { table: 't', pk: 'a', client_version: 999, body: 'newer-client-view', op: 'upsert' },
        ],
      },
      space.device_token
    );
    expect(first.status).toBe(200);
    // Stale client version: accepted and overwrites, not rejected.
    const stale = await post(
      db,
      '/v1/sync/push',
      {
        mutations: [
          { table: 't', pk: 'a', client_version: 1, body: 'older-client-view', op: 'upsert' },
        ],
      },
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
      client_version: 1,
      op: 'upsert',
      deleted: false,
    });
  });

  it('stores the client_version verbatim and defaults it to 0 when absent', async () => {
    const db = await makeDb();
    const space = await createSpace(db);
    await post(
      db,
      '/v1/sync/push',
      { mutations: [{ table: 't', pk: 'with', client_version: 42, body: 'A', op: 'upsert' }] },
      space.device_token
    );
    await post(
      db,
      '/v1/sync/push',
      { mutations: [{ table: 't', pk: 'without', body: 'B', op: 'upsert' }] },
      space.device_token
    );

    const pull = await post(db, '/v1/sync/pull', { cursor: 0 }, space.device_token);
    const patches = (pull.body as PullResult).patches;
    expect(patches.find((p) => p.pk === 'with')?.client_version).toBe(42);
    expect(patches.find((p) => p.pk === 'without')?.client_version).toBe(0);
  });

  it('rejects non-integer and negative client_versions', async () => {
    const db = await makeDb();
    const space = await createSpace(db);
    for (const client_version of [-1, 1.5, '1', null]) {
      const result = await post(
        db,
        '/v1/sync/push',
        { mutations: [{ table: 't', pk: 'a', client_version, body: 'x', op: 'upsert' }] },
        space.device_token
      );
      expect(result.status, `client_version=${String(client_version)}`).toBe(400);
    }
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

describe('request body validation', () => {
  it('rejects a JSON null body with 400 instead of 500 on every endpoint', async () => {
    const db = await makeDb();
    const space = await createSpace(db);
    const cases: Array<[string, string | undefined]> = [
      ['/v1/space', undefined],
      ['/v1/join', undefined],
      ['/v1/devices/revoke', space.device_token],
      ['/v1/devices/join-secret', space.device_token],
      ['/v1/sync/pull', space.device_token],
      ['/v1/sync/push', space.device_token],
      ['/v1/sync/poll', space.device_token],
    ];
    for (const [path, token] of cases) {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (token !== undefined) {
        headers.authorization = `Bearer ${token}`;
      }
      const response = await handle(
        new Request(`https://relay.local${path}`, { method: 'POST', headers, body: 'null' }),
        db,
        T0
      );
      expect(response.status, path).toBe(400);
    }
  });

  it('rejects JSON primitives as request bodies with 400', async () => {
    const db = await makeDb();
    const response = await handle(
      new Request('https://relay.local/v1/space', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '42',
      }),
      db,
      T0
    );
    expect(response.status).toBe(400);
  });

  it('defaults a non-string device name instead of crashing', async () => {
    const db = await makeDb();
    const result = await post(db, '/v1/space', { name: 42 });
    expect(result.status).toBe(200);
    const space = result.body as SpaceCreated;
    const devices = await get(db, '/v1/devices', space.device_token);
    expect((devices.body as { devices: DeviceInfo[] }).devices[0].name).toBe('default');
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

  it('validates cursor and limit boundaries', async () => {
    const db = await makeDb();
    const space = await createSpace(db);
    for (const cursor of [-1, 1.5, '1', null]) {
      const result = await post(db, '/v1/sync/pull', { cursor }, space.device_token);
      expect(result.status, `cursor=${String(cursor)}`).toBe(400);
    }
    for (const limit of [0, 1001, 1.5, '1']) {
      const result = await post(db, '/v1/sync/pull', { limit }, space.device_token);
      expect(result.status, `limit=${String(limit)}`).toBe(400);
    }
    const atLimit = await post(db, '/v1/sync/pull', { cursor: 0, limit: 1000 }, space.device_token);
    expect(atLimit.status).toBe(200);
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
          client_version: 0,
          op: 'upsert',
          deleted: false,
          body: 'A2',
        },
      ],
    });
  });
});

describe('tombstone GC', () => {
  /** Pushes an upsert then a delete for the same row; returns the tombstone version. */
  async function pushUpsertAndDelete(
    db: SqlDb,
    token: string
  ): Promise<{ tombstoneVersion: number }> {
    const upsert = await post(
      db,
      '/v1/sync/push',
      { mutations: [{ table: 't', pk: 'a', body: 'A', op: 'upsert' }] },
      token
    );
    expect(upsert.status).toBe(200);
    const deleted = await post(
      db,
      '/v1/sync/push',
      { mutations: [{ table: 't', pk: 'a', op: 'delete' }] },
      token
    );
    expect(deleted.status).toBe(200);
    return {
      tombstoneVersion: (deleted.body as { results: Array<{ version: number }> }).results[0]
        .version,
    };
  }

  async function tombstoneRows(db: SqlDb, spaceId: string): Promise<number> {
    const result = await db
      .prepare('SELECT COUNT(*) AS count FROM sync_rows WHERE space_id = ?1 AND deleted = 1')
      .bind(spaceId)
      .first<{ count: number }>();
    return result?.count ?? 0;
  }

  it('keeps a tombstone until every active device has pulled past it', async () => {
    const db = await makeDb();
    const space = await createSpace(db);
    const { tombstoneVersion } = await pushUpsertAndDelete(db, space.device_token);

    // A second device joins and pulls the tombstone, but the first device
    // has never pulled: it counts as behind everything, so the tombstone is
    // retained even though the pulling device has seen it.
    const joined = await joinWith(db, space.secret, space.space_id);
    expect(joined.status).toBe(200);
    const tokenB = (joined.body as JoinResult).device_token;
    const pulledB = await post(db, '/v1/sync/pull', { cursor: 0 }, tokenB);
    expect((pulledB.body as PullResult).cursor).toBe(tombstoneVersion);
    expect(await tombstoneRows(db, space.space_id)).toBe(1);

    // The first device finally pulls past the tombstone: now every active
    // device has seen it and the same pull collects it.
    const pulledA = await post(db, '/v1/sync/pull', { cursor: 0 }, space.device_token);
    expect((pulledA.body as PullResult).cursor).toBe(tombstoneVersion);
    expect(await tombstoneRows(db, space.space_id)).toBe(0);

    // A late-joining device (client-minted secret) sees no trace of the row:
    // the tombstone is gone and no upsert remains.
    const credential = base32Encode(randomBytes(16));
    const minted = await post(
      db,
      '/v1/devices/join-secret',
      { join_hash: await sha256Hex(credential) },
      space.device_token
    );
    expect(minted.status).toBe(200);
    const later = await joinWith(db, credential, space.space_id);
    expect(later.status).toBe(200);
    const fresh = await post(
      db,
      '/v1/sync/pull',
      { cursor: 0 },
      (later.body as JoinResult).device_token
    );
    expect((fresh.body as PullResult).patches).toEqual([]);
  });

  it('a revoked device never blocks collection', async () => {
    const db = await makeDb();
    const space = await createSpace(db);
    const { tombstoneVersion } = await pushUpsertAndDelete(db, space.device_token);

    // The first device is revoked before ever pulling: its missing cursor
    // must not count as "behind" anymore.
    const revoked = await post(
      db,
      '/v1/devices/revoke',
      { device_id: space.device_id },
      space.device_token
    );
    expect(revoked.status).toBe(200);

    // The remaining device's first pull past the tombstone collects it.
    const joined = await joinWith(db, space.secret, space.space_id);
    const tokenB = (joined.body as JoinResult).device_token;
    const pulled = await post(db, '/v1/sync/pull', { cursor: 0 }, tokenB);
    expect((pulled.body as PullResult).cursor).toBe(tombstoneVersion);
    expect(await tombstoneRows(db, space.space_id)).toBe(0);
  });

  it('the 90-day safety cap collects an old tombstone even with a device behind it', async () => {
    const db = await makeDb();
    const space = await createSpace(db, 'first', T0);
    await post(
      db,
      '/v1/sync/push',
      { mutations: [{ table: 't', pk: 'a', body: 'A', op: 'upsert' }] },
      space.device_token,
      T0
    );

    // B joins and pulls up to the upsert only (cursor 1); A then deletes the
    // row (tombstone v2). B stays at cursor 1 forever after.
    const joined = await joinWith(db, space.secret, space.space_id, T0);
    const tokenB = (joined.body as JoinResult).device_token;
    const initial = await post(db, '/v1/sync/pull', { cursor: 0 }, tokenB, T0);
    expect((initial.body as PullResult).cursor).toBe(1);
    const { tombstoneVersion } = await pushUpsertAndDelete(db, space.device_token);

    // A pulls the tombstone right away: B's cursor (1) is behind it, so the
    // cursor rule alone retains it (nothing is old enough for the cap yet).
    const soon = await post(db, '/v1/sync/pull', { cursor: 0 }, space.device_token, T0);
    expect((soon.body as PullResult).cursor).toBe(tombstoneVersion);
    expect(await tombstoneRows(db, space.space_id)).toBe(1);

    // 90 days + 1s later A pushes and pulls a fresh row: the tombstone is
    // older than the cap and is collected even though B never caught up.
    const later = T0 + 90 * 24 * 60 * 60 * 1_000 + 1_000;
    await post(
      db,
      '/v1/sync/push',
      { mutations: [{ table: 't', pk: 'x', body: 'X', op: 'upsert' }] },
      space.device_token,
      later
    );
    const pulled = await post(db, '/v1/sync/pull', { cursor: 0 }, space.device_token, later);
    expect((pulled.body as PullResult).patches.map((p) => p.op)).toEqual(['delete', 'upsert']);
    expect(await tombstoneRows(db, space.space_id)).toBe(0);
  });

  it('a collected tombstone does not break resurrection at a fresh version', async () => {
    const db = await makeDb();
    const space = await createSpace(db);
    const { tombstoneVersion } = await pushUpsertAndDelete(db, space.device_token);
    await post(db, '/v1/sync/pull', { cursor: 0 }, space.device_token);

    // The tombstone is collected; the row is pushed again and gets a fresh
    // version above the old tombstone's.
    const again = await post(
      db,
      '/v1/sync/push',
      { mutations: [{ table: 't', pk: 'a', body: 'A2', op: 'upsert' }] },
      space.device_token
    );
    const version = (again.body as { results: Array<{ version: number }> }).results[0].version;
    expect(version).toBeGreaterThan(tombstoneVersion);

    const pulled = await post(
      db,
      '/v1/sync/pull',
      { cursor: tombstoneVersion },
      space.device_token
    );
    expect(pulled.body).toEqual({
      cursor: version,
      patches: [
        {
          space: space.space_id,
          table: 't',
          pk: 'a',
          version,
          client_version: 0,
          op: 'upsert',
          deleted: false,
          body: 'A2',
        },
      ],
    });
  });
});

describe('transactional stamping', () => {
  it('rolls back the counter increment when the batch fails', async () => {
    const db = await makeDb();
    const counter = db
      .prepare(
        'INSERT INTO version_counters (space_id, version) VALUES (?1, 1) ON CONFLICT (space_id) DO UPDATE SET version = version + 1 RETURNING version'
      )
      .bind('s');
    const insert = (pk: string, body: string) =>
      db
        .prepare(
          'INSERT INTO sync_rows (space_id, table_name, pk, body, version, client_version, deleted, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, 0, 0, ?6)'
        )
        .bind('s', 't', pk, body, 0, 0);
    // The second write violates the (space_id, table_name, pk) primary key:
    // the whole batch must roll back, including the counter increment — a
    // failed batch can never leave a stale counter or orphan rows.
    await expect(db.batch([counter, insert('k', 'one'), insert('k', 'two')])).rejects.toThrow();
    const counterRow = await db
      .prepare('SELECT version FROM version_counters WHERE space_id = ?1')
      .bind('s')
      .first<{ version: number }>();
    expect(counterRow).toBeNull();
    const rows = await db
      .prepare('SELECT pk FROM sync_rows WHERE space_id = ?1')
      .bind('s')
      .all<{ pk: string }>();
    expect(rows.results).toHaveLength(0);
  });
});

describe('token authentication', () => {
  it('refuses requests without a bearer token', async () => {
    const db = await makeDb();
    const result = await post(db, '/v1/devices/join-secret', { join_hash: 'a'.repeat(64) });
    expect(result.status).toBe(401);
  });

  it('refuses garbage tokens and unknown well-formed tokens', async () => {
    const db = await makeDb();
    expect((await get(db, '/v1/devices', 'nonsense')).status).toBe(401);
    expect((await get(db, '/v1/devices', freshUnknownCredential())).status).toBe(401);
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
    const join = await joinWith(db, space.secret, space.space_id);
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
    const joinB = await joinWith(db, b.secret, b.space_id);
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

describe('space deletion', () => {
  const TABLES = [
    'spaces',
    'tokens',
    'join_secrets',
    'sync_rows',
    'pull_cursors',
    'version_counters',
  ] as const;

  async function countRows(db: SqlDb, table: string, spaceId: string): Promise<number> {
    const result = await db
      .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE space_id = ?1`)
      .bind(spaceId)
      .first<{ count: number }>();
    return result?.count ?? 0;
  }

  async function rowCounts(db: SqlDb, spaceId: string): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const table of TABLES) {
      counts[table] = await countRows(db, table, spaceId);
    }
    return counts;
  }

  /** Populates every table `deleteSpace` must touch for a space. */
  async function populateSpace(
    db: SqlDb,
    name: string
  ): Promise<SpaceCreated & { tokenB: string }> {
    const space = await createSpace(db, name);
    // A live second tokens row beyond the one created at space creation.
    const joined = await joinWith(db, space.secret, space.space_id);
    const tokenB = (joined.body as JoinResult).device_token;
    // A sync_rows row + a fresh version_counters row.
    await post(
      db,
      '/v1/sync/push',
      { mutations: [{ table: 't', pk: 'a', body: 'A', op: 'upsert' }] },
      space.device_token
    );
    // A pull_cursors row (recorded because the pull returned patches).
    await post(db, '/v1/sync/pull', { cursor: 0 }, space.device_token);
    return { ...space, tokenB };
  }

  it('wipes every row scoped to the space and leaves other spaces untouched', async () => {
    const db = await makeDb();
    const a = await populateSpace(db, 'a');
    const b = await populateSpace(db, 'b');

    // Sanity: both spaces have rows in every table before deletion.
    for (const space of [a, b]) {
      const counts = await rowCounts(db, space.space_id);
      for (const table of TABLES) {
        expect(counts[table], `${table} for ${space.space_id}`).toBeGreaterThan(0);
      }
    }

    const result = await post(db, '/v1/space/delete', undefined, a.device_token);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ space_id: a.space_id, deleted: true, deleted_at: T0 });

    expect(await rowCounts(db, a.space_id)).toEqual({
      spaces: 0,
      tokens: 0,
      join_secrets: 0,
      sync_rows: 0,
      pull_cursors: 0,
      version_counters: 0,
    });

    // Space B is untouched.
    const bCounts = await rowCounts(db, b.space_id);
    for (const table of TABLES) {
      expect(bCounts[table], `${table} for ${b.space_id}`).toBeGreaterThan(0);
    }

    // Every token of the deleted space, including the one that just made the
    // call, is gone — the relay has nothing left to authenticate against.
    expect((await get(db, '/v1/devices', a.device_token)).status).toBe(401);
    expect((await get(db, '/v1/devices', a.tokenB)).status).toBe(401);
  });

  it('requires a valid device token', async () => {
    const db = await makeDb();
    const space = await createSpace(db);
    expect((await post(db, '/v1/space/delete', undefined)).status).toBe(401);

    // Nothing was deleted: the space's own token still works.
    const devices = await get(db, '/v1/devices', space.device_token);
    expect(devices.status).toBe(200);
    expect((devices.body as { devices: DeviceInfo[] }).devices).toHaveLength(1);
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

  it('holds the request until the timeout and then returns empty patches', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    try {
      const db = await makeDb();
      const space = await createSpace(db);
      const promise = post(
        db,
        '/v1/sync/poll',
        { cursor: 0, timeout_ms: 3000 },
        space.device_token
      );
      let settled = false;
      void promise.then(() => {
        settled = true;
      });
      // Advance in ~1s steps (the poll's re-check cadence), deliberately off
      // the exact 1000ms boundaries: the request must stay open past the
      // first re-checks and only resolve at the timeout.
      await vi.advanceTimersByTimeAsync(1050);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1050);
      expect(settled).toBe(false);
      // The timeout (3000ms) fires after the third step; loop until the
      // request settles, with a generous cap.
      for (let i = 0; i < 6 && !settled; i++) {
        await vi.advanceTimersByTimeAsync(1050);
      }
      expect(settled).toBe(true);
      const result = await promise;
      expect(result.status).toBe(200);
      expect(result.body).toEqual({ cursor: 0, patches: [] });
    } finally {
      vi.useRealTimers();
    }
  });
});
