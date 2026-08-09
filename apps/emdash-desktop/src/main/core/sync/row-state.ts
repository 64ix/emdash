/**
 * sync_row_state / sync_tombstones access (spec #130, ticket #133).
 *
 * The tables are engine-internal (migration 0026); no app code reads them.
 * `pk` is the JSON-encoded primary key (a single string for single-key
 * tables, a JSON array string for composite keys — matching the json_array()
 * encoding used by the deletion triggers).
 */
import type BetterSqlite3 from 'better-sqlite3';

export interface RowState {
  serverVersion: number;
  dirty: boolean;
  rowSyncTs: number;
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
    .prepare('SELECT server_version, dirty, row_sync_ts FROM sync_row_state WHERE table_name = ? AND pk = ?')
    .get(table, pk) as { server_version: number; dirty: number; row_sync_ts: number } | undefined;
  if (row === undefined) return null;
  return { serverVersion: row.server_version, dirty: row.dirty === 1, rowSyncTs: row.row_sync_ts };
}

export function upsertRowState(
  sqlite: BetterSqlite3.Database,
  table: string,
  pk: string,
  serverVersion: number,
  dirty: boolean,
  rowSyncTs: number
): void {
  sqlite
    .prepare(
      `INSERT INTO sync_row_state (table_name, pk, server_version, dirty, row_sync_ts)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (table_name, pk) DO UPDATE SET
         server_version = excluded.server_version,
         dirty = excluded.dirty,
         row_sync_ts = excluded.row_sync_ts`
    )
    .run(table, pk, serverVersion, dirty ? 1 : 0, rowSyncTs);
}

export function listTombstones(sqlite: BetterSqlite3.Database): TombstoneEntry[] {
  const rows = sqlite
    .prepare('SELECT table_name, pk, created_at FROM sync_tombstones')
    .all() as { table_name: string; pk: string; created_at: number }[];
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
