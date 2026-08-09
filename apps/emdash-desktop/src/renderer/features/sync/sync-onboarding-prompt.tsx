import { ArrowRight, Plus, X } from 'lucide-react';
import { useState } from 'react';
import { useSyncExternalStore } from 'react';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { syncStore } from './sync-store';

/**
 * First-run onboarding prompt for multi-machine sync (spec #130, ticket
 * #137): shown in the left sidebar while this machine has no sync space. The
 * PRIMARY action is joining an existing space by pasting the pairing secret
 * (reuses the join-sync-space-modal); the secondary action creates a fresh
 * space (reuses the createSpace flow + pairing-secret-modal). Dismissible for
 * the session; it resurfaces on the next launch while no space exists.
 */
export function SyncOnboardingPrompt() {
  const status = useSyncExternalStore(syncStore.subscribe, syncStore.getSnapshot);
  const [dismissed, setDismissed] = useState(false);

  const showJoin = useShowModal('joinSyncSpaceModal');
  const showPairingSecret = useShowModal('pairingSecretModal');

  if (status.paired || dismissed) return null;

  const createSpace = async () => {
    const result = await rpc.sync.createSpace();
    if (!result.success) {
      toast({ title: result.message, variant: 'destructive' });
      return;
    }
    showPairingSecret({ secret: result.secret, deepLink: result.deepLink });
  };

  return (
    <div
      data-testid="sync-onboarding-prompt"
      className="mx-2 mb-1 flex flex-col gap-2 rounded-lg border border-border bg-background-quaternary/60 px-3 py-2.5"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="text-xs font-medium text-foreground">Sync this machine</span>
          <span className="text-[11px] leading-snug text-foreground-passive">
            Pair with another machine to sync tasks and projects between them.
          </span>
        </div>
        <button
          type="button"
          aria-label="Dismiss sync onboarding"
          onClick={() => setDismissed(true)}
          className="rounded p-0.5 text-foreground-muted hover:bg-background-tertiary hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      </div>
      <div className="flex flex-col gap-1.5">
        <button
          type="button"
          data-testid="sync-onboarding-join"
          onClick={() => showJoin({})}
          className="focus-visible:ring-accent flex items-center justify-center gap-1.5 rounded-md bg-foreground px-2 py-1.5 text-xs font-medium text-background outline-none hover:opacity-90 focus-visible:ring-1"
        >
          <ArrowRight className="size-3.5" aria-hidden />
          Join an existing space
        </button>
        <button
          type="button"
          data-testid="sync-onboarding-create"
          onClick={() => void createSpace()}
          className="focus-visible:ring-accent flex items-center justify-center gap-1.5 rounded-md border border-border px-2 py-1.5 text-xs font-medium text-foreground-muted outline-none hover:bg-background-tertiary hover:text-foreground focus-visible:ring-1"
        >
          <Plus className="size-3.5" aria-hidden />
          Start from scratch
        </button>
      </div>
    </div>
  );
}
