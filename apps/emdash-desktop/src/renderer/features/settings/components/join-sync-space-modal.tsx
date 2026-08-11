import { useCallback, useState } from 'react';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import type { BaseModalProps } from '@renderer/lib/modal/modal-provider';
import { Button } from '@renderer/lib/ui/button';
import { ConfirmButton } from '@renderer/lib/ui/confirm-button';
import {
  DialogContentArea,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/lib/ui/dialog';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@renderer/lib/ui/field';
import { Input } from '@renderer/lib/ui/input';
import { JOIN_SECRET_PREFIX } from '@shared/core/sync/pairing';

export type JoinSyncSpaceModalArgs = {
  /** Pre-fill the secret field (from an `emdash://join` deep link). */
  initialSecret?: string;
};

type Props = BaseModalProps<void> & JoinSyncSpaceModalArgs;

/**
 * Joins a sync space by pasting a pairing secret generated on another device.
 * The secret is only sent after the user confirms — a deep link pre-fills the
 * field but never auto-joins.
 */
export function JoinSyncSpaceModal({ initialSecret = '', onSuccess, onClose }: Props) {
  const [secret, setSecret] = useState(initialSecret);
  const [deviceName, setDeviceName] = useState('');
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const join = useCallback(async () => {
    setJoining(true);
    setError(null);
    try {
      const result = await rpc.sync.joinSpace(secret, deviceName.trim() || undefined);
      if (!result.success) {
        setError(result.message);
        return;
      }
      toast({ title: 'Device paired with the sync space' });
      onSuccess();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setJoining(false);
    }
  }, [secret, deviceName, onSuccess]);

  return (
    <>
      <DialogHeader showCloseButton={false}>
        <DialogTitle>Join a sync space</DialogTitle>
      </DialogHeader>
      <DialogContentArea className="flex flex-col gap-4">
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="join-secret">Pairing secret</FieldLabel>
            <Input
              id="join-secret"
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
              placeholder={JOIN_SECRET_PREFIX}
              spellCheck={false}
              autoFocus={secret === ''}
            />
            <FieldDescription>
              Copy the full secret shown on the other device. It is single-use and expires 15
              minutes after it is created.
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="join-device-name">Device name (optional)</FieldLabel>
            <Input
              id="join-device-name"
              value={deviceName}
              onChange={(event) => setDeviceName(event.target.value)}
              placeholder="This machine's hostname"
            />
            <FieldDescription>
              How this device will appear in the other machine's list.
            </FieldDescription>
          </Field>
        </FieldGroup>
        {error !== null && <FieldError>{error}</FieldError>}
      </DialogContentArea>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <ConfirmButton onClick={() => void join()} disabled={joining || secret.trim() === ''}>
          {joining ? 'Joining…' : 'Join'}
        </ConfirmButton>
      </DialogFooter>
    </>
  );
}
