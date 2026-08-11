import { CheckCircle2, LoaderCircle } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { Button } from '@renderer/lib/ui/button';
import { Input } from '@renderer/lib/ui/input';
import { Label } from '@renderer/lib/ui/label';
import type { RelaySettingsView } from '@shared/core/sync/pairing';

/**
 * Settings card for the self-operated sync relay (spec #130): this fork ships
 * no default relay, so the URL and pre-shared key are entered by hand on each
 * machine. The key is stored machine-locally (safeStorage) and never sent back
 * to the renderer. Environment variables, when set, override these and make the
 * form read-only.
 */
export function RelaySettingsCard({
  onConfiguredChange,
}: {
  onConfiguredChange?: (configured: boolean) => void;
}) {
  const [view, setView] = useState<RelaySettingsView | null>(null);
  const [url, setUrl] = useState('');
  const [key, setKey] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    const next = await rpc.sync.getRelaySettings();
    setView(next);
    setUrl(next.url ?? '');
    setKey('');
    onConfiguredChange?.(next.configured);
  }, [onConfiguredChange]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(async () => {
    setSaving(true);
    try {
      const result = await rpc.sync.setRelaySettings({ url: url.trim(), key: key.trim() });
      if (!result.success) {
        toast({ title: result.message, variant: 'destructive' });
        return;
      }
      toast({ title: 'Relay settings saved' });
      await load();
    } finally {
      setSaving(false);
    }
  }, [url, key, load]);

  if (view === null) {
    return (
      <div className="flex items-center gap-2 text-sm text-foreground-passive">
        <LoaderCircle className="size-4 animate-spin" />
        Loading relay settings…
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex min-w-0 flex-col gap-0.5">
        <h3 className="text-sm font-normal text-foreground">Sync relay</h3>
        <p className="text-xs text-foreground-passive">
          Your self-operated relay (a Cloudflare Worker — see apps/sync-relay/README.md). Enter its
          URL and pre-shared key on each machine; the key never leaves this machine and is required
          before pairing.
        </p>
      </div>

      {view.envManaged ? (
        <div className="bg-muted/10 flex flex-col gap-1 rounded-lg border border-border px-3 py-2 text-sm">
          <span className="text-foreground">Managed by environment variables</span>
          <span className="text-xs text-foreground-passive">
            {view.url ?? 'No URL set'} · {view.hasKey ? 'key set' : 'no key'} —
            EMDASH_SYNC_RELAY_URL / EMDASH_SYNC_RELAY_KEY override the in-app settings.
          </span>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="relay-url">Relay URL</Label>
            <Input
              id="relay-url"
              type="url"
              placeholder="https://emdash-sync-relay.<subdomain>.workers.dev"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="relay-key">Relay key</Label>
            <Input
              id="relay-key"
              type="password"
              autoComplete="off"
              placeholder={
                view.hasKey ? 'A key is set — enter it again to change' : 'Your relay key'
              }
              value={key}
              onChange={(event) => setKey(event.target.value)}
            />
          </div>
          <div className="flex items-center gap-3">
            <Button type="button" disabled={saving} onClick={() => void save()}>
              {saving ? <LoaderCircle className="size-4 animate-spin" /> : 'Save'}
            </Button>
            {view.configured && (
              <span className="flex items-center gap-1 text-xs text-foreground-passive">
                <CheckCircle2 className="size-3.5" />
                Relay configured
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
