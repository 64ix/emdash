/**
 * SyncService (spec #130, ticket #137): owns the SyncEngine lifecycle for the
 * running app.
 *
 * The service is the daily-sync heart behind the sidebar status widget:
 *
 * - It builds the engine transport stack from the machine's current pairing:
 *   `HttpRelayTransport` with the stored device token, always wrapped in
 *   `EncryptingRelayTransport` — a paired machine without a stored space key
 *   (K0) fails pushes with a clear re-join error instead of sending
 *   plaintext bodies to the relay.
 * - `start()` runs a launch sync (after the window is up) and then a
 *   near-continuous long-poll loop (`transport.poll`, relay clamp 25 s); the
 *   loop reconnects with exponential backoff after failures.
 * - Local-first offline behavior: writes always stay local (the engine keeps
 *   dirty rows); an unreachable relay marks the status
 *   `offline-with-pending` with the pending row count, and any successful
 *   interaction (poll success, OS `online` event, manual "Sync now") triggers
 *   a push+pull that drains the backlog.
 * - Concurrent syncs are serialized: `syncNow()` is single-flight — a second
 *   call while a cycle runs coalesces onto the running cycle.
 * - Every state transition is pushed through `onStatusChange` (production:
 *   the `sync:status` event, whose main-process emitter already guards window
 *   liveness by iterating live windows).
 *
 * The service is fully injectable so behavior tests drive it against a fake
 * RelayTransport with fake timers.
 */
import type { Result } from '@emdash/shared';
import type BetterSqlite3 from 'better-sqlite3';
import { createProjectAutoAttachHook } from '@main/core/projects/auto-attach';
import { log } from '@main/lib/logger';
import type { SyncStatus } from '@shared/core/sync/status';
import type { DeviceIdentity } from './device-identity';
import { EncryptingRelayTransport } from './encrypting-transport';
import { SyncEngine, type SyncEngineOptions, type SyncError } from './engine';
import type { SpaceKey, SpaceKeyStoreError } from './space-key-store';
import type { SyncCredential, SyncCredentialError } from './sync-credentials';
import { RelayHttpError } from './transport';
import type { RelayTransport } from './transport';

/** Relay long-poll clamp (apps/sync-relay README): 25 s. */
export const DEFAULT_POLL_TIMEOUT_MS = 25_000;
/** Safety pacing between no-op poll cycles (production polls hold 25 s). */
export const DEFAULT_POLL_IDLE_DELAY_MS = 1_000;
/** First reconnect delay after a failed sync/poll. */
export const RETRY_BASE_MS = 2_000;
/** Reconnect backoff cap. */
export const RETRY_MAX_MS = 60_000;
/** How often an unpaired service re-checks for a freshly created/joined space. */
export const NOT_PAIRED_RECHECK_MS = 30_000;

export type SyncServiceDeps = {
  /** The app's singleton better-sqlite3 connection (the engine's DB). */
  sqlite: BetterSqlite3.Database;
  /** Machine-local sync credential (device token + space id), or none. */
  getCredentials: () => Promise<Result<SyncCredential | null, SyncCredentialError>>;
  /** Machine-local space data key K0, or none. */
  getSpaceKey: () => Promise<Result<SpaceKey | null, SpaceKeyStoreError>>;
  /**
   * Drops the machine-local credential + space key. Called when the relay
   * rejects this device's token (401/403) — the device was removed/revoked, so
   * the machine un-pairs cleanly and returns to onboarding instead of looping
   * on an unrecoverable auth error forever.
   */
  onAuthRevoked?: () => Promise<void>;
  /** Stable device identity recorded in every pushed body. */
  getDeviceIdentity: () => Promise<DeviceIdentity>;
  /** Builds the base transport for a device token (production: HttpRelayTransport). */
  createTransport: (token: string) => RelayTransport;
  /** Freshly imported projects get a chance to re-anchor (ticket #136). */
  projectAttachHook?: SyncEngineOptions['projectAttachHook'];
  /** Status sink; production wires `events.emit(syncStatusChannel, status)`. */
  onStatusChange: (status: SyncStatus) => void;
  /** Injectable clock (defaults to Date.now). */
  now?: () => number;
  /** Injectable sleep for backoff (fake timers in tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Long-poll wait. Defaults to the relay clamp (25 s). */
  pollTimeoutMs?: number;
  /** Reconnect backoff base/cap. Defaults 2 s / 60 s. */
  retryBaseMs?: number;
  retryMaxMs?: number;
  /** How often an unpaired service re-checks for a newly created/joined space. */
  notPairedRecheckMs?: number;
  /**
   * Pause between successful poll cycles that produced no work. Production
   * poll holds the relay connection for `pollTimeoutMs`, so this is only a
   * safety pacing (and what keeps fake-transport loops from spinning).
   */
  pollIdleDelayMs?: number;
  /** OS connectivity notifications (production: `app.on('online'|'offline')`). */
  connectivity?: {
    onOnline: (callback: () => void) => () => void;
    onOffline: (callback: () => void) => () => void;
  };
};

