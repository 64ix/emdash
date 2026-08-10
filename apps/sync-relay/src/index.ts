/**
 * Sync relay worker entry.
 *
 * Routes requests, authenticates bearer device tokens, and translates
 * `ApiError`s into HTTP responses. The request handling is exported as
 * `handle(request, db, now)` so tests can drive the full HTTP surface against
 * an in-process D1-compatible harness; `now` is injected for deterministic
 * pairing/audit timestamps.
 */
import { constantTimeEqual, parseToken, sha256Bytes, sha256Hex } from './crypto';
import type { SqlDb } from './db';
import { ensureSchema } from './schema';
import {
  ApiError,
  createSpace,
  deleteSpace,
  join,
  listDevices,
  mintJoinSecret,
  poll,
  pull,
  push,
  revokeDevice,
} from './service';
import type { AuthContext } from './service';
import type {
  CreateSpaceRequest,
  ErrorResult,
  JoinRequest,
  PullRequest,
  PushRequest,
  PollRequest,
  RevokeRequest,
} from './types';

export interface RelayEnv {
  SYNC_RELAY_DB: D1Database;
  /** Pre-shared gate key (set with `wrangler secret put RELAY_KEY`). Every
   * request must present it as `X-Relay-Key`; this is what stops a stranger
   * who discovers the public URL from creating spaces or pushing data and
   * burning the operator's free-tier quota. Required in production — the
   * `fetch` entry point refuses to serve without it. */
  RELAY_KEY?: string;
}

const JSON_HEADERS = { 'content-type': 'application/json' };

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

async function readJson(request: Request): Promise<unknown> {
  try {
    const text = await request.text();
    const parsed = text.length === 0 ? {} : JSON.parse(text);
    // `null` and JSON primitives cannot be valid request bodies for any
    // endpoint; normalize them to 400 instead of letting service code
    // crash with a TypeError (which would surface as a 500).
    if (parsed === null || typeof parsed !== 'object') {
      throw new ApiError(400, 'request body must be a JSON object');
    }
    return parsed;
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    throw new ApiError(400, 'invalid JSON body');
  }
}

/**
 * Authenticates the bearer device token: validates the token format and its
 * constant-time checksum, hashes it with SHA-256, looks the digest up, and
 * refuses revoked tokens. The authenticated space is always the token's own
 * space — every request is scoped to it.
 */
async function authenticate(db: SqlDb, request: Request, now: number): Promise<AuthContext | null> {
  const header = request.headers.get('authorization') ?? '';
  const match = /^Bearer\s+(\S+)$/.exec(header);
  if (match === null) {
    return null;
  }
  const token = match[1];
  const parsed = await parseToken(token);
  if (!parsed.ok) {
    return null;
  }
  const digest = await sha256Hex(token);
  const row = await db
    .prepare('SELECT id, space_id, revoked_at FROM tokens WHERE sha256 = ?1 LIMIT 1')
    .bind(digest)
    .first<{ id: string; space_id: string; revoked_at: number | null }>();
  if (row === null || row.revoked_at !== null) {
    return null;
  }
  await db.prepare('UPDATE tokens SET last_seen_at = ?1 WHERE id = ?2').bind(now, row.id).run();
  return { spaceId: row.space_id, tokenId: row.id };
}

const KNOWN_PATHS = new Set([
  '/v1/space',
  '/v1/space/delete',
  '/v1/join',
  '/v1/devices',
  '/v1/devices/join-secret',
  '/v1/devices/revoke',
  '/v1/sync/pull',
  '/v1/sync/push',
  '/v1/sync/poll',
]);

export async function handle(
  request: Request,
  db: SqlDb,
  now: number,
  relayKey?: string
): Promise<Response> {
  const { pathname } = new URL(request.url);
  try {
    // Pre-shared gate: when the operator configured a RELAY_KEY, every request
    // — including the unauthenticated space/join endpoints — must present a
    // matching `X-Relay-Key`. Compared over SHA-256 digests in constant time
    // (fixed length, no early-exit) so neither the key's length nor a prefix
    // leaks. Checked before routing so an unconfigured caller learns nothing
    // about which paths exist.
    if (relayKey !== undefined && relayKey !== '') {
      const presented = request.headers.get('x-relay-key') ?? '';
      const [a, b] = await Promise.all([sha256Bytes(presented), sha256Bytes(relayKey)]);
      if (!constantTimeEqual(a, b)) {
        return json({ error: 'unauthorized' } satisfies ErrorResult, 401);
      }
    }

    if (!KNOWN_PATHS.has(pathname)) {
      return json({ error: 'not_found' } satisfies ErrorResult, 404);
    }

    if (request.method === 'POST' && pathname === '/v1/space') {
      const body = (await readJson(request)) as CreateSpaceRequest;
      return json(await createSpace(db, body, now));
    }

    if (request.method === 'POST' && pathname === '/v1/join') {
      const body = (await readJson(request)) as JoinRequest;
      return json(await join(db, body, now));
    }

    const auth = await authenticate(db, request, now);
    if (auth === null) {
      return json({ error: 'unauthorized' } satisfies ErrorResult, 401);
    }

    if (request.method === 'POST' && pathname === '/v1/space/delete') {
      return json(await deleteSpace(db, auth, now));
    }
    if (request.method === 'POST' && pathname === '/v1/devices/join-secret') {
      const body = (await readJson(request)) as { join_hash?: unknown };
      return json(await mintJoinSecret(db, auth, body, now));
    }
    if (request.method === 'GET' && pathname === '/v1/devices') {
      return json(await listDevices(db, auth));
    }
    if (request.method === 'POST' && pathname === '/v1/devices/revoke') {
      const body = (await readJson(request)) as RevokeRequest;
      return json(await revokeDevice(db, auth, body, now));
    }
    if (request.method === 'POST' && pathname === '/v1/sync/pull') {
      const body = (await readJson(request)) as PullRequest;
      return json(await pull(db, auth, body, now));
    }
    if (request.method === 'POST' && pathname === '/v1/sync/push') {
      const body = (await readJson(request)) as PushRequest;
      return json(await push(db, auth, body, now));
    }
    if (request.method === 'POST' && pathname === '/v1/sync/poll') {
      const body = (await readJson(request)) as PollRequest;
      return json(await poll(db, auth, body, now));
    }

    return json({ error: 'not_found' } satisfies ErrorResult, 404);
  } catch (error) {
    if (error instanceof ApiError) {
      return json({ error: error.message } satisfies ErrorResult, error.status);
    }
    console.error('sync relay internal error', error);
    return json({ error: 'internal_error' } satisfies ErrorResult, 500);
  }
}

/** Schema bootstrap is idempotent; run it once per isolate. */
let schemaReady: Promise<void> | null = null;

function withSchema(db: SqlDb): Promise<void> {
  if (schemaReady === null) {
    schemaReady = ensureSchema(db);
  }
  return schemaReady;
}

export default {
  async fetch(request: Request, env: RelayEnv): Promise<Response> {
    // Fail closed: a deployment with no RELAY_KEY is ungated and would let
    // anyone who finds the URL burn the operator's quota. Refuse to serve
    // rather than run open. Set it with `wrangler secret put RELAY_KEY`.
    if (env.RELAY_KEY === undefined || env.RELAY_KEY === '') {
      return json(
        { error: 'relay_misconfigured: RELAY_KEY is not set' } satisfies ErrorResult,
        500
      );
    }
    await withSchema(env.SYNC_RELAY_DB);
    return handle(request, env.SYNC_RELAY_DB, Date.now(), env.RELAY_KEY);
  },
};
