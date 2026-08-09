import { LaptopIcon, LoaderCircle, PlusIcon, ShieldCheckIcon, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { Badge } from '@renderer/lib/ui/badge';
import { Button } from '@renderer/lib/ui/button';
import { RelativeTime } from '@renderer/lib/ui/relative-time';
import type { SyncDeviceInfo, SyncState } from '@shared/core/sync/pairing';

type LoadState = 'loading' | 'ready' | 'error';

/**
 * Settings "Devices" card for multi-machine sync (spec #130, ticket #135),
 * following the `SshConnectionsSettingsCard` pattern: when this machine is not
 * paired it offers to create a space (first device) or join one with a
 * pairing secret; when paired it lists the space's devices, mints fresh
 * pairing secrets for additional devices, and revokes devices with
 * confirmation.
 */
export function DevicesSettingsCard() {
  const [state, setState] = useState<SyncState | null>(null);
  const [devices, setDevices] = useState<SyncDeviceInfo[] | null>(null);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const showPairingSecret = useShowModal('pairingSecretModal');
  const showJoinSpace = useShowModal('joinSyncSpaceModal');
  const showConfirm = useShowModal('confirmActionModal');

  const refresh = useCallback(async () => {
    setLoadState('loading');
    try {
      const [nextState, nextDevices] = await Promise.all([
        rpc.sync.getState(),
        rpc.sync.listDevices(),
      ]);
      setState(nextState);
      setDevices(nextDevices.success ? nextDevices.devices : null);
      setLoadState('ready');
    } catch {
      setLoadState('error');
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const createSpace = useCallback(async () => {
    const result = await rpc.sync.createSpace();
    if (!result.success) {
      toast({ title: result.message, variant: 'destructive' });
      return;
    }
    await refresh();
    showPairingSecret({ secret: result.secret, deepLink: result.deepLink });
  }, [refresh, showPairingSecret]);

  const mintSecret = useCallback(async () => {
    const result = await rpc.sync.mintSecret();
    if (!result.success) {
      toast({ title: result.message, variant: 'destructive' });
      return;
    }
    showPairingSecret({ secret: result.secret, deepLink: result.deepLink });
  }, [showPairingSecret]);

  const revokeDevice = useCallback(
    async (device: SyncDeviceInfo) => {
      setRevokingId(device.deviceId);
      try {
        const result = await rpc.sync.revokeDevice(device.deviceId);
        if (!result.success) {
          toast({ title: result.message, variant: 'destructive' });
          return;
        }
        toast({ title: `${device.name} was revoked` });
        await refresh();
      } finally {
        setRevokingId(null);
      }
    },
    [refresh]
  );

  const requestRevoke = useCallback(
    (device: SyncDeviceInfo) => {
      showConfirm({
        title: `Revoke ${device.name}?`,
        description: device.self
          ? 'This is this machine. Revoking it removes this device from the sync space and this machine will no longer be able to sync.'
          : `"${device.name}" will no longer be able to access this sync space. This cannot be undone.`,
        confirmLabel: 'Revoke',
        variant: 'destructive',
        onSuccess: () => {
          void revokeDevice(device);
        },
      });
    },
    [showConfirm, revokeDevice]
  );

  if (loadState === 'loading') {
    return (
      <div className="flex items-center gap-2 text-sm text-foreground-passive">
        <LoaderCircle className="size-4 animate-spin" />
        Loading sync devices…
      </div>
    );
  }

  if (loadState === 'error') {
    return (
      <div className="flex flex-col items-start gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h3 className="text-sm font-normal text-foreground">Devices</h3>
          <p className="text-xs text-foreground-passive">Machines attached to this sync space.</p>
        </div>
        <p className="text-sm text-foreground-passive">
          Could not load sync devices. Check the relay configuration and try again.
        </p>
        <Button type="button" variant="outline" onClick={() => void refresh()}>
          Retry
        </Button>
      </div>
    );
  }

  if (state?.paired && devices !== null) {
    return (
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-0.5">
            <h3 className="text-sm font-normal text-foreground">Devices</h3>
            <p className="text-xs text-foreground-passive">
              Machines attached to this sync space. Devices sync project state between each other.
            </p>
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="ghost" onClick={() => showJoinSpace({})}>
              Join
            </Button>
            <Button type="button" variant="ghost" onClick={() => void mintSecret()}>
              <PlusIcon className="size-4" />
              Add device
            </Button>
          </div>
        </div>

        {devices.length === 0 ? (
          <div className="bg-muted/10 flex min-h-40 flex-col items-center justify-center rounded-lg border border-border p-8 text-center">
            <LaptopIcon className="mb-3 size-8 text-foreground-passive" />
            <div className="text-sm text-foreground">No devices</div>
            <p className="mt-1 max-w-sm text-xs text-foreground-passive">
              Pair another machine to sync your tasks and projects across devices.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {devices.map((device) => (
              <div
                key={device.deviceId}
                className="bg-muted/10 flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2"
              >
                <div className="flex min-w-0 flex-col gap-0.5">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm text-foreground">{device.name}</span>
                    {device.self && <Badge variant="secondary">This device</Badge>}
                    {device.revoked && <Badge variant="destructive">Revoked</Badge>}
                  </div>
                  <span className="text-xs text-foreground-passive">
                    {device.lastSeenAt !== null ? (
                      <>
                        Last seen <RelativeTime value={device.lastSeenAt} ago />
                      </>
                    ) : (
                      'Never seen'
                    )}
                  </span>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={revokingId === device.deviceId}
                  onClick={() => requestRevoke(device)}
                  aria-label={`Revoke ${device.name}`}
                >
                  {revokingId === device.deviceId ? (
                    <LoaderCircle className="size-4 animate-spin" />
                  ) : (
                    <Trash2 className="size-4" />
                  )}
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex min-w-0 flex-col gap-0.5">
        <h3 className="text-sm font-normal text-foreground">Devices</h3>
        <p className="text-xs text-foreground-passive">
          Pair this machine with another one to sync tasks and projects between them.
        </p>
      </div>
      <div className="bg-muted/10 flex min-h-48 flex-col items-center justify-center gap-3 rounded-lg border border-border p-8 text-center">
        <ShieldCheckIcon className="size-8 text-foreground-passive" />
        <div className="text-sm text-foreground">Not paired with any device</div>
        <p className="max-w-sm text-xs text-foreground-passive">
          Create a sync space to generate a pairing secret for another machine, or join an existing
          space with a secret from another machine.
        </p>
        <div className="flex gap-2">
          <Button type="button" variant="outline" onClick={() => showJoinSpace({})}>
            Join a space
          </Button>
          <Button type="button" onClick={() => void createSpace()}>
            <PlusIcon className="size-4" />
            Create sync space
          </Button>
        </div>
      </div>
    </div>
  );
}
