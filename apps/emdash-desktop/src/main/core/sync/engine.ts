import { err, ok, type Result } from '@emdash/shared';
/**
 * SyncEngine (spec #130, ticket #133): moves the portable allowlist of rows
 * between the local SQLite database and the relay, through an injectable
 * RelayTransport.
 *
 * Push detection uses the per-row sync clock (`sync_ts > lastPushed`, stamped
 * by AFTER INSERT/UPDATE triggers on genuine app writes) plus the
 * sync_row_state side table: a row whose clock matches the value recorded at
 * its last push-ack or remote apply is *not* a candidate — this is what breaks
 * the trigger re-stamp loop (an applied remote row must never be pushed back).
 *
 * Pull applies server-authoritative last-write-wins: a patch is applied only
 * when its server version is newer than the recorded one AND the local row is
 * not dirty (has unpushed local edits). Ordering is strictly push-then-pull:
 * in `syncNow()` the push must be acknowledged before anything is pulled, so
 * local edits are never clobbered by a concurrent pull. Deletions travel as
 * tombstones (rows with `deleted` at a new version); a newer upsert
 * resurrects. Stale pushes are never rejected by the relay and the engine
 * never rejects a push ack, so retry loops cannot form.
 *
 * The engine talks to the database exclusively through the raw
 * better-sqlite3 connection with raw SQL: versioned-JSON columns travel as
 * exact strings and are applied verbatim (guarded writes — never through the
 * ORM's toDriver serialization, which would destroy future-version blobs).
 */
import type BetterSqlite3 from 'better-sqlite3';
import { log } from '@main/lib/logger';
import { isInitialOnly, SYNC_TABLES, SYNC_TABLES_BY_NAME, type SyncTableConfig } from './allowlist';
import {
  clearQuarantine,
  countQuarantined,
  deleteTombstones,
  encodePk,
  getRowState,
  listTombstones,
  NEVER_PULLED_CLIENT_VERSION,
  quarantineFloor,
  quarantineRow,
  upsertRowState,
} from './row-state';
import type { RelayTransport, SyncMutation, SyncPatch, SyncPushResult } from './transport';

export type SyncError = { type: 'transport'; message: string } | { type: 'apply'; message: string };

/**
 * Synced child tables that SQLite `ON DELETE CASCADE` removes when a parent row
 * is deleted — the sync allowlist's own FK graph. Applying a parent tombstone
 * used to let that raw cascade run, which (a) destroyed a synced child carrying
 * an unpushed local edit, bypassing the per-row dirty guard, and (b) left the
 * children's own tombstones to be echoed back to the relay. Machine-local
 * children (workspaces, terminals, editor_buffers, messages) also cascade but
 * are not synced, so their loss is expected and never echoed. Every descendant
 * of `projects` carries `project_id`, so a single level per parent is
 * sufficient (no recursion).
 */
const SYNCED_CASCADE_CHILDREN: Record<string, ReadonlyArray<{ table: string; fk: string }>> = {
  projects: [
    { table: 'tasks', fk: 'project_id' },
    { table: 'conversations', fk: 'project_id' },
    { table: 'project_settings', fk: 'project_id' },
    { table: 'project_remotes', fk: 'project_id' },
  ],
  tasks: [{ table: 'conversations', fk: 'task_id' }],
};

export interface SyncSummary {
  /** Upserts acknowledged by the relay in the push phase. */
  pushed: number;
  /** Tombstones acknowledged by the relay in the push phase. */
  tombstonesPushed: number;
  /** Patches fetched in the pull phase. */
  pulled: number;
  /** Patches written locally (upserts applied + rows deleted by tombstones). */
  applied: number;
  /** Patches skipped because the local row has unpushed edits. */
  skippedDirty: number;
  /** Patches skipped because their server version was already seen. */
  skippedSeen: number;
  /**
   * Patches skipped because an in-scope FK parent is missing locally (the
   * parent was deleted and its tombstone already applied here).
   */
  skippedOrphan: number;
  /**
   * Patches dropped because their encrypted body could not be decrypted with a
   * PERMANENT failure (tampered/corrupt envelope, unsupported algorithm). The
   * patch's version is recorded as seen so it is neither re-fetched nor
   * re-pushed — a key change cannot rescue it.
   */
  skippedUndecryptable: number;
  /**
   * Patches parked because their body could not be decrypted with a RETRYABLE,
   * key-related failure (the row is encrypted under a space key this machine
   * does not hold yet — a rekey whose new key has not arrived; decrypt-failure
   * quarantine, spec #130 amendment). Their version is NOT recorded as seen;
   * the engine re-attempts them by rewinding the pull cursor once the space key
   * changes. This counts the quarantine events seen in the cycle; the standing
   * total is `quarantinedCount()`.
   */
  quarantined: number;
  /**
   * Patches skipped because their client_version regressed relative to the
   * one already recorded for this row (spec #130 anti-replay hardening): a
   * relay that replays an old body under a newer server version passes the
   * serverVersion check but is caught here. The patch's version is recorded
   * so the cursor still advances; its content is never applied.
   */
  skippedReplayed: number;
}

