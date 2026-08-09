/**
 * Protocol operations for the relay.
 *
 * Pure functions over the `SqlDb` seam: no framework dependencies, `now` is
 * injected so pairing TTL and audit timestamps are deterministic in tests.
 * Errors are thrown as `ApiError` and translated to HTTP responses by
 * `index.ts`. The only constants set here are the pairing policy: 15-minute
 * TTL and a per-secret attempt budget (enforced here, in the Worker — not via
 * Cloudflare rate-limit rules).
 */
import {
  constantTimeEqual,
  hexToBytes,
  isSpaceId,
  makeDeviceId,
  makeSpaceId,
  makeSpaceSecret,
  makeToken,
  parseJoinCredential,
  sha256Bytes,
  sha256Hex,
} from './crypto';
import type { SqlDb } from './db';
import * as store from './store';
import type {
  CreateSpaceRequest,
  DevicesResult,
  JoinRequest,
  JoinResult,
  JoinSecretResult,
  PollRequest,
  PullRequest,
  PullResult,
  PushRequest,
  PushResult,
  RevokeRequest,
  RevokeResult,
  SpaceCreated,
} from './types';

export const JOIN_SECRET_TTL_MS = 15 * 60_000;
export const MAX_JOIN_ATTEMPTS = 5;
export const PULL_LIMIT = 1000;
export const POLL_MAX_TIMEOUT_MS = 25_000;
/** Poll interval between D1 re-checks while holding a long-poll request. */
const POLL_INTERVAL_MS = 1_000;

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
  }
}

export interface AuthContext {
  spaceId: string;
  tokenId: string;
}

// ---------------------------------------------------------------------------
// Spaces and pairing
// ---------------------------------------------------------------------------

export async function createSpace(
  db: SqlDb,
  input: CreateSpaceRequest,
  now: number
): Promise<SpaceCreated> {
  const spaceId = makeSpaceId();
  const deviceId = makeDeviceId();
  const deviceName =
    typeof input.name === 'string' && input.name.trim() !== '' ? input.name.trim() : 'default';
  const token = await makeToken();
  // Two-half pairing secret: the join half transits to the relay only as
  // SHA-256; K0 (the space data key) never transits at all. The relay mints
  // both halves at space creation; later devices are minted client-side.
  const { secret, credential } = makeSpaceSecret(spaceId);
  const tokenSha = await sha256Hex(token);
  const secretSha = await sha256Hex(credential);

  await db.batch([
    db.prepare('INSERT INTO spaces (space_id, created_at) VALUES (?1, ?2)').bind(spaceId, now),
    db
      .prepare(
        'INSERT INTO tokens (id, space_id, device_id, device_name, sha256, created_at, last_seen_at, revoked_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, NULL)'
      )
      .bind(deviceId, spaceId, deviceId, deviceName, tokenSha, now),
    db
      .prepare(
        'INSERT INTO join_secrets (secret_id, space_id, sha256, created_at, expires_at, attempts_left, used_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL)'
      )
      .bind(deviceId, spaceId, secretSha, now, now + JOIN_SECRET_TTL_MS, MAX_JOIN_ATTEMPTS),
  ]);

  return { space_id: spaceId, device_id: deviceId, device_token: token, secret };
}

