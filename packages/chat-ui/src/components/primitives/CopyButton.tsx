/**
 * CopyButton — shared copy-to-clipboard button.
 *
 * Two variants:
 *   'inline'  — used in the message footer: text label + icon, appears on group-hover.
 *   'overlay' — used in code blocks: icon-only, absolute positioned top-right.
 *
 * State is managed by createClipboard (Lane B — never touches measure).
 */

import { Show } from 'solid-js';
import { IconCheck, IconCopy } from './icons';
import { createClipboard } from './use-clipboard';
import { copyButtonInline, copyButtonOverlay, copyButtonToolbar } from './copy-button.css';

export type CopyButtonProps = {
  text: string;
  /**
   * 'inline'  — message footer: hover-revealed text label + icon.
   * 'overlay' — code blocks: hover-revealed, icon-only, absolute positioned.
   * 'toolbar' — always-visible text label + icon (e.g. the diff card footer).
   */
  variant: 'inline' | 'overlay' | 'toolbar';
  /** aria-label prefix shown before 'Copy' / 'Copied'. Defaults to 'Copy'. */
  label?: string;
};

export function CopyButton(props: CopyButtonProps) {
  const { copied, copy } = createClipboard();
  const label = () => props.label ?? 'Copy';
  const ariaLabel = () => (copied() ? `${label()} — copied` : label());

  if (props.variant === 'overlay') {
    return (
      <button
        type="button"
        class={copyButtonOverlay}
        aria-label={ariaLabel()}
        onClick={() => copy(props.text)}
      >
        <Show when={copied()} fallback={<IconCopy />}>
          <IconCheck />
        </Show>
      </button>
    );
  }

  // 'toolbar' shows its own label text (e.g. "Copy diff"); 'inline' keeps the
  // original fixed "Copy"/"Copied" wording (the aria-label already carries the
  // context-specific label for assistive tech).
  const visibleText = () => {
    if (copied()) return 'Copied';
    return props.variant === 'toolbar' ? label() : 'Copy';
  };

  return (
    <button
      type="button"
      class={props.variant === 'toolbar' ? copyButtonToolbar : copyButtonInline}
      aria-label={ariaLabel()}
      onClick={() => copy(props.text)}
    >
      <Show when={copied()} fallback={<IconCopy />}>
        <IconCheck />
      </Show>
      <span>{visibleText()}</span>
    </button>
  );
}