export interface SyncEngineOptions {
  /** Raw better-sqlite3 connection (the app's singleton in production). */
  sqlite: BetterSqlite3.Database;
  transport: RelayTransport;
  /** Stable device identity; recorded in every upsert body. */
  deviceId: string;
  /**
   * The key id of this machine's currently stored space key, or `null` if none
   * is stored (decrypt-failure quarantine, spec #130 amendment). The engine
   * itself stays crypto-free — this is an opaque identifier, never key
   * material — and uses only whether it CHANGED to decide when to re-attempt
   * quarantined (undecryptable-because-wrong-key) rows: a rewind-and-retry
   * pass runs at most once per key change, never on every cycle.
   */
  spaceKeyId?: string | null;
  /** Injectable clock (defaults to Date.now). */
  now?: () => number;
  /** Max patches per pull request. Defaults to the relay's limit (1000). */
  pullLimit?: number;
  /**
   * Invoked once per freshly imported project row, after the whole pull has
   * been applied (so the carried `project_remotes` of that project are
   * already present locally). The app wires this to the auto-attach service
   * (ticket #136): a local project whose path is machine-local gets a chance
   * to silently re-anchor on this machine. Errors are logged and swallowed —
   * the hook must never wedge the sync.
   */
  projectAttachHook?: (projectId: string, workspaceProvider: string | null) => void | Promise<void>;
}

const EMPTY_SUMMARY: SyncSummary = {
  pushed: 0,
  tombstonesPushed: 0,
  pulled: 0,
  applied: 0,
  skippedDirty: 0,
  skippedSeen: 0,
  skippedOrphan: 0,
  skippedUndecryptable: 0,
  quarantined: 0,
  skippedReplayed: 0,
};

interface PendingUpsert {
  config: SyncTableConfig;
  pk: string;
  body: string;
  /** The row's clock value read when the mutation was built. */
  syncTs: number;
  /**
   * The client's last-known server version of the row (0 for never-synced
   * rows); encrypting transports bind it into the body's AEAD AAD.
   */
  clientVersion: number;
}

interface PendingTombstone {
  table: string;
  pk: string;
}

interface PreparedTableStatements {
  config: SyncTableConfig;
  selectRows: BetterSqlite3.Statement;
  selectLocal: BetterSqlite3.Statement;
  deleteRow: BetterSqlite3.Statement;
  exists: BetterSqlite3.Statement;
}

export class SyncEngine {
  private readonly sqlite: BetterSqlite3.Database;
  private readonly transport: RelayTransport;
  private readonly deviceId: string;
  private readonly now: () => number;
  private readonly pullLimit: number;
  private readonly projectAttachHook: SyncEngineOptions['projectAttachHook'];
  private readonly spaceKeyId: string | null;
  private readonly statements: PreparedTableStatements[] = [];
  private readonly fkExistsStatements: Array<{
    config: SyncTableConfig;
    column: string;
    stmt: BetterSqlite3.Statement;
  }> = [];

  constructor(options: SyncEngineOptions) {
    this.sqlite = options.sqlite;
    this.transport = options.transport;
    this.deviceId = options.deviceId;
    this.now = options.now ?? (() => Date.now());
    this.pullLimit = options.pullLimit ?? 1000;
    this.projectAttachHook = options.projectAttachHook;
    this.spaceKeyId = options.spaceKeyId ?? null;
    this.prepareStatements();
  }

  /**
   * Push-then-pull: local changes are acknowledged by the relay before any
   * remote patch is applied, so unpushed local edits always win the cycle.
   */
  async syncNow(): Promise<Result<SyncSummary, SyncError>> {
    const pushResult = await this.push();
    if (!pushResult.success) return pushResult;
    const pullResult = await this.pull();
    if (!pullResult.success) return pullResult;
    return ok({
      ...EMPTY_SUMMARY,
      pushed: pushResult.data.pushed,
      tombstonesPushed: pushResult.data.tombstonesPushed,
      pulled: pullResult.data.pulled,
      applied: pullResult.data.applied,
      skippedDirty: pullResult.data.skippedDirty,
      skippedSeen: pullResult.data.skippedSeen,
      skippedOrphan: pullResult.data.skippedOrphan,
      skippedUndecryptable: pullResult.data.skippedUndecryptable,
      quarantined: pullResult.data.quarantined,
      skippedReplayed: pullResult.data.skippedReplayed,
    });
  }

  /**
   * The pull cursor (the relay version up to which this machine is caught up),
   * for long-polling transports: the sync service passes it to
   * `transport.poll()` and re-syncs when patches arrive.
   */
  get lastCursor(): number {
    return this.readCursor();
  }

  /**
   * How many rows the next push would send: unpushed edits (rows whose sync
   * clock advanced past the per-table watermark and are not recorded as
   * applied-and-untouched) plus pending tombstones. Used by the sync service
   * for the offline-with-pending badge; 0 when everything is acked.
   */
  pendingCount(): number {
    let count = 0;
    for (const statements of this.statements) {
      const config = statements.config;
      if (isInitialOnly(config)) continue;
      const watermark = this.readWatermark(config);
      const rows = statements.selectRows.all(watermark) as Array<Record<string, unknown>>;
      for (const row of rows) {
        const pk = this.rowPk(config, row);
        const rowSyncTs = Number(row.sync_ts);
        const state = getRowState(this.sqlite, config.table, pk);
        // Applied-then-untouched rows (clock matches the recorded value) are
        // not candidates — the same filter `push()` applies.
        if (state !== null && !state.dirty && state.rowSyncTs === rowSyncTs) continue;
        count += 1;
      }
    }
    // `collectTombstones` also drops stale bookkeeping rows as a side effect;
    // benign here — they would be dropped on the next push anyway.
    count += this.collectTombstones().length;
    return count;
  }

