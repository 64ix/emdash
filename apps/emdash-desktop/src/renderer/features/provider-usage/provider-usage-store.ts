import { events, rpc } from '@renderer/lib/ipc';
import type { ProviderUsageProvider, ProviderUsageSnapshot } from '@shared/core/provider-usage';
import { providerUsageUpdatedChannel } from '@shared/events/providerUsageEvents';

type ProviderUsageStoreSnapshot = {
  snapshots: ProviderUsageSnapshot[];
  refreshing: ReadonlySet<ProviderUsageProvider>;
};

class ProviderUsageStore {
  private readonly listeners = new Set<() => void>();
  private state: ProviderUsageStoreSnapshot = { snapshots: [], refreshing: new Set() };
  private unsubscribeEvent: (() => void) | null = null;
  private started = false;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    this.start();
    return () => this.listeners.delete(listener);
  };

  readonly getSnapshot = (): ProviderUsageStoreSnapshot => this.state;

  async refresh(provider: ProviderUsageProvider): Promise<void> {
    this.setRefreshing(provider, true);
    try {
      await rpc.providerUsage.refreshProviderUsage(provider);
    } catch {
      // Expected provider failures are represented in snapshots; IPC loss stays unobtrusive.
    } finally {
      this.setRefreshing(provider, false);
    }
  }

  private start(): void {
    if (this.started) return;
    this.started = true;
    this.unsubscribeEvent = events.on(providerUsageUpdatedChannel, (snapshots) => {
      this.state = { ...this.state, snapshots };
      this.notify();
    });
    void rpc.providerUsage
      .getProviderUsage()
      .then((snapshots) => {
        this.state = { ...this.state, snapshots };
        this.notify();
      })
      .catch(() => undefined);
  }

  private setRefreshing(provider: ProviderUsageProvider, refreshing: boolean): void {
    const next = new Set(this.state.refreshing);
    if (refreshing) next.add(provider);
    else next.delete(provider);
    this.state = { ...this.state, refreshing: next };
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

export const providerUsageStore = new ProviderUsageStore();
