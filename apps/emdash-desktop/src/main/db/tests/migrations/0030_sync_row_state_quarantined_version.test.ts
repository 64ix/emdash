/**
 * Migration 0030 (spec #130 amendment, decrypt-failure quarantine):
 * `sync_row_state.quarantined_version` — the relay version of a pulled patch
 * whose body could not be decrypted with a retryable, key-related failure (the
 * row is encrypted under a space key this machine does not hold yet). The
 * engine (engine.ts's `applyPatch`) parks such a patch here WITHOUT advancing
 * `server_version`, and re-attempts it by rewinding the pull cursor once the
 * space key changes — see the quarantine helpers in row-state.ts.
 *
 * A plain `ALTER TABLE ... ADD COLUMN quarantined_version integer DEFAULT 0 NOT
 * NULL` — no table rebuild, so no FK/index recreation to verify.
 * `sync_row_state` is an engine-internal bookkeeping table (migration 0026)
 * that no seed populates, so there is nothing to backfill; the column's
 * DEFAULT is what existing rows written before this migration would read as.
 */
import { openFixture } from '@tooling/utils/db';
import { afterEach, describe, expect, it } from 'vitest';

describe('0030 sync_row_state.quarantined_version', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  afterEach(() => {
    fixture?.close();
  });

  it('adds quarantined_version as INTEGER NOT NULL DEFAULT 0', async () => {
    fixture = await openFixture('pre-0030');

    const cols = fixture.sqlite.prepare('PRAGMA table_info(sync_row_state)').all() as {
      name: string;
      type: string;
      dflt_value: string | null;
      notnull: number;
    }[];
    const quarantined = cols.find((c) => c.name === 'quarantined_version');
    expect(quarantined).toBeDefined();
    expect(quarantined?.type.toLowerCase()).toBe('integer');
    expect(quarantined?.dflt_value).toBe('0');
    expect(quarantined?.notnull).toBe(1);
  });

  it('preserves the client_version column added by 0029 (no rebuild, no drop)', async () => {
    fixture = await openFixture('pre-0030');

    const cols = fixture.sqlite.prepare('PRAGMA table_info(sync_row_state)').all() as {
      name: string;
    }[];
    const names = cols.map((c) => c.name);
    // The full column set through 0030 — a rebuild that dropped any of these
    // would be caught here.
    expect(names).toEqual([
      'table_name',
      'pk',
      'server_version',
      'dirty',
      'row_sync_ts',
      'client_version',
      'quarantined_version',
    ]);
  });

  it('defaults to 0 for a row inserted with the pre-migration column set', async () => {
    fixture = await openFixture('pre-0030');

    // Simulates a row written by a build that predates this migration: only the
    // pre-0030 columns are supplied, so quarantined_version falls back to its
    // DEFAULT rather than erroring as NOT NULL with no value.
    fixture.sqlite
      .prepare(
        `INSERT INTO sync_row_state (table_name, pk, server_version, dirty, row_sync_ts, client_version)
         VALUES ('tasks', 'task-1', 3, 0, 100, 2)`
      )
      .run();

    const row = fixture.sqlite
      .prepare('SELECT quarantined_version FROM sync_row_state WHERE table_name = ? AND pk = ?')
      .get('tasks', 'task-1') as { quarantined_version: number };
    expect(row.quarantined_version).toBe(0);
  });

  it('round-trips an explicit quarantined_version and clears it via UPDATE', async () => {
    fixture = await openFixture('pre-0030');

    // The engine's quarantineRow() path: park a never-applied row at a relay
    // version with server_version left at 0.
    fixture.sqlite
      .prepare(
        `INSERT INTO sync_row_state (table_name, pk, server_version, dirty, row_sync_ts, client_version, quarantined_version)
         VALUES ('tasks', 'task-2', 0, 0, 0, -1, 7)`
      )
      .run();

    let row = fixture.sqlite
      .prepare(
        'SELECT server_version, quarantined_version FROM sync_row_state WHERE table_name = ? AND pk = ?'
      )
      .get('tasks', 'task-2') as { server_version: number; quarantined_version: number };
    expect(row.server_version).toBe(0);
    expect(row.quarantined_version).toBe(7);

    // clearQuarantine()'s UPDATE path once a later patch decrypts.
    fixture.sqlite
      .prepare('UPDATE sync_row_state SET quarantined_version = 0 WHERE table_name = ? AND pk = ?')
      .run('tasks', 'task-2');

    row = fixture.sqlite
      .prepare(
        'SELECT server_version, quarantined_version FROM sync_row_state WHERE table_name = ? AND pk = ?'
      )
      .get('tasks', 'task-2') as { server_version: number; quarantined_version: number };
    expect(row.quarantined_version).toBe(0);
  });
});