export async function join(db: SqlDb, input: JoinRequest, now: number): Promise<JoinResult> {
  if (typeof input.join_hash !== 'string' || typeof input.space_id !== 'string') {
    throw new ApiError(400, 'join_hash and space_id must be strings');
  }
  const parsed = parseJoinCredential(input.join_hash);
  if (!parsed.ok || !isSpaceId(input.space_id)) {
    throw new ApiError(401, 'invalid join secret');
  }

  // The relay stores only SHA-256 of the join credential; the match against
  // the presented credential is decided with a constant-time comparison of
  // the digests (never of the plaintext credential). The space id comes from
  // the request (the joining client extracts it from the pairing secret), so
  // a failed attempt is attributed to the pending secrets of that space.
  const presentedSha = await sha256Bytes(input.join_hash);
  const pending = await store.listPendingJoinSecrets(db, input.space_id);
  const matched =
    pending.find((secret) => constantTimeEqual(hexToBytes(secret.sha256), presentedSha)) ?? null;

  if (matched === null) {
    // Well-formed credential for this space that matches no stored secret:
    // charge the oldest pending secret's attempt budget (per-secret,
    // enforced in the Worker, not via Cloudflare rate-limit rules).
    const target = pending[0] ?? null;
    if (target !== null) {
      const attemptsLeft = await store.decrementJoinSecretAttempts(db, target.secret_id);
      if (attemptsLeft <= 0) {
        await store.deleteJoinSecret(db, target.secret_id);
      }
    }
    throw new ApiError(401, 'invalid join secret');
  }

  const stale = matched.used_at !== null || matched.expires_at <= now || matched.attempts_left <= 0;
  if (stale) {
    await store.deleteJoinSecret(db, matched.secret_id);
    throw new ApiError(401, 'invalid join secret');
  }

  await store.consumeJoinSecret(db, matched.secret_id, now);

  const deviceId = makeDeviceId();
  const token = await makeToken();
  const name =
    typeof input.name === 'string' && input.name.trim() !== '' ? input.name.trim() : 'device';
  await store.insertToken(db, {
    id: deviceId,
    space_id: input.space_id,
    device_id: deviceId,
    device_name: name,
    sha256: await sha256Hex(token),
    created_at: now,
  });

  return { device_id: deviceId, device_token: token, space_id: input.space_id };
}

/**
 * Registers a client-minted join credential for an additional device. The
 * authenticated device composes the pairing secret locally (a fresh join
 * half + the space's unchanged K0) and sends the SHA-256 digest of the join
 * credential; the relay stores only the digest, single-use/TTL/attempt
 * semantics unchanged. K0 never transits to the relay.
 */
