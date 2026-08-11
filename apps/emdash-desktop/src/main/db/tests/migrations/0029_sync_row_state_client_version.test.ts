/**
 * Migration 0029 (spec #130 amendment, anti-replay hardening):
 * `sync_row_state.client_version` — the client_version of the last PULLED
 * patch actually processed for a row, used by the engine's replay guard
 * (engine.ts's `applyPatch`) to drop a patch whose client_version regresses
 * relative to what was already recorded, even though its server version is
 * newer.
 *
 * A plain `ALTER TABLE ... ADD COLUMN client_version integer DEFAULT 0 NOT
 * NULL` — no table rebuild, so no FK/index recreation to verify.
 * `sync_row_state` is an engine-internal bookkeeping table (migration 0026)
 * that no seed populates, so there is nothing to backfill; the column's
 * DEFAULT is what existing rows written before this migration would read as.
 */
import { openFixture } from '@tooling/utils/db';
import { afterEach, describe, expect, it } from 'vitest';

describe('0029 sync_row_state.client_version', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  afterEach(() => {
    fixture?.close();
  });

  it('adds client_version as INTEGER NOT NULL DEFAULT 0', async () => {
    fixture = await openFixture('pre-0029');

    const cols = fixture.sqlite.prepare('PRAGMA table_info(sync_row_state)').all() as {
      name: string;
      type: string;
      dflt_value: string | null;
      notnull: number;
    }[];
    const clientVersion = cols.find((c) => c.name === 'client_version');
    expect(clientVersion).toBeDefined();
    expect(clientVersion?.type.toLowerCase()).toBe('integer');
    expect(clientVersion?.dflt_value).toBe('0');
    expect(clientVersion?.notnull).toBe(1);
  });

  it('defaults to 0 for a row inserted with the pre-migration column set', async () => {
    fixture = await openFixture('pre-0029');

    // Simulates a row written by a build that predates this migration: only
    // the original 5 columns are supplied, so client_version falls back to
    // its DEFAULT rather than erroring as NOT NULL with no value.
    fixture.sqlite
      .prepare(
        `INSERT INTO sync_row_state (table_name, pk, server_version, dirty, row_sync_ts)
         VALUES ('tasks', 'task-1', 3, 0, 100)`
      )
      .run();

    const row = fixture.sqlite
      .prepare('SELECT client_version FROM sync_row_state WHERE table_name = ? AND pk = ?')
      .get('tasks', 'task-1') as { client_version: number };
    expect(row.client_version).toBe(0);
  });

  it('round-trips an explicit client_version and survives the upsert-on-conflict path', async () => {
    fixture = await openFixture('pre-0029');

    fixture.sqlite
      .prepare(
        `INSERT INTO sync_row_state (table_name, pk, server_version, dirty, row_sync_ts, client_version)
         VALUES ('tasks', 'task-2', 5, 0, 200, 4)`
      )
      .run();

    // The engine's upsertRowState() ON CONFLICT DO UPDATE path: bump
    // server_version and client_version together, as a genuine newer apply would.
    fixture.sqlite
      .prepare(
        `INSERT INTO sync_row_state (table_name, pk, server_version, dirty, row_sync_ts, client_version)
         VALUES ('tasks', 'task-2', 9, 0, 250, 7)
         ON CONFLICT (table_name, pk) DO UPDATE SET
           server_version = excluded.server_version,
           row_sync_ts = excluded.row_sync_ts,
           client_version = excluded.client_version`
      )
      .run();

    const row = fixture.sqlite
      .prepare(
        'SELECT server_version, client_version FROM sync_row_state WHERE table_name = ? AND pk = ?'
      )
      .get('tasks', 'task-2') as { server_version: number; client_version: number };
    expect(row.server_version).toBe(9);
    expect(row.client_version).toBe(7);
  });
});