  /**
   * How many rows are currently quarantined: received from the relay but not
   * yet decryptable on this machine (encrypted under a space key not held here
   * yet). Surfaced in SyncStatus; the engine re-attempts them automatically
   * once the space key changes.
   */
  quarantinedCount(): number {
    return countQuarantined(this.sqlite);
  }

  /** Push every row whose clock advanced past the per-table watermark. */
  async push(): Promise<Result<SyncSummary, SyncError>> {
    const pending: PendingUpsert[] = [];
    try {
      for (const statements of this.statements) {
        const config = statements.config;
        const watermark = this.readWatermark(config);
        if (isInitialOnly(config)) continue;

        const rows = statements.selectRows.all(watermark) as Array<Record<string, unknown>>;
        for (const row of rows) {
          const pk = this.rowPk(config, row);
          const rowSyncTs = Number(row.sync_ts);
          const state = getRowState(this.sqlite, config.table, pk);
          // Applied-then-untouched rows (clock matches the recorded value) are
          // not candidates — this is the trigger re-stamp loop guard.
          if (state !== null && !state.dirty && state.rowSyncTs === rowSyncTs) continue;
          const columns = this.buildColumns(config, row);
          pending.push({
            config,
            pk,
            body: JSON.stringify({ deviceId: this.deviceId, columns }),
            syncTs: rowSyncTs,
            clientVersion: state?.serverVersion ?? 0,
          });
        }
      }

      // initial-only: each project_remotes row is carried exactly once — the
      // first time THIS engine sees it (its own row-state is still null),
      // regardless of whether its parent project already synced. Gating on the
      // parent project's first push missed remotes written after that push:
      // project_remotes is populated on task provision / remotes-model change,
      // not necessarily at project creation, and the parent's row-state never
      // reverts to null. Once a remote is pushed and acked its row-state is
      // recorded, so it is never re-selected (no continuous churn).
      const remotesConfig = SYNC_TABLES_BY_NAME.get('project_remotes');
      if (remotesConfig !== undefined) {
        const rows = this.sqlite
          .prepare(`SELECT ${this.selectColumns(remotesConfig)} FROM project_remotes`)
          .all() as Array<Record<string, unknown>>;
        for (const row of rows) {
          const pk = this.rowPk(remotesConfig, row);
          if (getRowState(this.sqlite, remotesConfig.table, pk) !== null) continue;
          const columns = this.buildColumns(remotesConfig, row);
          pending.push({
            config: remotesConfig,
            pk,
            body: JSON.stringify({ deviceId: this.deviceId, columns }),
            syncTs: Number(row.sync_ts),
            clientVersion: 0,
          });
        }
      }

      // Tombstones: deletion triggers already recorded the rows. Never push
      // tombstones for rows that still exist locally (they are either acked or
      // about to be pushed as upserts), for initial-only tables, or for
      // non-portable keys.
      const pendingTombstones = this.collectTombstones();

      const summary: SyncSummary = { ...EMPTY_SUMMARY };
      if (pending.length === 0 && pendingTombstones.length === 0) {
        return ok(summary);
      }

      const mutations: SyncMutation[] = [
        ...pending.map(
          (item): SyncMutation => ({
            table: item.config.table,
            pk: item.pk,
            client_version: item.clientVersion,
            body: item.body,
            op: 'upsert',
          })
        ),
        ...pendingTombstones.map(
          (item): SyncMutation => ({
            table: item.table,
            pk: item.pk,
            client_version: 0,
            body: null,
            op: 'delete',
          })
        ),
      ];

      let result: SyncPushResult;
      try {
        result = await this.transport.push(mutations);
      } catch (error) {
        return err({ type: 'transport', message: String(error) });
      }
      const acked = new Map(result.results.map((r) => [`${r.table}:${r.pk}`, r.version]));

      // Acknowledge everything in one transaction: row state, tombstone drain
      // and the advanced per-table watermarks.
      const now = this.now();
      try {
        this.sqlite.transaction(() => {
          for (const item of pending) {
            const version = acked.get(`${item.config.table}:${item.pk}`);
            if (version === undefined) continue;
            // Push-ack, not a pulled patch: never touch client_version here —
            // lowering the replay guard's recorded baseline on our OWN edit
            // being acked would reopen the window it closes.
            upsertRowState(
              this.sqlite,
              item.config.table,
              item.pk,
              version,
              false,
              item.syncTs,
              null
            );
          }
          deleteTombstones(
            this.sqlite,
            pendingTombstones.map((t) => ({ table: t.table, pk: t.pk }))
          );
          for (const statements of this.statements) {
            const config = statements.config;
            const pushedSyncTs = pending
              .filter((item) => item.config.table === config.table)
              .map((item) => item.syncTs);
            if (pushedSyncTs.length === 0) continue;
            this.writeWatermark(config, Math.max(...pushedSyncTs), now);
          }
        })();
      } catch (error) {
        return err({ type: 'apply', message: String(error) });
      }

      summary.pushed = pending.length;
      summary.tombstonesPushed = pendingTombstones.length;
      log.debug('[sync] push complete', {
        pushed: summary.pushed,
        tombstones: summary.tombstonesPushed,
      });
      return ok(summary);
    } catch (error) {
      return err({ type: 'apply', message: String(error) });
    }
  }

