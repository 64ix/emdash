/**
 * Data access layer: the only place that touches SQL.
 *
 * Row bodies are stored and returned verbatim; no query ever filters on or
 * interprets `body`, and the service layer never parses it. Metadata queries
 * are the only kind this module issues.
 */
import type { SqlDb, SqlResult } from './db';

export interface TokenRow {
  id: string;
  space_id: string;
  device_id: string;
  device_name: string;
  sha256: string;
  created_at: number;
  last_seen_at: number | null;
  revoked_at: number | null;
}

export interface JoinSecretRow {
  secret_id: string;
  space_id: string;
  sha256: string;
  created_at: number;
  expires_at: number;
  attempts_left: number;
  used_at: number | null;
}

export interface SyncRow {
  space_id: string;
  table_name: string;
  pk: string;
  body: string | null;
  version: number;
  client_version: number;
  deleted: number;
  updated_at: number;
}

// ---------------------------------------------------------------------------
// Spaces and tokens
// ---------------------------------------------------------------------------

export function insertSpace(db: SqlDb, spaceId: string, now: number): Promise<SqlResult> {
  return db
    .prepare('INSERT INTO spaces (space_id, created_at) VALUES (?1, ?2)')
    .bind(spaceId, now)
    .run();
}

export function insertToken(
  db: SqlDb,
  token: {
    id: string;
    space_id: string;
    device_id: string;
    device_name: string;
    sha256: string;
    created_at: number;
  }
): Promise<SqlResult> {
  return db
    .prepare(
      'INSERT INTO tokens (id, space_id, device_id, device_name, sha256, created_at, last_seen_at, revoked_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, NULL)'
    )
    .bind(
      token.id,
      token.space_id,
      token.device_id,
      token.device_name,
      token.sha256,
      token.created_at
    )
    .run();
}

export async function findTokenBySha256(db: SqlDb, sha256: string): Promise<TokenRow | null> {
  return db
    .prepare(
      'SELECT id, space_id, device_id, device_name, sha256, created_at, last_seen_at, revoked_at FROM tokens WHERE sha256 = ?1 LIMIT 1'
    )
    .bind(sha256)
    .first<TokenRow>();
}

export function touchToken(db: SqlDb, tokenId: string, now: number): Promise<SqlResult> {
  return db.prepare('UPDATE tokens SET last_seen_at = ?1 WHERE id = ?2').bind(now, tokenId).run();
}

export async function listTokens(db: SqlDb, spaceId: string): Promise<TokenRow[]> {
  const result = await db
    .prepare(
      'SELECT id, space_id, device_id, device_name, sha256, created_at, last_seen_at, revoked_at FROM tokens WHERE space_id = ?1 ORDER BY created_at ASC'
    )
    .bind(spaceId)
    .all<TokenRow>();
  return result.results;
}

export async function deviceExistsInSpace(
  db: SqlDb,
  spaceId: string,
  deviceId: string
): Promise<boolean> {
  const row = await db
    .prepare('SELECT device_id FROM tokens WHERE space_id = ?1 AND device_id = ?2 LIMIT 1')
    .bind(spaceId, deviceId)
    .first<{ device_id: string }>();
  return row !== null;
}

export function revokeDevice(
  db: SqlDb,
  spaceId: string,
  deviceId: string,
  now: number
): Promise<SqlResult> {
  return db
    .prepare(
      'UPDATE tokens SET revoked_at = ?1 WHERE space_id = ?2 AND device_id = ?3 AND revoked_at IS NULL'
    )
    .bind(now, spaceId, deviceId)
    .run();
}

// ---------------------------------------------------------------------------
// Pairing secrets
// ---------------------------------------------------------------------------