/** The one string the HTTP transport produces for an unreachable relay. */
const RELAY_UNREACHABLE_MARKER = 'relay unreachable';

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
}

function isRelayUnreachable(error: unknown): boolean {
  return messageOf(error).includes(RELAY_UNREACHABLE_MARKER);
}

/** A permanent auth rejection: this device's token was revoked/removed. */
function isAuthRevoked(error: unknown): boolean {
  return error instanceof RelayHttpError && (error.status === 401 || error.status === 403);
}

/** User-facing message for a failed sync; details stay in the logs. */
export function userFacingSyncMessage(error: SyncError): string {
  if (error.type === 'apply') {
    return 'Some synced changes could not be applied on this machine.';
  }
  if (error.message.includes(RELAY_UNREACHABLE_MARKER)) {
    return 'Could not reach the sync relay. Your changes stay saved on this machine and will sync when you reconnect.';
  }
  if (error.message.includes('encryption key')) {
    return 'This machine is missing the sync space encryption key. Re-join the space to restore syncing.';
  }
  return 'The sync relay returned an error. Try again in a moment.';
}

const IDLE_STATUS: SyncStatus = {
  state: 'idle',
  paired: false,
  lastSyncAt: null,
  lastError: null,
  pendingCount: 0,
};

export class SyncService {
  private status: SyncStatus = { ...IDLE_STATUS };
  private started = false;
  private stopped = true;
  private inFlight: Promise<void> | null = null;
  private loopPromise: Promise<void> | null = null;
  private retryDelayMs: number;
  private deviceIdentity: DeviceIdentity | null = null;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly pollTimeoutMs: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly notPairedRecheckMs: number;
  private readonly pollIdleDelayMs: number;
  private readonly unsubscribes: Array<() => void> = [];

  constructor(private readonly deps: SyncServiceDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.pollTimeoutMs = deps.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
    this.retryBaseMs = deps.retryBaseMs ?? RETRY_BASE_MS;
    this.retryMaxMs = deps.retryMaxMs ?? RETRY_MAX_MS;
    this.notPairedRecheckMs = deps.notPairedRecheckMs ?? NOT_PAIRED_RECHECK_MS;
    this.pollIdleDelayMs = deps.pollIdleDelayMs ?? DEFAULT_POLL_IDLE_DELAY_MS;
    this.retryDelayMs = this.retryBaseMs;
  }

  getStatus(): SyncStatus {
    return { ...this.status };
  }

