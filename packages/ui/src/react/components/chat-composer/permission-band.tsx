/**
 * PermissionBand — a composer-docked band that surfaces an ACP permission
 * request to the user.
 *
 * Renders flush above the composer input box, styled like NoticeBand but with
 * a SplitButton instead of a dismiss button.  A "1 of N" counter is shown when
 * multiple requests are queued, so the user knows more are coming.
 *
 * Tone mapping from ACP PermissionOption.kind:
 *   allow_*  → accept
 *   reject_* → reject
 *   other    → neutral
 */

import { cx } from '@styles/utilities/cx';
import { Loader2Icon, ShieldAlertIcon } from 'lucide-react';
import * as React from 'react';
import { Button } from '@/react/primitives/button';
import { SplitButton, type SplitButtonOption } from '@/react/primitives/split-button';
import * as styles from './permission-band.css';
import {
  PermissionOperationDetails,
  type ComposerPermissionOperation,
} from './permission-operation-details';

export type {
  ComposerPermissionOperation,
  ComposerPermissionParam,
  ComposerPermissionResource,
  ComposerPermissionTextBlock,
} from './permission-operation-details';

// ── Types ─────────────────────────────────────────────────────────────────────

export type ComposerPermissionOption = {
  optionId: string;
  name: string;
  kind: string;
};

export type ComposerPermissionRequest = {
  requestId: string;
  /** Pre-formatted action verb, e.g. "Read a File", "Execute". */
  title: string;
  /** Stable transcript item id for the originating tool call, for "jump to origin". */
  itemId?: string;
  /** Normalized command/path/params/scope/resources/risk-cues for the full-context review (ticket #32). */
  operation?: ComposerPermissionOperation;
  options: ComposerPermissionOption[];
};

/** Resolution state for the request currently shown — see `AcpChatStore.permissionResolution`. */
export type PermissionResolutionView =
  | { status: 'resolving' }
  | { status: 'error'; message: string };

export interface PermissionBandProps {
  request: ComposerPermissionRequest;
  /** Total pending count including this one. Used to render "1 of N". */
  queueCount?: number;
  /** Called with the chosen optionId. Rejection is represented by reject_* options. */
  onResolve: (optionId: string) => void;
  /** Pending/error state for `request`. Disables the action while resolving and offers Retry on failure. */
  resolution?: PermissionResolutionView | null;
  /** Retry the last-attempted option after a failed resolution. Required for the error state's Retry button. */
  onRetry?: () => void;
  /** Jump the transcript to the originating tool call. The band itself never scrolls, so this always stays reachable. */
  onJumpToOrigin?: (itemId: string) => void;
  className?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function kindToTone(kind: string): SplitButtonOption['tone'] {
  if (kind.startsWith('allow_')) return 'accept';
  if (kind.startsWith('reject_')) return 'reject';
  return 'neutral';
}

/**
 * Choose the option the SplitButton's primary face shows/acts on first.
 * Standard `allow_once` (then any `allow_*`) is preferred, matching the
 * common case. When a request's options carry no recognized `allow_*` kind
 * (an unclassified/extended kind from the provider), the prominent default
 * must never be an option we cannot classify — prefer a recognized `reject_*`
 * kind instead, and only fall back to the first option when nothing
 * recognized exists at all. This never leaves the *initial* choice pointed at
 * an option whose semantics we cannot verify.
 */
function defaultSelectedId(options: ComposerPermissionOption[]): string | undefined {
  return (
    options.find((o) => o.kind === 'allow_once')?.optionId ??
    options.find((o) => o.kind.startsWith('allow_'))?.optionId ??
    options.find((o) => o.kind === 'reject_once')?.optionId ??
    options.find((o) => o.kind.startsWith('reject_'))?.optionId ??
    options[0]?.optionId
  );
}

// ── PermissionBand ────────────────────────────────────────────────────────────

export function PermissionBand({
  request,
  queueCount = 1,
  onResolve,
  resolution,
  onRetry,
  onJumpToOrigin,
  className,
}: PermissionBandProps) {
  const splitOptions: SplitButtonOption[] = request.options.map((o) => ({
    id: o.optionId,
    label: o.name,
    tone: kindToTone(o.kind),
  }));

  const [selectedId, setSelectedId] = React.useState<string | undefined>(() =>
    defaultSelectedId(request.options)
  );
  // The full-context details disclosure defaults to *expanded* for every new
  // request — the concrete command/path/params/risk-cues must be visible
  // before the user approves, not hidden behind an extra click by default.
  // Still collapsible for a batch of low-risk/already-reviewed requests.
  const [detailsOpen, setDetailsOpen] = React.useState(true);

  // Reset selection/details when the request changes (a new request came in after resolving).
  // request.options is intentionally excluded: we only want to reset on a new request (new requestId),
  // not every time the options array reference changes while the same request is displayed.
  React.useEffect(() => {
    setSelectedId(defaultSelectedId(request.options));
    setDetailsOpen(true);
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [request.requestId]);

  const isResolving = resolution?.status === 'resolving';

  return (
    <div className={cx(styles.bandContainer, className)}>
      <div className={styles.band}>
        <ShieldAlertIcon className={styles.bandIcon} aria-hidden />

        {/* Context label */}
        <span className={styles.bandLabel}>
          <span className={styles.bandLabelStrong}>Allow</span> <span>{request.title}</span>
          {queueCount > 1 && (
            <span className={styles.bandCounter}>
              ({1} of {queueCount})
            </span>
          )}
        </span>

        {isResolving && (
          <span className={styles.resolvingRow} role="status">
            <Loader2Icon className={styles.resolvingIconSpin} aria-hidden />
            Resolving…
          </span>
        )}

        {/* Split button */}
        <SplitButton
          options={splitOptions}
          selectedId={selectedId}
          onSelectedChange={setSelectedId}
          onAction={onResolve}
          disabled={isResolving}
          size="sm"
          variant="secondary"
          className={styles.bandAction}
        />
      </div>

      {resolution?.status === 'error' && (
        <div className={cx(styles.bandSection, styles.bandSectionDivider, styles.errorRow)} role="alert">
          <span className={styles.errorMessage} title={resolution.message}>
            {resolution.message}
          </span>
          {onRetry && (
            <Button type="button" variant="secondary" size="sm" onClick={onRetry}>
              Retry
            </Button>
          )}
        </div>
      )}

      {request.operation && (
        <div className={cx(styles.bandSection, styles.bandSectionDivider)}>
          <PermissionOperationDetails
            operation={request.operation}
            itemId={request.itemId}
            onJumpToOrigin={onJumpToOrigin}
            open={detailsOpen}
            onOpenChange={setDetailsOpen}
          />
        </div>
      )}
    </div>
  );
}
