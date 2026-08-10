import {
  AlertCircle,
  CheckCircle2,
  Cloud,
  CloudOff,
  KeyRound,
  LoaderCircle,
  RefreshCw,
  X,
} from 'lucide-react';
import { useSyncExternalStore } from 'react';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import {
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverTitle,
  PopoverTrigger,
} from '@renderer/lib/ui/popover';
import { RelativeTime } from '@renderer/lib/ui/relative-time';
import { cn } from '@renderer/utils/utils';
import type { SyncStatus } from '@shared/core/sync/status';
import { syncStore } from './sync-store';

/**
 * Sidebar footer status widget for multi-machine sync (spec #130, ticket
 * #137), following the provider-usage gauge pattern: a compact row with a
 * per-state icon, an always-visible "Sync now" action, and a popover with the
 * last successful sync time and any error.
 *
 * States: syncing (spinner) / up-to-date (check) / offline-with-pending
 * (cloud-off + pending badge) / error (alert) / idle (cloud — not paired; the
 * onboarding prompt covers first-run and "Sync now" opens the join modal).
 */
const STATE_LABELS: Record<SyncStatus['state'], string> = {
  idle: 'Sync is off — not paired with a sync space',
  syncing: 'Syncing…',
  'up-to-date': 'Everything is synced',
  'offline-with-pending': 'Offline with local changes waiting to sync',
  error: 'Sync error',
};

export function SyncStatusWidget() {
  const status = useSyncExternalStore(syncStore.subscribe, syncStore.getSnapshot);

  return (
    <div className="flex items-center gap-1 border-b border-border px-2 py-1.5">
      <SyncStatusTrigger status={status} />
      <SyncNowButton status={status} />
    </div>
  );
}

function SyncStatusTrigger({ status }: { status: SyncStatus }) {
  return (
    <Popover onOpenChange={(open) => open && void syncStore.refresh()}>
      <PopoverTrigger
        className="group focus-visible:ring-accent flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs text-foreground-muted outline-none hover:bg-background-quaternary focus-visible:ring-1"
        aria-label={`Sync status: ${STATE_LABELS[status.state]}${status.lastError ? `; ${status.lastError}` : ''}`}
      >
        <SyncStateIcon status={status} />
        <span className="min-w-0 flex-1 truncate font-medium text-foreground">Sync</span>
        {status.pendingCount > 0 && (
          <span
            data-testid="sync-pending-badge"
            className="rounded-full bg-foreground-warning/15 px-1.5 py-0.5 text-[10px] font-medium text-foreground-warning tabular-nums"
          >
            {status.pendingCount}
          </span>
        )}
      </PopoverTrigger>
      <PopoverContent side="right" align="end" className="w-72 gap-3 p-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <PopoverTitle className="font-medium text-foreground">Sync</PopoverTitle>
            <div className="text-[11px] text-foreground-passive">
              {status.paired ? 'Multi-machine sync' : 'Not paired with a sync space'}
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              className="rounded p-1 text-foreground-muted hover:bg-background-tertiary hover:text-foreground"
              onClick={() => void syncStore.syncNow()}
              disabled={status.state === 'syncing'}
              aria-label="Sync now"
            >
              <RefreshCw className={cn('size-3.5', status.state === 'syncing' && 'animate-spin')} />
            </button>
            <PopoverClose
              className="rounded p-1 text-foreground-muted hover:bg-background-tertiary hover:text-foreground"
              aria-label="Close sync status details"
            >
              <X className="size-3.5" />
            </PopoverClose>
          </div>
        </div>
        <div className="flex items-center justify-between gap-3 text-xs">
          <span className="text-foreground-muted">Last sync</span>
          <span
            className={cn(
              'font-medium tabular-nums text-foreground',
              status.state === 'error' && 'text-foreground-warning'
            )}
          >
            {status.lastSyncAt !== null ? <RelativeTime value={status.lastSyncAt} ago /> : 'never'}
          </span>
        </div>
        {status.pendingCount > 0 && (
          <div
            role="status"
            className="flex items-start gap-1.5 rounded-md bg-background-warning px-2 py-1.5 text-[11px] text-foreground-warning"
          >
            <CloudOff className="mt-0.5 size-3 shrink-0" />
            <span>
              {status.pendingCount} change{status.pendingCount === 1 ? '' : 's'} waiting to sync.
            </span>
          </div>
        )}
        {(status.quarantinedCount ?? 0) > 0 && (
          <div
            role="status"
            className="flex items-start gap-1.5 rounded-md bg-background-warning px-2 py-1.5 text-[11px] text-foreground-warning"
          >
            <KeyRound className="mt-0.5 size-3 shrink-0" />
            <span>
              {status.quarantinedCount} row{status.quarantinedCount === 1 ? '' : 's'} can&apos;t be
              decrypted yet — waiting for the space key. They&apos;ll sync automatically once it
              arrives.
            </span>
          </div>
        )}
        {status.lastError && (
          <div
            role="status"
            className="flex items-start gap-1.5 rounded-md bg-background-warning px-2 py-1.5 text-[11px] text-foreground-warning"
          >
            <AlertCircle className="mt-0.5 size-3 shrink-0" />
            <span>{status.lastError}</span>
          </div>
        )}
        <div className="border-t border-border pt-2 text-[11px] text-foreground-passive">
          {STATE_LABELS[status.state]}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function SyncStateIcon({ status }: { status: SyncStatus }) {
  switch (status.state) {
    case 'syncing':
      return <LoaderCircle className="size-3.5 shrink-0 animate-spin text-foreground" />;
    case 'up-to-date':
      return <CheckCircle2 className="size-3.5 shrink-0 text-foreground" />;
    case 'offline-with-pending':
      return <CloudOff className="size-3.5 shrink-0 text-foreground-warning" />;
    case 'error':
      return <AlertCircle className="size-3.5 shrink-0 text-foreground-warning" />;
    case 'idle':
      return <Cloud className="size-3.5 shrink-0 text-foreground-passive" />;
  }
}

/**
 * The always-visible "Sync now" action. When not paired it surfaces the
 * primary onboarding action (join a space by pasting the secret).
 */
function SyncNowButton({ status }: { status: SyncStatus }) {
  const showJoin = useShowModal('joinSyncSpaceModal');
  const syncing = status.state === 'syncing';

  const onClick = () => {
    if (status.paired) {
      void syncStore.syncNow();
    } else {
      showJoin({});
    }
  };

  return (
    <button
      type="button"
      data-testid="sync-now-button"
      onClick={onClick}
      disabled={syncing}
      aria-label={status.paired ? 'Sync now' : 'Join a sync space'}
      title={status.paired ? 'Sync now' : 'Join a sync space'}
      className="focus-visible:ring-accent shrink-0 rounded-md px-1.5 py-1.5 text-foreground-muted outline-none hover:bg-background-quaternary hover:text-foreground focus-visible:ring-1 disabled:cursor-default disabled:opacity-60"
    >
      <RefreshCw className={cn('size-3.5', syncing && 'animate-spin')} />
    </button>
  );
}
