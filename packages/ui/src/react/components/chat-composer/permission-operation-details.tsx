/**
 * PermissionOperationDetails — the expandable "what exactly is being asked"
 * body for a composer permission request (ticket #32, spec #18). Renders the
 * normalized command/path/content/diff, additional parameters, affected
 * resources, and defensible risk cues `describePermissionOperation` (app
 * layer) computed from the ACP tool call, plus a "View in transcript" jump
 * back to the originating tool-call row.
 *
 * Every bounded text block shows its own explicit truncation note — never a
 * silent CSS ellipsis — and a per-block Copy action that always copies the
 * *full* (redacted, unbounded) text, never the bounded view.
 */

import { cx } from '@styles/utilities/cx';
import { CheckIcon, CopyIcon } from 'lucide-react';
import * as React from 'react';
import { Button } from '@/react/primitives/button';
import { Collapsible } from '@/react/primitives/collapsible';
import * as styles from './permission-operation-details.css';

// ── Types ─────────────────────────────────────────────────────────────────────

export type ComposerPermissionTextBlock = {
  /** Bounded, redacted text safe to render directly. */
  text: string;
  truncated: boolean;
  omittedChars: number;
  /** Full redacted (never bounded) text — Copy must always use this. */
  fullText: string;
};

export type ComposerPermissionParam = { label: string; value: string };

export type ComposerPermissionResource =
  | { kind: 'path'; path: string }
  | { kind: 'url'; url: string };

export type ComposerPermissionOperation = {
  operationLabel: string;
  scope: string;
  command?: ComposerPermissionTextBlock;
  path?: string;
  content?: ComposerPermissionTextBlock;
  diff?: { oldText: ComposerPermissionTextBlock; newText: ComposerPermissionTextBlock };
  params: ComposerPermissionParam[];
  resources: ComposerPermissionResource[];
  riskCues: string[];
  rawToolKind?: string | null;
};

export interface PermissionOperationDetailsProps {
  operation: ComposerPermissionOperation;
  itemId?: string;
  onJumpToOrigin?: (itemId: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  className?: string;
}

// ── Copy button ───────────────────────────────────────────────────────────────

function CopyIconButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = React.useState(false);
  const timeoutRef = React.useRef<number | null>(null);

  React.useEffect(
    () => () => {
      if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
    },
    []
  );

  const handleCopy = React.useCallback(() => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true);
      timeoutRef.current = window.setTimeout(() => setCopied(false), 1500);
    });
  }, [text]);

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      icon
      aria-label={label}
      onClick={handleCopy}
      className={styles.copyButton}
    >
      {copied ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
    </Button>
  );
}

// ── Bounded text section ──────────────────────────────────────────────────────

function TextBlockSection({
  label,
  block,
}: {
  label: string;
  block: ComposerPermissionTextBlock;
}) {
  return (
    <div className={styles.textSection}>
      <div className={styles.textSectionHeader}>
        <span className={styles.metaLabel}>{label}</span>
        <CopyIconButton text={block.fullText} label={`Copy ${label.toLowerCase()}`} />
      </div>
      <pre className={styles.textBlock}>{block.text.length > 0 ? block.text : '(empty)'}</pre>
      {block.truncated && (
        <span className={styles.truncatedNote}>
          {block.omittedChars.toLocaleString()} more character
          {block.omittedChars === 1 ? '' : 's'} not shown — use Copy for the full text.
        </span>
      )}
    </div>
  );
}

// ── PermissionOperationDetails ────────────────────────────────────────────────

export function PermissionOperationDetails({
  operation,
  itemId,
  onJumpToOrigin,
  open,
  onOpenChange,
  className,
}: PermissionOperationDetailsProps) {
  return (
    <Collapsible.Root open={open} onOpenChange={onOpenChange} className={cx(styles.root, className)}>
      <Collapsible.Trigger>Details</Collapsible.Trigger>
      <Collapsible.Panel className={styles.panel}>
        <div className={styles.metaRow}>
          <span className={styles.metaLabel}>Operation</span>
          <span>{operation.operationLabel}</span>
        </div>
        <div className={styles.metaRow}>
          <span className={styles.metaLabel}>Scope</span>
          <span>{operation.scope}</span>
        </div>

        {operation.path && (
          <div className={styles.metaRow}>
            <span className={styles.metaLabel}>Path</span>
            <code className={styles.inlineCode}>{operation.path}</code>
          </div>
        )}

        {operation.command && <TextBlockSection label="Command" block={operation.command} />}
        {operation.content && <TextBlockSection label="Content" block={operation.content} />}
        {operation.diff && (
          <>
            <TextBlockSection label="Current content" block={operation.diff.oldText} />
            <TextBlockSection label="New content" block={operation.diff.newText} />
          </>
        )}

        {operation.params.map((param) => (
          <div key={param.label} className={styles.metaRow}>
            <span className={styles.metaLabel}>{param.label}</span>
            <span className={styles.paramValue}>{param.value}</span>
          </div>
        ))}

        {operation.resources.length > 0 && (
          <div className={styles.resourcesList}>
            <span className={styles.metaLabel}>Affected</span>
            <ul className={styles.resourcesList}>
              {operation.resources.map((resource, index) => (
                <li key={index} className={styles.resourceItem}>
                  {resource.kind === 'url' ? resource.url : resource.path}
                </li>
              ))}
            </ul>
          </div>
        )}

        {operation.riskCues.length > 0 && (
          <ul className={styles.riskCues}>
            {operation.riskCues.map((cue, index) => (
              <li key={index}>{cue}</li>
            ))}
          </ul>
        )}

        {itemId && onJumpToOrigin && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={styles.jumpButton}
            onClick={() => onJumpToOrigin(itemId)}
          >
            View in transcript
          </Button>
        )}
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}
