/**
 * sync_row_state / sync_tombstones access (spec #130, ticket #133).
 *
 * The tables are engine-internal (migration 0026); no app code reads them.
 * `pk` is the JSON-encoded primary key (a single string for single-key
 * tables, a JSON array string for composite keys — matching the json_array()
 * encoding used by the deletion triggers).
 */
import type BetterSqlite3 from 'better-sqlite3';

/**
 * Sentinel `client_version` meaning "this row has never been through a
 * genuine pulled-patch apply" — distinct from the real value 0, which a
 * genuine first-ever sync of a row legitimately carries (see
 * transport.ts's `client_version`). Row-state rows created purely by a
 * push-ack (this machine's own edit, never a received patch — see
 * `upsertRowState`'s `null` clientVersion) are stamped with this sentinel on
 * first insert; two machines independently pushing the very same
 * never-before-synced row would otherwise BOTH default to the real value 0
 * via their own push-acks, and the anti-replay guard in engine.ts's
 * `applyPatch` would then misread the other machine's genuinely newer edit
 * as a replay of "the same" client_version 0.
 */
export const NEVER_PULLED_CLIENT_VERSION = -1;

export interface RowState {
  serverVersion: number;
  dirty: boolean;
  rowSyncTs: number;
  /**
   * The client_version of the last PULLED patch actually processed for this
   * row (migration 0029, anti-replay hardening), or
   * `NEVER_PULLED_CLIENT_VERSION` if this row has only ever been pushed, not
   * pulled.
   */
  clientVersion: number;
  /**
   * The relay `version` of a pulled patch whose body could not be decrypted
   * with a key-related (retryable) failure (migration 0030, decrypt-failure
   * quarantine), or 0 when the row is not quarantined. Unlike a permanent
   * decrypt failure, a quarantined row's `serverVersion` is deliberately NOT
   * advanced, so the engine re-attempts it (by rewinding the pull cursor to
   * the quarantine floor) once the space key changes. Cleared back to 0 the
   * moment any patch for the row decrypts successfully.
   */
  quarantinedVersion: number;
}

export interface TombstoneEntry {
  table: string;
  pk: string;
  createdAt: number;
}

export function encodePk(keyValues: unknown[]): string {
  return keyValues.length === 1 ? String(keyValues[0]) : JSON.stringify(keyValues);
}

export function getRowState(
  sqlite: BetterSqlite3.Database,
  table: string,
  pk: string
): RowState | null {
  const row = sqlite
    .prepare(
      'SELECT server_version, dirty, row_sync_ts, client_version, quarantined_version FROM sync_row_state WHERE table_name = ? AND pk = ?'
    )
    .get(table, pk) as
    | {
        server_version: number;
        dirty: number;
        row_sync_ts: number;
        client_version: number;
        quarantined_version: number;
      }
    | undefined;
  if (row === undefined) return null;
  return {
    serverVersion: row.server_version,
    dirty: row.dirty === 1,
    rowSyncTs: row.row_sync_ts,
    clientVersion: row.client_version,
    quarantinedVersion: row.quarantined_version,
  };
}

export function upsertRowState(
  sqlite: BetterSqlite3.Database,
  table: string,
  pk: string,
  serverVersion: number,
  dirty: boolean,
  rowSyncTs: number,
  /**
   * The client_version to record, or `null` to leave the row's existing
   * client_version untouched. Push-acks (this machine's own edit being
   * confirmed, not a pulled patch) always pass `null`: resetting it would
   * lower the replay-guard's baseline and reopen the window the guard closes.
   * A genuine pulled-patch apply (or the replay guard's own bookkeeping
   * update) passes the patch's real client_version.
   */
  clientVersion: number | null
): void {
  sqlite
    .prepare(
      `INSERT INTO sync_row_state (table_name, pk, server_version, dirty, row_sync_ts, client_version)
       VALUES (?, ?, ?, ?, ?, COALESCE(?, ${NEVER_PULLED_CLIENT_VERSION}))
       ON CONFLICT (table_name, pk) DO UPDATE SET
         server_version = excluded.server_version,
         dirty = excluded.dirty,
         row_sync_ts = excluded.row_sync_ts,
         client_version = COALESCE(?, sync_row_state.client_version)`
    )
    .run(table, pk, serverVersion, dirty ? 1 : 0, rowSyncTs, clientVersion, clientVersion);
}

/**
 * Marks a row as quarantined at `quarantinedVersion` (the relay version of the
 * patch that failed to decrypt with a retryable, key-related error). Migration
 * 0030, decrypt-failure quarantine.
 *
 * Deliberately never advances `server_version` or touches `client_version`: a
 * quarantined patch was never applied, so its version must NOT be recorded as
 * seen — otherwise the seen-check in `applyPatch` would skip it forever and the
 * cursor-rewind retry could never re-attempt it. A brand-new row-state row is
 * created with `client_version = NEVER_PULLED_CLIENT_VERSION` (this row has
 * never been through a genuine pulled apply).
 */
export function quarantineRow(
  sqlite: BetterSqlite3.Database,
  table: string,
  pk: string,
  quarantinedVersion: number
): void {
  sqlite
    .prepare(
      `INSERT INTO sync_row_state (table_name, pk, server_version, dirty, row_sync_ts, client_version, quarantined_version)
       VALUES (?, ?, 0, 0, 0, ${NEVER_PULLED_CLIENT_VERSION}, ?)
       ON CONFLICT (table_name, pk) DO UPDATE SET quarantined_version = excluded.quarantined_version`
    )
    .run(table, pk, quarantinedVersion);
}

/** Clears a row's quarantine flag (a later patch for it decrypted cleanly). */
export function clearQuarantine(sqlite: BetterSqlite3.Database, table: string, pk: string): void {
  sqlite
    .prepare('UPDATE sync_row_state SET quarantined_version = 0 WHERE table_name = ? AND pk = ?')
    .run(table, pk);
}

/**
 * The lowest relay version among all quarantined rows, or `null` if none are
 * quarantined. The engine rewinds the pull cursor to just below this so every
 * quarantined patch is re-fetched and re-attempted.
 */
export function quarantineFloor(sqlite: BetterSqlite3.Database): number | null {
  const row = sqlite
    .prepare(
      'SELECT MIN(quarantined_version) AS floor FROM sync_row_state WHERE quarantined_version > 0'
    )
    .get() as { floor: number | null };
  return row.floor;
}

/** How many rows are currently quarantined (surfaced in SyncStatus). */
export function countQuarantined(sqlite: BetterSqlite3.Database): number {
  const row = sqlite
    .prepare('SELECT COUNT(*) AS count FROM sync_row_state WHERE quarantined_version > 0')
    .get() as { count: number };
  return row.count;
}

export function listTombstones(sqlite: BetterSqlite3.Database): TombstoneEntry[] {
  const rows = sqlite.prepare('SELECT table_name, pk, created_at FROM sync_tombstones').all() as {
    table_name: string;
    pk: string;
    created_at: number;
  }[];
  return rows.map((row) => ({ table: row.table_name, pk: row.pk, createdAt: row.created_at }));
}

export function deleteTombstones(
  sqlite: BetterSqlite3.Database,
  entries: Array<{ table: string; pk: string }>
): void {
  if (entries.length === 0) return;
  const stmt = sqlite.prepare('DELETE FROM sync_tombstones WHERE table_name = ? AND pk = ?');
  for (const entry of entries) {
    stmt.run(entry.table, entry.pk);
  }
}
