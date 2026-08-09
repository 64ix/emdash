import { events, rpc } from '@renderer/lib/ipc';
import type { SyncStatus } from '@shared/core/sync/status';
import { syncStatusChannel } from '@shared/events/syncEvents';

const IDLE: SyncStatus = {
  state: 'idle',
  paired: false,
  lastSyncAt: null,
  lastError: null,
  pendingCount: 0,
};

/**
 * Renderer store for the sync status widget (spec #130, ticket #137),
 * following the `providerUsageStore` pattern: `useSyncExternalStore` on the
 * snapshot, fed by the `sync:status` event and the `sync` RPC namespace.
 * The snapshot is the serializable `SyncStatus` DTO — never mutated in place.
 */
class SyncStore {
  private readonly listeners = new Set<() => void>();
  private state: SyncStatus = IDLE;
  private unsubscribeEvent: (() => void) | null = null;
  private started = false;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    this.start();
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): SyncStatus => this.state;

  /** Runs a sync cycle now and adopts the returned status. */
  async syncNow(): Promise<void> {
    try {
      const status = await rpc.sync.syncNow();
      this.setState(status);
    } catch {
      // IPC loss stays unobtrusive; the next event or refresh recovers.
    }
  }

  /** Re-reads the current status from the main process. */
  async refresh(): Promise<void> {
    try {
      const status = await rpc.sync.getSyncStatus();
      this.setState(status);
    } catch {
      // Unobtrusive, same as syncNow.
    }
  }

  private start(): void {
    if (this.started) return;
    this.started = true;
    this.unsubscribeEvent = events.on(syncStatusChannel, (status) => {
      this.setState(status);
    });
    void this.refresh();
  }

  private setState(status: SyncStatus): void {
    if (this.state === status) return;
    this.state = status;
    for (const listener of this.listeners) listener();
  }
}

export const syncStore = new SyncStore();
