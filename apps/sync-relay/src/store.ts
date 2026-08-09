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

export function consumeJoinSecret(db: SqlDb, secretId: string, now: number): Promise<SqlResult> {
  return db
    .prepare('UPDATE join_secrets SET used_at = ?1 WHERE secret_id = ?2')
    .bind(now, secretId)
    .run();
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
  now: number
): Promise<number> {
  const counter = db
    .prepare(
      'INSERT INTO version_counters (space_id, version) VALUES (?1, 1) ON CONFLICT (space_id) DO UPDATE SET version = version + 1 RETURNING version'
    )
    .bind(spaceId);
  const upsert = db
    .prepare(
      `INSERT INTO sync_rows (space_id, table_name, pk, body, version, deleted, updated_at)
       SELECT c.space_id, ?2, ?3, ?4, c.version, ?5, ?6
       FROM version_counters c
       WHERE c.space_id = ?1
       ON CONFLICT (space_id, table_name, pk) DO UPDATE SET
         body = excluded.body,
         version = excluded.version,
         deleted = excluded.deleted,
         updated_at = excluded.updated_at`
    )
    .bind(spaceId, table, pk, body, deleted ? 1 : 0, now);

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
      'SELECT space_id, table_name, pk, body, version, deleted, updated_at FROM sync_rows WHERE space_id = ?1 AND version > ?2 ORDER BY version ASC LIMIT ?3'
    )
    .bind(spaceId, cursor, limit)
    .all<SyncRow>();
  return result.results;
}
