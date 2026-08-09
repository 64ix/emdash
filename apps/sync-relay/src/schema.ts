/**
 * D1 schema for the relay.
 *
 * The relay stores plaintext metadata only: row bodies are opaque, encrypted
 * payloads that it never parses. Tables are created idempotently at worker
 * startup (`CREATE TABLE IF NOT EXISTS`) so a fresh deployment heals itself;
 * there is no separate migration step.
 *
 * - `spaces`: one row per private space.
 * - `tokens`: device credentials. Only SHA-256 of the device token is stored;
 *   a token is scoped to exactly one space. Revocation sets `revoked_at` and
 *   keeps the row for audit ("revoke token", not "remove device").
 * - `join_secrets`: pending pairing secrets. Stored as SHA-256 only,
 *   single-use (`used_at`), TTL-bounded (`expires_at`), and attempt-limited
 *   (`attempts_left`).
 * - `sync_rows`: generic KV rows keyed by (space, table, pk). `version` is the
 *   per-space monotonic version stamped transactionally at write time;
 *   tombstones are rows with `deleted = 1`.
 * - `version_counters`: the per-space monotonic counter, incremented with
 *   `version = version + 1 RETURNING version` in the same transaction as the
 *   row write (see `store.stampAndWriteRow`). No client timestamps, no bare
 *   AUTOINCREMENT ordering.
 */
import type { SqlDb } from './db';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS spaces (
  space_id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tokens (
  id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  device_name TEXT NOT NULL,
  sha256 TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tokens_space_id ON tokens(space_id);

CREATE TABLE IF NOT EXISTS join_secrets (
  secret_id TEXT PRIMARY KEY,
  space_id TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts_left INTEGER NOT NULL,
  used_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_join_secrets_space_id ON join_secrets(space_id);

CREATE TABLE IF NOT EXISTS sync_rows (
  space_id TEXT NOT NULL,
  table_name TEXT NOT NULL,
  pk TEXT NOT NULL,
  body TEXT,
  version INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (space_id, table_name, pk)
);
CREATE INDEX IF NOT EXISTS idx_sync_rows_space_version ON sync_rows(space_id, version);

CREATE TABLE IF NOT EXISTS version_counters (
  space_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL DEFAULT 0
);
`;

export async function ensureSchema(db: SqlDb): Promise<void> {
  await db.exec(SCHEMA_SQL);
}
