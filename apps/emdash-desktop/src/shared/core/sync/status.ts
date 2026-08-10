/**
 * Shared sync-status types for multi-machine sync (spec #130, ticket #137).
 *
 * The main-process `SyncService` maintains a `SyncStatus` snapshot and pushes
 * it to the renderer through the `sync:status` event (`syncStatusChannel`) and
 * the `rpc.sync.getSyncStatus` / `rpc.sync.syncNow` surface. The sidebar status
 * widget consumes it via a `useSyncExternalStore` store.
 *
 * State model (four widget states plus the not-paired idle state):
 * - `idle`: no space credential on this machine — the onboarding prompt
 *   (Join an existing space / Start from scratch) is the entry point.
 * - `syncing`: a push+pull cycle is running right now.
 * - `up-to-date`: the last cycle succeeded; everything local is pushed and
 *   everything remote is applied.
 * - `offline-with-pending`: the relay is unreachable and this machine holds
 *   local rows that could not be pushed yet (`pendingCount > 0`).
 * - `error`: the last cycle failed (relay error, apply failure, or unreachable
 *   relay with nothing local pending); `lastError` carries a user-facing
 *   message.
 */

/** The four widget states plus the not-paired idle state. */
export type SyncStatusState = 'idle' | 'syncing' | 'up-to-date' | 'offline-with-pending' | 'error';

export type SyncStatus = {
  state: SyncStatusState;
  /** Whether this machine holds a relay credential for a sync space. */
  paired: boolean;
  /** ms epoch of the last successful push+pull cycle, or null when never synced. */
  lastSyncAt: number | null;
  /** User-facing message of the last failure, or null. */
  lastError: string | null;
  /** Rows waiting to be pushed (unpushed edits + tombstones); 0 when idle. */
  pendingCount: number;
  /**
   * Rows received from the relay but not yet decryptable on this machine
   * (spec #130 amendment, decrypt-failure quarantine): a row encrypted under a
   * space key this machine does not hold yet — e.g. the space was rekeyed and
   * the new key has not reached this device. The engine parks them instead of
   * applying garbage or wedging the pull, and re-attempts them automatically
   * once the space key changes. Omitted (treated as 0) by callers that predate
   * the field. Rows that fail permanently (tampered / corrupt bodies) are NOT
   * counted here — they are dropped, never retried.
   */
  quarantinedCount?: number;
};
