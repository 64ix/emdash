import { Check, Copy, LinkIcon } from 'lucide-react';
import { useState } from 'react';
import { toast } from '@renderer/lib/hooks/use-toast';
import type { BaseModalProps } from '@renderer/lib/modal/modal-provider';
import { Button } from '@renderer/lib/ui/button';
import {
  DialogContentArea,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/lib/ui/dialog';
import { PAIRING_SECRET_TTL_MINUTES } from '@shared/core/sync/pairing';

export type PairingSecretModalArgs = {
  /** The single-use pairing secret shown to the user. */
  secret: string;
  /** The `emdash://join?secret=…` deep link for the other machine. */
  deepLink: string;
};

type Props = BaseModalProps<void> & PairingSecretModalArgs;

function copyText(text: string, label: string): void {
  navigator.clipboard
    .writeText(text)
    .then(() => toast({ title: `${label} copied` }))
    .catch(() => toast({ title: `Failed to copy ${label}`, variant: 'destructive' }));
}

/**
 * Shows a freshly minted single-use pairing secret with a copy button and a
 * deep link, plus a warning about its short lifetime. Used both when creating
 * a space (first device) and when minting a secret for an additional device.
 */
export function PairingSecretModal({ secret, deepLink, onSuccess, onClose }: Props) {
  const [copied, setCopied] = useState(false);

  const copySecret = () => {
    setCopied(true);
    void navigator.clipboard.writeText(secret).then(
      () => toast({ title: 'Pairing secret copied' }),
      () => {
        setCopied(false);
        toast({ title: 'Failed to copy pairing secret', variant: 'destructive' });
      }
    );
  };

  const copyDeepLink = () => copyText(deepLink, 'Deep link');

  return (
    <>
      <DialogHeader showCloseButton={false}>
        <DialogTitle>Pair this device</DialogTitle>
      </DialogHeader>
      <DialogContentArea className="flex flex-col gap-3">
        <p className="text-sm text-foreground-passive">
          On the other machine, open <span className="font-medium text-foreground">Devices</span> in
          Settings and paste this secret to join this sync space.
        </p>
        <div className="bg-muted/10 flex items-center gap-2 rounded-lg border border-border p-2">
          <code
            className="min-w-0 flex-1 px-1 font-mono text-xs break-all"
            data-testid="pairing-secret"
          >
            {secret}
          </code>
          <Button type="button" variant="ghost" size="sm" onClick={copySecret}>
            {copied ? <Check className="size-4 text-emerald-500" /> : <Copy className="size-4" />}
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
        <div className="bg-muted/10 flex items-center gap-2 rounded-lg border border-border p-2">
          <LinkIcon className="ml-1 size-4 shrink-0 text-foreground-passive" />
          <code className="min-w-0 flex-1 px-1 font-mono text-xs break-all text-foreground-passive">
            {deepLink}
          </code>
          <Button type="button" variant="ghost" size="sm" onClick={copyDeepLink}>
            <Copy className="size-4" />
            Copy
          </Button>
        </div>
        <p className="text-xs text-foreground-passive">
          The secret is single-use and expires {PAIRING_SECRET_TTL_MINUTES} minutes after it is
          created. Anyone with it can join this sync space.
        </p>
      </DialogContentArea>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Close
        </Button>
        <Button variant="default" onClick={() => onSuccess()}>
          Done
        </Button>
      </DialogFooter>
    </>
  );
}