  /** Apply every patch newer than the pull cursor, server-authoritative LWW. */
  async pull(): Promise<Result<SyncSummary, SyncError>> {
    const summary: SyncSummary = { ...EMPTY_SUMMARY };
    const lastPushed = new Map<string, number>();
    for (const statements of this.statements) {
      lastPushed.set(statements.config.table, this.readWatermark(statements.config));
    }
    let cursor = this.readCursor();

    // Decrypt-failure quarantine retry (spec #130 amendment): rows parked
    // because they were encrypted under a space key this machine did not hold
    // are re-attempted by rewinding the pull cursor to just below the oldest
    // quarantined version, so those patches are re-fetched and decrypted with
    // the key we have now. Gated on the key id having CHANGED since the last
    // retry: the only event that can turn an `unknown_key_id` failure into a
    // success is a new/rotated space key arriving, so this runs at most once
    // per key change — never a per-cycle re-pull from the floor. Already-applied
    // rows in the rewound range are cheaply skipped by the seen-check; the
    // persisted cursor climbs back to the true high-water mark as the retry
    // pages through.
    let retriedQuarantine = false;
    if (this.spaceKeyId !== null) {
      const floor = quarantineFloor(this.sqlite);
      if (floor !== null && this.spaceKeyId !== this.readQuarantineRetryKeyId()) {
        cursor = Math.min(cursor, floor - 1);
        retriedQuarantine = true;
        log.debug('[sync] retrying quarantined rows after space-key change', { floor });
      }
    }

    try {
      // Project rows inserted by this pull (fresh imports) — the auto-attach
      // hook fires for them once the whole pull is applied, so the carried
      // project_remotes of each project are already present locally.
      const freshProjectIds: Array<{ id: string; workspaceProvider: string | null }> = [];
      for (;;) {
        let result;
        try {
          result = await this.transport.pull(cursor, this.pullLimit);
        } catch (error) {
          return err({ type: 'transport', message: String(error) });
        }
        if (result.patches.length === 0) break;
        const nextCursor = Math.max(cursor, result.cursor);
        const now = this.now();
        try {
          this.sqlite.transaction(() => {
            for (const patch of result.patches) {
              this.applyPatch(patch, lastPushed, summary, freshProjectIds);
            }
            this.writeCursor(nextCursor, now);
          })();
        } catch (error) {
          return err({ type: 'apply', message: String(error) });
        }
        summary.pulled += result.patches.length;
        cursor = nextCursor;
        if (result.patches.length < this.pullLimit) break;
      }
      if (this.projectAttachHook !== undefined && freshProjectIds.length > 0) {
        for (const project of freshProjectIds) {
          try {
            await this.projectAttachHook(project.id, project.workspaceProvider);
          } catch (error) {
            log.warn('[sync] projectAttachHook failed (non-fatal)', {
              projectId: project.id,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
      // Record the key id this retry pass ran under, so the next cycle does not
      // rewind again until the space key changes once more.
      if (retriedQuarantine && this.spaceKeyId !== null) {
        this.writeQuarantineRetryKeyId(this.spaceKeyId);
      }
      log.debug('[sync] pull complete', {
        pulled: summary.pulled,
        applied: summary.applied,
        skippedDirty: summary.skippedDirty,
        skippedSeen: summary.skippedSeen,
        skippedOrphan: summary.skippedOrphan,
        skippedUndecryptable: summary.skippedUndecryptable,
        quarantined: summary.quarantined,
        skippedReplayed: summary.skippedReplayed,
      });
      return ok(summary);
    } catch (error) {
      return err({ type: 'apply', message: String(error) });
    }
  }

  // -------------------------------------------------------------------------
  // Apply (pull side)
  // -------------------------------------------------------------------------

  private applyPatch(
    patch: SyncPatch,
    lastPushed: Map<string, number>,
    summary: SyncSummary,
    freshProjectIds: Array<{ id: string; workspaceProvider: string | null }>
  ): void {
    const statements = this.statements.find((s) => s.config.table === patch.table);
    if (statements === undefined) {
      // Not (or no longer) allowlisted: skip but keep the cursor moving.
      summary.skippedSeen += 1;
      return;
    }
    const config = statements.config;
    // Non-portable rows (kv keys outside prompt-library, excluded app_settings
    // keys) are never applied — they exist only on their own machine.
    if (config.isPortablePk !== undefined && !config.isPortablePk(patch.pk)) {
      summary.skippedSeen += 1;
      return;
    }
    const state = getRowState(this.sqlite, config.table, patch.pk);
    if (state !== null && state.serverVersion >= patch.version) {
      summary.skippedSeen += 1;
      return;
    }
    const localRow = statements.selectLocal.get(...this.pkParams(config, patch.pk)) as
      | Record<string, unknown>
      | undefined;
    const rowSyncTs = localRow === undefined ? 0 : Number(localRow.sync_ts);
    const watermark = lastPushed.get(config.table) ?? 0;
    if (this.isDirty(rowSyncTs, watermark, state)) {
      // Local unpushed edits win: record the patch's version as dirty so a
      // later re-pull of it is skipped, then let the next push decide. This
      // branch also sees delete patches (client_version is meaningless — always
      // 0), so client_version is never touched here.
      upsertRowState(this.sqlite, config.table, patch.pk, patch.version, true, rowSyncTs, null);
      summary.skippedDirty += 1;
      return;
    }
    if (patch.decryptError !== undefined) {
      if (patch.decryptRetryable === true) {
        // Retryable (key-related): the body is validly encrypted but under a
        // space key this machine does not hold yet (a rekey whose new key has
        // not arrived). Quarantine WITHOUT advancing server_version, so the
        // version is not recorded as seen and the cursor-rewind retry can
        // re-fetch and re-attempt it once the key changes — instead of losing
        // the row forever. Never applies garbage, never echoes it back.
        quarantineRow(this.sqlite, config.table, patch.pk, patch.version);
        summary.quarantined += 1;
        return;
      }
      // Permanent (tampered/corrupt envelope, unsupported alg): a key change
      // cannot rescue it. Record the version as seen so the row is neither
      // re-fetched nor re-pushed (echoing an undecryptable body would wedge
      // every other machine), lift any prior quarantine, then keep pulling.
      // client_version is never touched: it is only trustworthy once AEAD
      // authentication (which binds it) has actually succeeded.
      upsertRowState(this.sqlite, config.table, patch.pk, patch.version, false, rowSyncTs, null);
      if (state !== null && state.quarantinedVersion > 0) {
        clearQuarantine(this.sqlite, config.table, patch.pk);
      }
      summary.skippedUndecryptable += 1;
      return;
    }
    // Past the decrypt gate: this patch decrypted (or is a bodyless delete), so
    // the row is no longer undecryptable — lift any quarantine parked on it.
    if (state !== null && state.quarantinedVersion > 0) {
      clearQuarantine(this.sqlite, config.table, patch.pk);
    }
    // Anti-replay hardening (spec #130 amendment): a relay that replays an old
    // (but validly-encrypted) body under a newer server version passes the
    // serverVersion check above. client_version is the pusher's own
    // last-known server version at push time, so — for a given row — it only
    // regresses if a patch is being replayed; a patch whose client_version is
    // STRICTLY LESS than the last one recorded for this row is dropped, but its
    // (higher) server version is still recorded so the cursor advances. The
    // comparison must be `<`, never `<=`: client_version is a last-observed
    // server version, not a per-writer counter, so two machines that both
    // edited the row from the SAME already-synced baseline legitimately push
    // the same client_version — the later one (higher server version) is a
    // genuine concurrent edit that LWW-by-server-version must apply, not a
    // replay. Treating that tie as a replay silently loses the concurrent
    // edit. A true replay of the identical last body (equal client_version)
    // slips through as a harmless idempotent re-apply of identical content.
    // Deletes always carry client_version 0 (see transport.ts) and are handled
    // by the branch below instead — the exact negation of its own condition
    // keeps this from ever misclassifying a delete as an upsert to guard.
    // NEVER_PULLED_CLIENT_VERSION excludes rows that only exist from this
    // machine's own push-acks: two machines independently pushing the very same
    // never-before-synced row both legitimately carry the real client_version
    // 0, so there is no baseline yet to replay-check against (row-state.ts).
    if (
      state !== null &&
      state.clientVersion !== NEVER_PULLED_CLIENT_VERSION &&
      !(patch.op === 'delete' || patch.deleted) &&
      patch.client_version < state.clientVersion
    ) {
      upsertRowState(this.sqlite, config.table, patch.pk, patch.version, false, rowSyncTs, null);
      summary.skippedReplayed += 1;
      return;
    }

    if (patch.op === 'delete' || patch.deleted) {
      if (localRow !== undefined) {
        // Data-loss guard: a parent delete cascade-deletes synced children (FK
        // ON DELETE CASCADE) outside the per-row dirty guard. If any synced
        // descendant carries an unpushed local edit, dropping the parent would
        // destroy it (violating "a pull never clobbers local edits", spec #130
        // story 17). Preserve local work — record the version as seen (so it is
        // neither re-fetched nor re-pushed) and skip the delete. The next push
        // flushes the child; a later delete applies cleanly once nothing is
        // dirty.
        if (SYNCED_CASCADE_CHILDREN[config.table] !== undefined) {
          const descendants = this.collectSyncedDescendants(
            config.table,
            this.pkParams(config, patch.pk)[0]
          );
          const dirty = descendants.some((child) =>
            this.isDirty(
              child.rowSyncTs,
              lastPushed.get(child.config.table) ?? 0,
              getRowState(this.sqlite, child.config.table, child.pk)
            )
          );
          if (dirty) {
            // A delete's client_version is always 0 (transport.ts); never
            // touch the recorded value on this row.
            upsertRowState(
              this.sqlite,
              config.table,
              patch.pk,
              patch.version,
              false,
              rowSyncTs,
              null
            );
            summary.skippedDirty += 1;
            return;
          }
        }
        statements.deleteRow.run(...this.pkParams(config, patch.pk));
        // The AFTER DELETE trigger recorded a tombstone for our own apply;
        // clear it so the deletion is not echoed back to the relay. A cascade
        // also tombstones synced children, but those are left to push: the
        // child may still be alive on the relay (this machine's own upsert won
        // an earlier LWW), so pushing its tombstone genuinely converges it —
        // and a redundant push where the relay already has the child deleted is
        // an idempotent, harmless delete-of-a-delete.
        deleteTombstones(this.sqlite, [{ table: config.table, pk: patch.pk }]);
      }
      // A delete's client_version is always 0 (transport.ts); never touch the
      // recorded value on this row.
      upsertRowState(this.sqlite, config.table, patch.pk, patch.version, false, rowSyncTs, null);
      summary.applied += 1;
      return;
    }

    const columns = this.decodeBody(patch.body);
    if (columns === null) {
      log.warn('[sync] ignoring unparseable patch body', { table: patch.table, pk: patch.pk });
      summary.skippedSeen += 1;
      return;
    }
    const transformed = this.applyImportTransforms(config, patch.pk, columns, localRow);
    // In-scope FK parents must exist locally: a parent tombstone applied
    // earlier means the child cannot exist either (its own tombstone is on
    // its way from the machine that applied the cascade). Skipping instead of
    // aborting keeps the pull cursor moving — an FK violation here would
    // roll back the whole batch and wedge the sync forever.
    for (const fk of config.importSkipIfMissingParent ?? []) {
      const value = transformed[fk.column];
      if (value === null || value === undefined) continue;
      const entry = this.fkExistsStatements.find(
        (e) => e.config.table === config.table && e.column === fk.column
      );
      if (entry?.stmt.get(value) === undefined) {
        // The patch already passed the replay guard above (or this is the
        // row's first-ever patch), so its client_version is a genuine, newer
        // value for this row even though its content is not applied here.
        upsertRowState(
          this.sqlite,
          config.table,
          patch.pk,
          patch.version,
          false,
          rowSyncTs,
          patch.client_version
        );
        summary.skippedOrphan += 1;
        return;
      }
    }
    this.upsertRow(config, patch.pk, transformed, localRow !== undefined, this.now());
    // Read back the clock the trigger stamped so the next push sees the row
    // as applied-and-untouched rather than dirty.
    const appliedRow = statements.selectLocal.get(...this.pkParams(config, patch.pk)) as
      | { sync_ts: unknown }
      | undefined;
    const appliedSyncTs = appliedRow === undefined ? 0 : Number(appliedRow.sync_ts);
    // Genuine apply: record this patch's client_version as the new baseline
    // for the replay guard.
    upsertRowState(
      this.sqlite,
      config.table,
      patch.pk,
      patch.version,
      false,
      appliedSyncTs,
      patch.client_version
    );
    if (config.table === 'projects' && localRow === undefined) {
      freshProjectIds.push({
        id: patch.pk,
        workspaceProvider: (transformed.workspace_provider as string | null) ?? null,
      });
    }
    summary.applied += 1;
  }

  /**
   * The synced child rows a cascade would delete with this parent, each with
   * the clock + row-state the dirty guard needs. Used to apply a parent delete
   * through the guard instead of via SQLite's raw CASCADE.
   */
  private collectSyncedDescendants(
    parentTable: string,
    parentId: string
  ): Array<{ config: SyncTableConfig; pk: string; rowSyncTs: number }> {
    const out: Array<{ config: SyncTableConfig; pk: string; rowSyncTs: number }> = [];
    for (const child of SYNCED_CASCADE_CHILDREN[parentTable] ?? []) {
      const childConfig = SYNC_TABLES_BY_NAME.get(child.table);
      if (childConfig === undefined) continue;
      const rows = this.sqlite
        .prepare(
          `SELECT ${this.selectColumns(childConfig)} FROM \`${child.table}\` WHERE \`${child.fk}\` = ?`
        )
        .all(parentId) as Array<Record<string, unknown>>;
      for (const row of rows) {
        out.push({
          config: childConfig,
          pk: this.rowPk(childConfig, row),
          rowSyncTs: Number(row.sync_ts),
        });
      }
    }
    return out;
  }

  private isDirty(
    rowSyncTs: number,
    watermark: number,
    state: { dirty: boolean; rowSyncTs: number } | null
  ): boolean {
    if (rowSyncTs <= watermark) return false;
    if (state !== null && !state.dirty && state.rowSyncTs === rowSyncTs) return false;
    return true;
  }

  private decodeBody(body: string | null): Record<string, string | null> | null {
    if (body === null) return null;
    try {
      const parsed = JSON.parse(body) as { columns?: unknown };
      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        typeof parsed.columns !== 'object' ||
        parsed.columns === null
      ) {
        return null;
      }
      const columns = parsed.columns as Record<string, unknown>;
      const result: Record<string, string | null> = {};
      for (const [key, value] of Object.entries(columns)) {
        result[key] = value === null || value === undefined ? null : String(value);
      }
      return result;
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Import transforms (machine-specific rehydration / guarding)
  // -------------------------------------------------------------------------

  private applyImportTransforms(
    config: SyncTableConfig,
    pk: string,
    columns: Record<string, string | null>,
    localRow: Record<string, unknown> | undefined
  ): Record<string, string | null> {
    let next = columns;
    if (config.importTransform !== undefined) {
      next = config.importTransform(pk, next, localRow ?? null, this.sqlite);
    }
    // Machine-local reference columns are never written at import: fresh
    // inserts leave them NULL, existing rows keep their own value.
    for (const column of config.importPreserveLocalColumns ?? []) {
      if (column in next) {
        const { [column]: _dropped, ...rest } = next;
        next = rest;
      }
    }
    for (const fk of config.importNullIfMissingFk ?? []) {
      const value = next[fk.column];
      if (value === null || value === undefined) continue;
      const entry = this.fkExistsStatements.find(
        (e) => e.config.table === config.table && e.column === fk.column
      );
      const exists = entry?.stmt.get(value) as { one?: number } | undefined;
      if (exists === undefined) {
        next = { ...next, [fk.column]: null };
      }
    }
    return next;
  }

  // -------------------------------------------------------------------------
  // Row upsert (raw SQL, guarded writes)
  // -------------------------------------------------------------------------

  private upsertRow(
    config: SyncTableConfig,
    pk: string,
    columns: Record<string, string | null>,
    existsLocally: boolean,
    now: number
  ): void {
    if (config.kvStyle === true) {
      // kv-style tables carry a single `value` column; the key comes from the
      // patch pk and `updated_at` follows the app's KV write convention.
      const value = columns.value ?? null;
      const table = config.table === 'kv:prompt-library' ? 'kv' : config.table;
      this.sqlite
        .prepare(
          `INSERT INTO \`${table}\` (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
        )
        .run(pk, value, now);
      return;
    }

    const insertColumns = [...config.keyColumns];
    for (const column of Object.keys(columns)) {
      if (!insertColumns.includes(column) && config.payloadColumns.includes(column)) {
        insertColumns.push(column);
      }
    }
    for (const column of Object.keys(config.importInsertColumns ?? {})) {
      if (!insertColumns.includes(column)) insertColumns.push(column);
    }

    const updateColumns = insertColumns.filter(
      (column) =>
        !config.keyColumns.includes(column) && !(config.importInsertColumns?.[column] !== undefined)
    );
    const params: Array<string | null> = [];
    for (const column of insertColumns) {
      const explicit = config.importInsertColumns?.[column];
      params.push(explicit !== undefined ? explicit : (columns[column] ?? null));
    }

    const insertSql = `INSERT INTO \`${config.table}\` (${insertColumns.map((c) => `\`${c}\``).join(', ')})
      VALUES (${insertColumns.map(() => '?').join(', ')})`;
    if (updateColumns.length === 0) {
      // Nothing beyond the primary key to write: a fresh import inserts the
      // bare pk row, an existing row is a no-op.
      if (existsLocally) return;
      this.sqlite.prepare(insertSql).run(...params);
      return;
    }
    const conflictSql = `ON CONFLICT (${config.keyColumns.map((c) => `\`${c}\``).join(', ')})
      DO UPDATE SET ${updateColumns.map((c) => `\`${c}\` = excluded.\`${c}\``).join(', ')}`;
    this.sqlite.prepare(`${insertSql} ${conflictSql}`).run(...params);
  }

  // -------------------------------------------------------------------------
  // Tombstone collection
  // -------------------------------------------------------------------------

  private collectTombstones(): PendingTombstone[] {
    const pending: PendingTombstone[] = [];
    const dropped: Array<{ table: string; pk: string }> = [];
    for (const entry of listTombstones(this.sqlite)) {
      const config = SYNC_TABLES_BY_NAME.get(entry.table);
      if (config === undefined || isInitialOnly(config)) {
        dropped.push(entry);
        continue;
      }
      if (config.isPortablePk !== undefined && !config.isPortablePk(entry.pk)) {
        dropped.push(entry);
        continue;
      }
      const statements = this.statements.find((s) => s.config.table === entry.table);
      if (statements === undefined) {
        dropped.push(entry);
        continue;
      }
      const exists = statements.exists.get(...this.pkParams(config, entry.pk)) as
        | { one: number }
        | undefined;
      if (exists !== undefined) {
        // The row is live again (or was never really gone): a pending upsert
        // covers it — the tombstone must not win by later receipt order.
        dropped.push(entry);
        continue;
      }
      pending.push({ table: entry.table, pk: entry.pk });
    }
    if (dropped.length > 0) {
      deleteTombstones(this.sqlite, dropped);
    }
    return pending;
  }

  // -------------------------------------------------------------------------
  // Bookkeeping (machine-local kv keys, never synced)
  // -------------------------------------------------------------------------

  private watermarkKey(config: SyncTableConfig): string {
    return `sync:lastPushed:${config.table}`;
  }

  private readWatermark(config: SyncTableConfig): number {
    return this.readBookkeepingNumber(this.watermarkKey(config));
  }

  private writeWatermark(config: SyncTableConfig, value: number, now: number): void {
    this.writeBookkeepingNumber(this.watermarkKey(config), value, now);
  }

  private readCursor(): number {
    return this.readBookkeepingNumber('sync:cursor');
  }

  private writeCursor(value: number, now: number): void {
    this.writeBookkeepingNumber('sync:cursor', value, now);
  }

  /**
   * The space key id under which the last quarantine rewind-retry ran (or ''
   * if none). The pull rewinds to the quarantine floor only when the current
   * key id differs from this, bounding retries to once per key change.
   */
  private readQuarantineRetryKeyId(): string {
    const row = this.sqlite
      .prepare('SELECT value FROM kv WHERE key = ?')
      .get('sync:quarantineRetryKeyId') as { value: string } | undefined;
    if (row === undefined) return '';
    try {
      const parsed = JSON.parse(row.value) as unknown;
      return typeof parsed === 'string' ? parsed : '';
    } catch {
      return '';
    }
  }

  private writeQuarantineRetryKeyId(keyId: string): void {
    this.sqlite
      .prepare(
        `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .run('sync:quarantineRetryKeyId', JSON.stringify(keyId), this.now());
  }

  private readBookkeepingNumber(key: string): number {
    const row = this.sqlite.prepare('SELECT value FROM kv WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    if (row === undefined) return 0;
    try {
      const parsed = JSON.parse(row.value) as unknown;
      return typeof parsed === 'number' && Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
    } catch {
      return 0;
    }
  }

  private writeBookkeepingNumber(key: string, value: number, now: number): void {
    this.sqlite
      .prepare(
        `INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .run(key, JSON.stringify(value), now);
  }

  // -------------------------------------------------------------------------
  // Statement preparation
  // -------------------------------------------------------------------------

  private prepareStatements(): void {
    for (const config of SYNC_TABLES) {
      const columns = this.selectColumns(config);
      const whereFilter =
        config.table === 'kv:prompt-library'
          ? `WHERE key LIKE 'prompt-library:%' AND sync_ts > ?`
          : config.table === 'app_settings'
            ? `WHERE key NOT IN ('localProject', 'providerConfigs') AND sync_ts > ?`
            : `WHERE sync_ts > ?`;
      const table = this.physicalTable(config);
      const selectRows = this.sqlite.prepare(`SELECT ${columns} FROM \`${table}\` ${whereFilter}`);
      const pkConditions = config.keyColumns.map((c) => `\`${c}\` = ?`).join(' AND ');
      const selectLocal = this.sqlite.prepare(
        `SELECT ${columns} FROM \`${table}\` WHERE ${pkConditions} LIMIT 1`
      );
      const deleteRow = this.sqlite.prepare(`DELETE FROM \`${table}\` WHERE ${pkConditions}`);
      const exists = this.sqlite.prepare(
        `SELECT 1 AS one FROM \`${table}\` WHERE ${pkConditions} LIMIT 1`
      );
      this.statements.push({ config, selectRows, selectLocal, deleteRow, exists });

      for (const fk of config.importNullIfMissingFk ?? []) {
        this.fkExistsStatements.push({
          config,
          column: fk.column,
          stmt: this.sqlite.prepare(
            `SELECT 1 AS one FROM \`${fk.table}\` WHERE \`${fk.columnRef}\` = ? LIMIT 1`
          ),
        });
      }
      for (const fk of config.importSkipIfMissingParent ?? []) {
        this.fkExistsStatements.push({
          config,
          column: fk.column,
          stmt: this.sqlite.prepare(
            `SELECT 1 AS one FROM \`${fk.table}\` WHERE \`${fk.columnRef}\` = ? LIMIT 1`
          ),
        });
      }
    }
  }

  private physicalTable(config: SyncTableConfig): string {
    return config.kvStyle === true && config.table === 'kv:prompt-library' ? 'kv' : config.table;
  }

  private selectColumns(config: SyncTableConfig): string {
    return [...config.keyColumns, ...config.payloadColumns, 'sync_ts']
      .map((c) => `\`${c}\``)
      .join(', ');
  }

  private rowPk(config: SyncTableConfig, row: Record<string, unknown>): string {
    return encodePk(config.keyColumns.map((c) => row[c]));
  }

  private pkParams(config: SyncTableConfig, pk: string): string[] {
    if (config.keyColumns.length === 1) return [pk];
    const values = JSON.parse(pk) as unknown;
    return Array.isArray(values) ? values.map((v) => String(v)) : [pk];
  }

  private buildColumns(
    config: SyncTableConfig,
    row: Record<string, unknown>
  ): Record<string, string | null> {
    let columns: Record<string, string | null> = {};
    for (const column of config.payloadColumns) {
      const value = row[column];
      columns[column] = value === null || value === undefined ? null : String(value);
    }
    if (config.pushTransform !== undefined) {
      columns = config.pushTransform(this.rowPk(config, row), columns, row);
    }
    return columns;
  }
}
