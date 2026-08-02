import { AlertCircle, Gauge, RefreshCw, X } from 'lucide-react';
import { useSyncExternalStore } from 'react';
import { useAppSettingsKey } from '@renderer/features/settings/use-app-settings-key';
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '@renderer/lib/ui/popover';
import { cn } from '@renderer/utils/utils';
import type { ProviderUsageProvider, ProviderUsageSnapshot } from '@shared/core/provider-usage';
import {
  formatResetTime,
  formatUpdatedAge,
  formatUsagePercent,
  getPrimaryUsageWindow,
  isUsageWarning,
} from './provider-usage-formatters';
import { providerUsageStore } from './provider-usage-store';

const PROVIDER_LABELS: Record<ProviderUsageProvider, string> = {
  claude: 'Claude',
  codex: 'Codex',
};

export function ProviderUsageGauges() {
  const state = useSyncExternalStore(providerUsageStore.subscribe, providerUsageStore.getSnapshot);
  const { value: settings, update } = useAppSettingsKey('interface');
  const visible = state.snapshots.filter(
    (snapshot) =>
      (snapshot.provider === 'claude'
        ? settings?.showClaudeUsageGauge
        : settings?.showCodexUsageGauge) ?? true
  );
  if (visible.length === 0) return null;

  return (
    <div className="flex flex-col gap-1 border-b border-border px-2 pb-2">
      {visible.map((snapshot) => (
        <ProviderUsageGauge
          key={snapshot.provider}
          snapshot={snapshot}
          refreshing={state.refreshing.has(snapshot.provider)}
          onRefresh={() => providerUsageStore.refresh(snapshot.provider)}
          onHide={() =>
            update(
              snapshot.provider === 'claude'
                ? { showClaudeUsageGauge: false }
                : { showCodexUsageGauge: false }
            )
          }
        />
      ))}
    </div>
  );
}

function ProviderUsageGauge({
  snapshot,
  refreshing,
  onRefresh,
  onHide,
}: {
  snapshot: ProviderUsageSnapshot;
  refreshing: boolean;
  onRefresh: () => Promise<void>;
  onHide: () => void;
}) {
  const primary = getPrimaryUsageWindow(snapshot);
  const warning = primary ? isUsageWarning(primary.utilization) : false;
  const percent = primary ? formatUsagePercent(primary.utilization) : '--';

  return (
    <Popover onOpenChange={(open) => open && void onRefresh()}>
      <PopoverTrigger
        className="group focus-visible:ring-accent flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs text-foreground-muted outline-none hover:bg-background-quaternary focus-visible:ring-1"
        aria-label={`${PROVIDER_LABELS[snapshot.provider]} usage: ${percent}${snapshot.error ? `; ${snapshot.error.message}` : ''}`}
      >
        {snapshot.error ? (
          <AlertCircle className="size-3.5 shrink-0 text-foreground-warning" />
        ) : (
          <Gauge
            className={cn(
              'size-3.5 shrink-0',
              warning ? 'text-foreground-warning' : 'text-foreground'
            )}
          />
        )}
        <span className="w-12 text-left font-medium text-foreground">
          {PROVIDER_LABELS[snapshot.provider]}
        </span>
        <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-border">
          {primary && (
            <span
              className={cn(
                'block h-full rounded-full transition-[width] duration-300',
                warning ? 'bg-foreground-warning' : 'bg-foreground'
              )}
              style={{ width: `${Math.max(0, Math.min(100, primary.utilization))}%` }}
            />
          )}
        </span>
        <span className={cn('w-8 text-right tabular-nums', warning && 'text-foreground-warning')}>
          {percent}
        </span>
      </PopoverTrigger>
      <PopoverContent side="right" align="end" className="w-72 gap-3 p-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <PopoverTitle className="font-medium text-foreground">
              {PROVIDER_LABELS[snapshot.provider]} usage
            </PopoverTitle>
            <div className="text-[11px] text-foreground-passive">Local account</div>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              className="rounded p-1 text-foreground-muted hover:bg-background-tertiary hover:text-foreground"
              onClick={() => void onRefresh()}
              disabled={refreshing}
              aria-label={`Refresh ${PROVIDER_LABELS[snapshot.provider]} usage`}
            >
              <RefreshCw className={cn('size-3.5', refreshing && 'animate-spin')} />
            </button>
            <button
              type="button"
              className="rounded p-1 text-foreground-muted hover:bg-background-tertiary hover:text-foreground"
              onClick={onHide}
              aria-label={`Hide ${PROVIDER_LABELS[snapshot.provider]} usage gauge`}
            >
              <X className="size-3.5" />
            </button>
          </div>
        </div>
        {snapshot.windows.map((window) => {
          const windowWarning = isUsageWarning(window.utilization);
          return (
            <div key={window.id} className="flex flex-col gap-1.5">
              <div className="flex items-baseline justify-between gap-3 text-xs">
                <span className="text-foreground-muted">{window.label}</span>
                <span
                  className={cn(
                    'font-medium tabular-nums text-foreground',
                    windowWarning && 'text-foreground-warning'
                  )}
                >
                  {formatUsagePercent(window.utilization)}
                </span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-border">
                <div
                  className={cn(
                    'h-full rounded-full',
                    windowWarning ? 'bg-foreground-warning' : 'bg-foreground'
                  )}
                  style={{ width: `${window.utilization}%` }}
                />
              </div>
              <div className="text-[11px] text-foreground-passive">
                {formatResetTime(window.resetsAt)}
              </div>
            </div>
          );
        })}
        {snapshot.error && (
          <div
            role="status"
            className="flex items-start gap-1.5 rounded-md bg-background-warning px-2 py-1.5 text-[11px] text-foreground-warning"
          >
            <AlertCircle className="mt-0.5 size-3 shrink-0" />
            <span>{snapshot.error.message}</span>
          </div>
        )}
        <div className="border-t border-border pt-2 text-[11px] text-foreground-passive">
          {formatUpdatedAge(snapshot.lastUpdated)}
        </div>
      </PopoverContent>
    </Popover>
  );
}
