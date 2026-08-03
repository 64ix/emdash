/**
 * TranscriptOutlinePanel — a compact outline of user prompts and
 * assistant/agent turns (ticket #34, spec #18).
 *
 * Renders `AcpChatStore.outline` as a navigable list. Selecting an entry
 * calls `onSelect`, which the host wires to `store.scrollToOutlineEntry` —
 * this component never touches scroll/DOM itself, matching the app's
 * pattern of keeping chat-ui/the ACP adapter as the single owner of the
 * transcript's scroll and virtualizer state.
 *
 * Presentation only: a single component (not two separately mounted trees)
 * so `wide`/narrow re-layout never loses local selection or focus state —
 * only the `wide` prop changes how it is positioned by the caller (in-flow
 * rail vs. an absolutely-positioned overlay drawer). See
 * `OUTLINE_NARROW_BREAKPOINT_PX` for the breakpoint the host measures against.
 */

import type { OutlineEntry } from '@emdash/chat-ui';
import { X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { Button } from '@renderer/lib/ui/button';
import { MicroLabel } from '@renderer/lib/ui/label';
import { cn } from '@renderer/utils/utils';

/**
 * Panel width (px) below which the outline renders as an overlay drawer
 * instead of an in-flow rail that shrinks the transcript column. Measured by
 * the host against the chat panel's own width (not the window's), since a
 * split pane can be narrow even in a wide window.
 */
export const OUTLINE_NARROW_BREAKPOINT_PX = 640;

export const OUTLINE_RAIL_WIDTH_PX = 280;

function statusLabel(status: OutlineEntry['status']): string {
  switch (status) {
    case 'current':
      return 'In progress';
    case 'error':
      return 'Failed';
    case 'cancelled':
      return 'Cancelled';
    default:
      return 'Completed';
  }
}

function roleLabel(role: OutlineEntry['role']): string {
  return role === 'prompt' ? 'Prompt' : 'Turn';
}

export type TranscriptOutlinePanelProps = {
  entries: readonly OutlineEntry[];
  /** Render as an in-flow rail (true) or an absolutely-positioned drawer (false). */
  wide: boolean;
  /** Stable itemId of the entry that should read as "current selection", if any. */
  selectedItemId: string | null;
  onSelect: (entry: OutlineEntry) => void;
  onClose: () => void;
  /** Element focus returns to when the panel closes. */
  returnFocusRef?: React.RefObject<HTMLElement | null>;
};

export function TranscriptOutlinePanel({
  entries,
  wide,
  selectedItemId,
  onSelect,
  onClose,
  returnFocusRef,
}: TranscriptOutlinePanelProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Move focus into the panel when it mounts, and return it to the toggle
  // control that opened it on unmount — in both layouts, since the toggle
  // stays mounted and interactive the whole time the panel is open (see
  // AcpChatPanel). `trigger` is captured once: the toggle button is a stable
  // node for the entire time this panel exists, so reading it here (rather
  // than inside the cleanup) is safe and keeps the effect's dependency array
  // accurate.
  useEffect(() => {
    headingRef.current?.focus();
    const trigger = returnFocusRef?.current ?? null;
    return () => {
      trigger?.focus();
    };
  }, [returnFocusRef]);

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
    }
  };

  return (
    <div
      className={cn(
        'flex h-full flex-col overflow-hidden border-l border-border bg-background-secondary-1',
        wide ? 'relative' : 'absolute inset-y-0 right-0 z-20 shadow-lg'
      )}
      style={{ width: OUTLINE_RAIL_WIDTH_PX }}
      onKeyDown={handleKeyDown}
    >
      <div className="flex shrink-0 items-center justify-between px-3 py-2.5">
        <h2
          ref={headingRef}
          tabIndex={-1}
          className="text-sm font-medium tracking-tight text-foreground outline-none"
        >
          Outline
        </h2>
        <Button variant="ghost" size="icon-xs" aria-label="Close outline" onClick={onClose}>
          <X className="size-3.5" />
        </Button>
      </div>
      <nav
        aria-label="Transcript outline"
        className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-2 pb-2"
      >
        {entries.length === 0 ? (
          <p className="px-2 py-1.5 text-xs text-foreground-muted">Nothing to show yet.</p>
        ) : (
          entries.map((entry) => {
            const isSelected = entry.itemId === selectedItemId;
            return (
              <button
                key={entry.itemId}
                type="button"
                aria-current={isSelected ? 'true' : undefined}
                onClick={() => onSelect(entry)}
                className={cn(
                  'flex flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left hover:bg-background-2',
                  isSelected && 'bg-background-2'
                )}
              >
                <MicroLabel className="text-[10px] uppercase">{roleLabel(entry.role)}</MicroLabel>
                <span className="line-clamp-2 w-full text-sm text-foreground">
                  {entry.preview || (entry.role === 'prompt' ? 'Prompt' : 'Turn')}
                </span>
                <span className="text-xs text-foreground-muted">{statusLabel(entry.status)}</span>
              </button>
            );
          })
        )}
      </nav>
    </div>
  );
}