export function insertJoinSecret(
  db: SqlDb,
  secret: {
    secret_id: string;
    space_id: string;
    sha256: string;
    created_at: number;
    expires_at: number;
    attempts_left: number;
  }
): Promise<SqlResult> {
  return db
    .prepare(
      'INSERT INTO join_secrets (secret_id, space_id, sha256, created_at, expires_at, attempts_left, used_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL)'
    )
    .bind(
      secret.secret_id,
      secret.space_id,
      secret.sha256,
      secret.created_at,
      secret.expires_at,
      secret.attempts_left
    )
    .run();
}

/**
 * All join secrets of a space, oldest first. The join handler compares the
 * presented credential's digest against each stored digest with a
 * constant-time comparison; when nothing matches, the oldest pending secret
 * is charged one attempt.
 */
export async function listPendingJoinSecrets(db: SqlDb, spaceId: string): Promise<JoinSecretRow[]> {
  const result = await db
    .prepare(
      'SELECT secret_id, space_id, sha256, created_at, expires_at, attempts_left, used_at FROM join_secrets WHERE space_id = ?1 ORDER BY created_at ASC'
    )
    .bind(spaceId)
    .all<JoinSecretRow>();
  return result.results;
}

/**
 * Marks a join secret used, atomically. The `used_at IS NULL AND expires_at >
 * now AND attempts_left > 0` guard is the single-use gate: two interleaved
 * /v1/join round trips can both pass the earlier read-based staleness check,
 * but only the first UPDATE matches (and RETURNING yields a row); the loser
 * gets no row back and must not mint a token. Returns whether this call is the
 * one that consumed the secret.
 */
export async function consumeJoinSecret(
  db: SqlDb,
  secretId: string,
  now: number
): Promise<boolean> {
  const result = await db
    .prepare(
      'UPDATE join_secrets SET used_at = ?1 WHERE secret_id = ?2 AND used_at IS NULL AND expires_at > ?1 AND attempts_left > 0 RETURNING secret_id'
    )
    .bind(now, secretId)
    .run();
  return (result.results?.length ?? 0) > 0;
}

export async function decrementJoinSecretAttempts(db: SqlDb, secretId: string): Promise<number> {
  const result = await db
    .prepare(
      'UPDATE join_secrets SET attempts_left = attempts_left - 1 WHERE secret_id = ?1 RETURNING attempts_left'
    )
    .bind(secretId)
    .run();
  const row = result.results?.[0] as { attempts_left: number } | undefined;
  return row?.attempts_left ?? 0;
}

export function deleteJoinSecret(db: SqlDb, secretId: string): Promise<SqlResult> {
  return db.prepare('DELETE FROM join_secrets WHERE secret_id = ?1').bind(secretId).run();
}

// ---------------------------------------------------------------------------
// Sync rows and the per-space version counter
// ---------------------------------------------------------------------------

/**
 * Increments the space counter and writes the row in one transaction.
 *
 * The counter is bumped with `INSERT ... ON CONFLICT DO UPDATE SET version =
 * version + 1 RETURNING version` (a missing counter row self-heals), and the
 * row upsert reads the fresh counter value via `INSERT ... SELECT ... FROM
 * version_counters` — both statements run inside a single `db.batch()`, which
 * D1 executes as one transaction. Ordering therefore comes from the server's
 * receipt order, never from client timestamps or a detached counter.
 *
 * Returns the newly assigned version.
 */
export async function stampAndWriteRow(
  db: SqlDb,
  spaceId: string,
  table: string,
  pk: string,
  body: string | null,
  deleted: boolean,
  clientVersion: number,
  now: number
): Promise<number> {
  const counter = db
    .prepare(
      'INSERT INTO version_counters (space_id, version) VALUES (?1, 1) ON CONFLICT (space_id) DO UPDATE SET version = version + 1 RETURNING version'
    )
    .bind(spaceId);
  const upsert = db
    .prepare(
      `INSERT INTO sync_rows (space_id, table_name, pk, body, version, client_version, deleted, updated_at)
       SELECT c.space_id, ?2, ?3, ?4, c.version, ?5, ?6, ?7
       FROM version_counters c
       WHERE c.space_id = ?1
       ON CONFLICT (space_id, table_name, pk) DO UPDATE SET
         body = excluded.body,
         version = excluded.version,
         client_version = excluded.client_version,
         deleted = excluded.deleted,
         updated_at = excluded.updated_at`
    )
    .bind(spaceId, table, pk, body, clientVersion, deleted ? 1 : 0, now);

  const [counterResult] = await db.batch([counter, upsert]);
  const row = counterResult.results?.[0] as { version: number } | undefined;
  if (row === undefined) {
    throw new Error('version counter returned no version');
  }
  return row.version;
}