export async function mintJoinSecret(
  db: SqlDb,
  auth: AuthContext,
  input: { join_hash?: unknown },
  now: number
): Promise<JoinSecretResult> {
  if (typeof input.join_hash !== 'string' || !/^[0-9a-f]{64}$/.test(input.join_hash)) {
    throw new ApiError(400, 'join_hash must be a 64-char sha256 hex digest');
  }
  await store.insertJoinSecret(db, {
    secret_id: makeDeviceId(),
    space_id: auth.spaceId,
    sha256: input.join_hash,
    created_at: now,
    expires_at: now + JOIN_SECRET_TTL_MS,
    attempts_left: MAX_JOIN_ATTEMPTS,
  });
  return { join_hash: input.join_hash };
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

export async function listDevices(db: SqlDb, auth: AuthContext): Promise<DevicesResult> {
  const tokens = await store.listTokens(db, auth.spaceId);
  return {
    devices: tokens.map((token) => ({
      device_id: token.device_id,
      name: token.device_name,
      created_at: token.created_at,
      last_seen_at: token.last_seen_at,
      revoked: token.revoked_at !== null,
      revoked_at: token.revoked_at,
      self: token.id === auth.tokenId,
    })),
  };
}

export async function revokeDevice(
  db: SqlDb,
  auth: AuthContext,
  input: RevokeRequest,
  now: number
): Promise<RevokeResult> {
  if (typeof input.device_id !== 'string' || input.device_id === '') {
    throw new ApiError(400, 'device_id must be a non-empty string');
  }
  const exists = await store.deviceExistsInSpace(db, auth.spaceId, input.device_id);
  if (!exists) {
    throw new ApiError(404, 'device not found in this space');
  }
  await store.revokeDevice(db, auth.spaceId, input.device_id, now);
  return { device_id: input.device_id, revoked: true };
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

function readCursor(input: { cursor?: unknown }): number {
  const cursor = input.cursor === undefined ? 0 : input.cursor;
  if (typeof cursor !== 'number' || !Number.isInteger(cursor) || cursor < 0) {
    throw new ApiError(400, 'cursor must be a non-negative integer');
  }
  return cursor;
}

function patchOf(row: store.SyncRow): PullResult['patches'][number] {
  return {
    space: row.space_id,
    table: row.table_name,
    pk: row.pk,
    version: row.version,
    client_version: row.client_version,
    op: row.deleted === 1 ? 'delete' : 'upsert',
    deleted: row.deleted === 1,
    body: row.body,
  };
}

export async function pull(db: SqlDb, auth: AuthContext, input: PullRequest): Promise<PullResult> {
  const cursor = readCursor(input);
  const limit = input.limit === undefined ? PULL_LIMIT : input.limit;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > PULL_LIMIT) {
    throw new ApiError(400, `limit must be an integer in [1, ${PULL_LIMIT}]`);
  }
  const rows = await store.pullRows(db, auth.spaceId, cursor, limit);
  const patches = rows.map(patchOf);
  const nextCursor = patches.length > 0 ? patches[patches.length - 1].version : cursor;
  return { cursor: nextCursor, patches };
}

function validateMutation(mutation: PushRequest['mutations'][number], index: number): void {
  if (typeof mutation !== 'object' || mutation === null) {
    throw new ApiError(400, `mutation ${index} is not an object`);
  }
  if (typeof mutation.table !== 'string' || mutation.table === '') {
    throw new ApiError(400, `mutation ${index}: table must be a non-empty string`);
  }
  if (typeof mutation.pk !== 'string' || mutation.pk === '') {
    throw new ApiError(400, `mutation ${index}: pk must be a non-empty string`);
  }
  if (mutation.op !== 'upsert' && mutation.op !== 'delete') {
    throw new ApiError(400, `mutation ${index}: op must be 'upsert' or 'delete'`);
  }
  if (mutation.op === 'upsert' && typeof mutation.body !== 'string') {
    throw new ApiError(400, `mutation ${index}: body is required for 'upsert'`);
  }
  if (
    mutation.op === 'delete' &&
    mutation.body !== undefined &&
    mutation.body !== null &&
    typeof mutation.body !== 'string'
  ) {
    throw new ApiError(400, `mutation ${index}: body must be a string or null for 'delete'`);
  }
  if (
    mutation.client_version !== undefined &&
    (typeof mutation.client_version !== 'number' ||
      !Number.isInteger(mutation.client_version) ||
      mutation.client_version < 0)
  ) {
    throw new ApiError(400, `mutation ${index}: client_version must be a non-negative integer`);
  }
}

export async function push(
  db: SqlDb,
  auth: AuthContext,
  input: PushRequest,
  now: number
): Promise<PushResult> {
  if (typeof input !== 'object' || input === null || !Array.isArray(input.mutations)) {
    throw new ApiError(400, 'mutations must be an array');
  }
  // Validate the whole batch before writing anything: a malformed push is
  // rejected as a whole, never partially applied.
  for (const [index, mutation] of input.mutations.entries()) {
    validateMutation(mutation, index);
  }

  const results: PushResult['results'] = [];
  for (const mutation of input.mutations) {
    // `body` is validated above: required for `upsert`, optional for `delete`.
    const body = mutation.body ?? null;
    const version = await store.stampAndWriteRow(
      db,
      auth.spaceId,
      mutation.table,
      mutation.pk,
      body,
      mutation.op === 'delete',
      mutation.client_version ?? 0,
      now
    );
    results.push({ table: mutation.table, pk: mutation.pk, version });
  }
  return { results };
}

export async function poll(db: SqlDb, auth: AuthContext, input: PollRequest): Promise<PullResult> {
  const cursor = readCursor(input);
  const timeoutMs = input.timeout_ms === undefined ? 20_000 : input.timeout_ms;
  if (typeof timeoutMs !== 'number' || Number.isNaN(timeoutMs)) {
    throw new ApiError(400, 'timeout_ms must be a number');
  }
  const timeout = Math.min(Math.max(0, Math.floor(timeoutMs)), POLL_MAX_TIMEOUT_MS);
  const start = Date.now();

  // Long-poll: hold the request, re-checking D1 on an interval, until either
  // patches arrive or the timeout elapses. Clients reconnect with backoff.
  for (;;) {
    const result = await pull(db, auth, { cursor, limit: PULL_LIMIT });
    const elapsed = Date.now() - start;
    if (result.patches.length > 0 || elapsed >= timeout) {
      return result;
    }
    await sleep(Math.min(POLL_INTERVAL_MS, timeout - elapsed));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
