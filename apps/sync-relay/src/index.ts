/**
 * Sync relay worker entry.
 *
 * Routes requests, authenticates bearer device tokens, and translates
 * `ApiError`s into HTTP responses. The request handling is exported as
 * `handle(request, db, now)` so tests can drive the full HTTP surface against
 * an in-process D1-compatible harness; `now` is injected for deterministic
 * pairing/audit timestamps.
 */
import { parseToken, sha256Hex } from './crypto';
import type { SqlDb } from './db';
import { ensureSchema } from './schema';
import {
  ApiError,
  createSpace,
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
}

const JSON_HEADERS = { 'content-type': 'application/json' };

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

async function readJson(request: Request): Promise<unknown> {
  try {
    const text = await request.text();
    return text.length === 0 ? {} : JSON.parse(text);
  } catch {
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
  '/v1/join',
  '/v1/devices',
  '/v1/devices/join-secret',
  '/v1/devices/revoke',
  '/v1/sync/pull',
  '/v1/sync/push',
  '/v1/sync/poll',
]);

export async function handle(request: Request, db: SqlDb, now: number): Promise<Response> {
  const { pathname } = new URL(request.url);
  try {
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

    if (request.method === 'POST' && pathname === '/v1/devices/join-secret') {
      return json(await mintJoinSecret(db, auth, now));
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
      return json(await pull(db, auth, body));
    }
    if (request.method === 'POST' && pathname === '/v1/sync/push') {
      const body = (await readJson(request)) as PushRequest;
      return json(await push(db, auth, body, now));
    }
    if (request.method === 'POST' && pathname === '/v1/sync/poll') {
      const body = (await readJson(request)) as PollRequest;
      return json(await poll(db, auth, body));
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
    await withSchema(env.SYNC_RELAY_DB);
    return handle(request, env.SYNC_RELAY_DB, Date.now());
  },
};