  /**
   * Starts the service: a launch sync (push+pull) immediately, then the
   * long-poll loop with reconnect backoff, and OS connectivity hooks. Safe to
   * call once; subsequent calls are no-ops.
   */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    this.retryDelayMs = this.retryBaseMs;
    // Launch sync: run after the window is up so the renderer receives the
    // first status snapshot (spec #130: sync at launch).
    void this.syncNow();
    // Last-resort guard: runLoop is designed never to reject, but if it ever
    // does the rejection would be unhandled and the loop silently dead. Log it
    // loudly rather than lose background sync without a trace.
    this.loopPromise = this.runLoop().catch((error) => {
      log.error('[sync] long-poll loop crashed', error);
    });
    if (this.deps.connectivity !== undefined) {
      this.unsubscribes.push(
        this.deps.connectivity.onOnline(() => {
          // A returned connection: drop the backoff wait and sync right away.
          this.kick();
        })
      );
      this.unsubscribes.push(this.deps.connectivity.onOffline(() => undefined));
    }
  }

  /** Stops the loop; in-flight work completes, no new cycles are scheduled. */
  stop(): void {
    this.stopped = true;
    this.started = false;
    for (const unsubscribe of this.unsubscribes.splice(0)) {
      unsubscribe();
    }
  }

  /**
   * Runs a push+pull cycle, single-flight: concurrent callers coalesce onto
   * the running cycle (the #133 review guard — syncs are always serialized).
   */
  syncNow(): Promise<void> {
    if (this.inFlight !== null) return this.inFlight;
    const run = (async () => {
      try {
        await this.runCycle();
      } catch (error) {
        // The cycle swallows expected failures; this is a last-resort guard.
        log.error('[sync] unexpected cycle failure', error);
        this.updateStatus({
          state: 'error',
          lastError: 'Sync failed unexpectedly.',
        });
      }
    })().finally(() => {
      this.inFlight = null;
    });
    this.inFlight = run;
    return run;
  }

  /**
   * Requests an immediate sync (used by the sync RPC after pairing and by the
   * OS `online` event). No-op before `start()` or after `stop()`.
   */
  kick(): void {
    if (!this.started || this.stopped) return;
    void this.syncNow();
  }

  // -------------------------------------------------------------------------
  // Cycle
  // -------------------------------------------------------------------------

  private async runCycle(): Promise<void> {
    const engine = await this.buildEngine();
    if (engine === null) {
      this.updateStatus({ ...IDLE_STATUS });
      return;
    }
    this.updateStatus({ state: 'syncing', paired: true });
    const result = await engine.syncNow();
    if (result.success) {
      this.retryDelayMs = this.retryBaseMs;
      this.updateStatus({
        state: 'up-to-date',
        lastSyncAt: this.now(),
        lastError: null,
        pendingCount: engine.pendingCount(),
      });
      return;
    }
    await this.applyFailure(result.error, engine);
  }

  private async applyFailure(error: SyncError, engine: SyncEngine): Promise<void> {
    const pendingCount = engine.pendingCount();
    const offline = isRelayUnreachable(error);
    this.updateStatus({
      state: offline && pendingCount > 0 ? 'offline-with-pending' : 'error',
      lastError: userFacingSyncMessage(error),
      pendingCount,
    });
    log.warn('[sync] cycle failed', { offline, pendingCount, error: error.message });
  }

  private async buildEngine(): Promise<SyncEngine | null> {
    const credential = await this.deps.getCredentials();
    if (!credential.success || credential.data === null) {
      return null;
    }
    if (this.deviceIdentity === null) {
      this.deviceIdentity = await this.deps.getDeviceIdentity();
    }
    const base = this.deps.createTransport(credential.data.token);
    // Always wrap: a paired machine without a stored space key must fail the
    // push (SyncSpaceKeyMissingError → error status with the re-join message)
    // rather than silently downgrade to plaintext — unencrypted bodies would
    // leak row contents to the relay and wedge every keyed machine's pull.
    const transport = new EncryptingRelayTransport(
      base,
      { get: () => this.deps.getSpaceKey() },
      credential.data.spaceId
    );
    return new SyncEngine({
      sqlite: this.deps.sqlite,
      transport,
      deviceId: this.deviceIdentity.deviceId,
      projectAttachHook: this.deps.projectAttachHook ?? createProjectAutoAttachHook(),
      now: this.now,
    });
  }

  // -------------------------------------------------------------------------
  // Long-poll loop
  // -------------------------------------------------------------------------

  private async runLoop(): Promise<void> {
    while (!this.stopped) {
      const credential = await this.deps.getCredentials();
      if (!credential.success || credential.data === null) {
        // Not paired (yet): keep the status honest, re-check periodically.
        this.updateStatus({ ...IDLE_STATUS });
        await this.sleep(this.notPairedRecheckMs);
        continue;
      }
      try {
        const transport = await this.buildPollTransport(
          credential.data.token,
          credential.data.spaceId
        );
        const engine = await this.buildEngine();
        const cursor = engine === null ? 0 : engine.lastCursor;
        const result = await transport.poll(cursor, this.pollTimeoutMs);
        const reconnected = this.retryDelayMs > this.retryBaseMs;
        this.retryDelayMs = this.retryBaseMs;
        this.updateStatus({ paired: true });
        // A wake-up with patches needs applying; a successful poll after any
        // failure means the connection is back — drain local pending rows.
        if (reconnected || result.patches.length > 0) {
          await this.syncNow();
        } else if (engine !== null && engine.pendingCount() > 0) {
          // The relay is quiet, but this machine has local edits the other
          // machine has not seen (spec #130: pushes on local writes,
          // debounced by the poll cadence). Without this branch a quiet
          // relay would never wake the loop and the edits would wait for a
          // relaunch or a manual Sync now.
          await this.syncNow();
        } else {
          await this.sleep(this.pollIdleDelayMs);
        }
      } catch (error) {
        // The failure path must never itself throw out of the loop: buildEngine
        // (async) and pendingCount (sqlite) inside markPollFailure can reject
        // or throw, and runLoop is fire-and-forget (start() does not await or
        // .catch it), so an escaping error would silently kill background sync
        // until relaunch. Swallow secondary failures and always back off.
        try {
          await this.markPollFailure(error);
        } catch (secondary) {
          log.error('[sync] failure handler threw', secondary);
        }
        await this.sleep(this.retryDelayMs);
        this.retryDelayMs = Math.min(this.retryDelayMs * 2, this.retryMaxMs);
      }
    }
  }

  private async buildPollTransport(token: string, spaceId: string): Promise<RelayTransport> {
    const base = this.deps.createTransport(token);
    // Always wrap (matching buildEngine): body-carrying patches decrypt when a
    // key exists; without one they are flagged undecryptable and skipped —
    // never applied as garbage, never echoed back.
    return new EncryptingRelayTransport(base, { get: () => this.deps.getSpaceKey() }, spaceId);
  }

  private async markPollFailure(error: unknown): Promise<void> {
    // A revoked/removed device keeps getting 401 forever; clear the local
    // credential + key so the loop un-pairs and returns to onboarding instead
    // of spinning on an unrecoverable error.
    if (isAuthRevoked(error)) {
      await this.deps.onAuthRevoked?.();
      this.updateStatus({ ...IDLE_STATUS });
      log.warn('[sync] device token rejected by relay (revoked); cleared local credential');
      return;
    }
    const engine = await this.buildEngine();
    const pendingCount = engine === null ? 0 : engine.pendingCount();
    const offline = isRelayUnreachable(error);
    const syncError: SyncError = {
      type: 'transport',
      message: error instanceof Error ? error.message : String(error),
    };
    this.updateStatus({
      state: offline && pendingCount > 0 ? 'offline-with-pending' : 'error',
      lastError: userFacingSyncMessage(syncError),
      pendingCount,
    });
    log.warn('[sync] poll failed', { offline, pendingCount, error: syncError.message });
  }

  // -------------------------------------------------------------------------
  // Status
  // -------------------------------------------------------------------------

  private updateStatus(patch: Partial<SyncStatus>): void {
    const next: SyncStatus = { ...this.status, ...patch };
    if (
      next.state === this.status.state &&
      next.paired === this.status.paired &&
      next.lastSyncAt === this.status.lastSyncAt &&
      next.lastError === this.status.lastError &&
      next.pendingCount === this.status.pendingCount
    ) {
      return;
    }
    this.status = next;
    this.deps.onStatusChange(next);
  }
}