export async function pullRows(
  db: SqlDb,
  spaceId: string,
  cursor: number,
  limit: number
): Promise<SyncRow[]> {
  const result = await db
    .prepare(
      'SELECT space_id, table_name, pk, body, version, client_version, deleted, updated_at FROM sync_rows WHERE space_id = ?1 AND version > ?2 ORDER BY version ASC LIMIT ?3'
    )
    .bind(spaceId, cursor, limit)
    .all<SyncRow>();
  return result.results;
}

// ---------------------------------------------------------------------------
// Pull cursors and tombstone GC
// ---------------------------------------------------------------------------

/**
 * Records the version a device token has pulled up to. Only ever advances:
 * an older cursor (a stale retry of a previous pull) never rewinds the
 * stored value. Pull requests that return nothing leave the cursor alone.
 */
export function recordPullCursor(
  db: SqlDb,
  spaceId: string,
  tokenId: string,
  cursor: number,
  now: number
): Promise<SqlResult> {
  return db
    .prepare(
      `INSERT INTO pull_cursors (space_id, token_id, cursor, updated_at) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (space_id, token_id) DO UPDATE SET
         cursor = MAX(cursor, excluded.cursor),
         updated_at = excluded.updated_at`
    )
    .bind(spaceId, tokenId, cursor, now)
    .run();
}

/**
 * The smallest pull cursor across the space's non-revoked device tokens. A
 * token that has never pulled counts as `0` (it is behind everything), so a
 * space where any active device has no cursor row yields `0` and the age cap
 * alone decides. Revoked tokens are excluded: they will never pull again, so
 * their stale cursors must not block GC. `null` only when the space has no
 * non-revoked tokens at all.
 */
export async function minActivePullCursor(db: SqlDb, spaceId: string): Promise<number | null> {
  const row = await db
    .prepare(
      `SELECT MIN(COALESCE(c.cursor, 0)) AS min_cursor
       FROM tokens t
       LEFT JOIN pull_cursors c ON c.space_id = t.space_id AND c.token_id = t.id
       WHERE t.space_id = ?1 AND t.revoked_at IS NULL`
    )
    .bind(spaceId)
    .first<{ min_cursor: number | null }>();
  return row?.min_cursor ?? null;
}

/**
 * Hard-deletes tombstone rows (`deleted = 1`) that no active device will ever
 * pull again: their version is at or below the smallest active pull cursor
 * (a device that never pulled counts as 0 and blocks collection), or they are
 * older than the safety cap (a device that has not pulled in 90 days must not
 * block collection forever; if it returns, its local row remains and a later
 * edit simply resurrects the row at a fresh version).
 */
export async function gcTombstones(
  db: SqlDb,
  spaceId: string,
  now: number,
  capMs: number
): Promise<SqlResult> {
  return db
    .prepare(
      `DELETE FROM sync_rows
       WHERE space_id = ?1
         AND deleted = 1
         AND (
           version <= COALESCE((SELECT MIN(COALESCE(c.cursor, 0)) FROM tokens t LEFT JOIN pull_cursors c ON c.space_id = t.space_id AND c.token_id = t.id WHERE t.space_id = ?1 AND t.revoked_at IS NULL), 0)
           OR updated_at <= ?2
         )`
    )
    .bind(spaceId, now - capMs)
    .run();
}
