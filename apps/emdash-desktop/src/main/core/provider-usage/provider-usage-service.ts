import type {
  ProviderUsageProvider,
  ProviderUsageSnapshot,
  ProviderUsageVisibility,
} from '@shared/core/provider-usage';
import type { ProviderUsageAdapter } from './types';

type Timer = ReturnType<typeof setInterval>;

export type ProviderUsageServiceDependencies = {
  adapters: ProviderUsageAdapter[];
  emit?: (snapshots: ProviderUsageSnapshot[]) => void;
  now?: () => number;
  setInterval?: (callback: () => void, delay: number) => Timer;
  clearInterval?: (timer: Timer) => void;
  pollIntervalMs?: number;
  idleTimeoutMs?: number;
};

export class ProviderUsageService {
  private readonly adapters: Map<ProviderUsageProvider, ProviderUsageAdapter>;
  private readonly snapshots = new Map<ProviderUsageProvider, ProviderUsageSnapshot>();
  private readonly inflight = new Map<
    ProviderUsageProvider,
    Promise<ProviderUsageSnapshot | null>
  >();
  private readonly lastActivity = new Map<ProviderUsageProvider, number>();
  private visibility: ProviderUsageVisibility = { claude: true, codex: true };
  private timer: Timer | null = null;

  constructor(private readonly deps: ProviderUsageServiceDependencies) {
    this.adapters = new Map(deps.adapters.map((adapter) => [adapter.provider, adapter]));
  }

  initialize(visibility: ProviderUsageVisibility): void {
    this.visibility = visibility;
  }

  async getSnapshots(): Promise<ProviderUsageSnapshot[]> {
    await Promise.all(
      [...this.adapters.keys()].map(async (provider) => {
        if (!this.visibility[provider]) return;
        if (!this.snapshots.has(provider)) await this.refresh(provider);
      })
    );
    return this.visibleSnapshots();
  }

  async refresh(provider: ProviderUsageProvider): Promise<ProviderUsageSnapshot | null> {
    if (!this.visibility[provider]) return null;
    const existing = this.inflight.get(provider);
    if (existing) return existing;
    const promise = this.doRefresh(provider).finally(() => this.inflight.delete(provider));
    this.inflight.set(provider, promise);
    return promise;
  }

  async recordActivity(provider: ProviderUsageProvider): Promise<void> {
    if (!this.visibility[provider] || !this.adapters.has(provider)) return;
    this.lastActivity.set(provider, this.now());
    this.ensureTimer();
    await this.refresh(provider);
  }

  async setVisibility(provider: ProviderUsageProvider, visible: boolean): Promise<void> {
    this.visibility = { ...this.visibility, [provider]: visible };
    if (!visible) {
      this.lastActivity.delete(provider);
      this.emit();
      this.stopTimerWhenIdle();
      return;
    }
    await this.refresh(provider);
  }

  dispose(): void {
    if (this.timer) this.clearInterval(this.timer);
    this.timer = null;
  }

  private async doRefresh(provider: ProviderUsageProvider): Promise<ProviderUsageSnapshot | null> {
    const adapter = this.adapters.get(provider);
    if (!adapter || !(await adapter.isAvailable())) {
      this.snapshots.delete(provider);
      this.emit();
      return null;
    }
    const result = await adapter.read();
    if (result.success) {
      this.snapshots.set(provider, result.data);
    } else {
      const cached = this.snapshots.get(provider);
      this.snapshots.set(
        provider,
        cached
          ? { ...cached, error: result.error }
          : {
              provider,
              windows: [],
              lastUpdated: new Date(this.now()).toISOString(),
              error: result.error,
            }
      );
    }
    this.emit();
    return this.snapshots.get(provider) ?? null;
  }

  private ensureTimer(): void {
    if (this.timer) return;
    this.timer = this.setInterval(() => void this.poll(), this.deps.pollIntervalMs ?? 30 * 60_000);
  }

  private async poll(): Promise<void> {
    const now = this.now();
    const idleTimeout = this.deps.idleTimeoutMs ?? 60 * 60_000;
    const active = [...this.lastActivity].filter(
      ([provider, timestamp]) => this.visibility[provider] && now - timestamp < idleTimeout
    );
    this.lastActivity.clear();
    for (const [provider, timestamp] of active) this.lastActivity.set(provider, timestamp);
    if (active.length === 0) {
      this.stopTimerWhenIdle();
      return;
    }
    await Promise.all(active.map(([provider]) => this.refresh(provider)));
  }

  private stopTimerWhenIdle(): void {
    if (!this.timer || this.lastActivity.size > 0) return;
    this.clearInterval(this.timer);
    this.timer = null;
  }

  private visibleSnapshots(): ProviderUsageSnapshot[] {
    return [...this.snapshots.values()].filter((snapshot) => this.visibility[snapshot.provider]);
  }

  private emit(): void {
    this.deps.emit?.(this.visibleSnapshots());
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private setInterval(callback: () => void, delay: number): Timer {
    return (this.deps.setInterval ?? setInterval)(callback, delay);
  }

  private clearInterval(timer: Timer): void {
    (this.deps.clearInterval ?? clearInterval)(timer);
  }
}
