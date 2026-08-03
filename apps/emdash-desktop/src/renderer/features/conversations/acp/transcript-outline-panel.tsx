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
 * Two presentations share the list content (`TranscriptOutlineList`):
 *
 *   - `TranscriptOutlineRail` — an in-flow rail for wide layouts. A plain,
 *     non-modal panel: focus moves in on mount and returns to the toggle on
 *     unmount, but the transcript behind it stays reachable (it never
 *     covers the whole surface).
 *   - `TranscriptOutlineDrawer` — a narrow-layout overlay. Unlike the old
 *     single hand-rolled overlay (ticket #26 debt), this is built on the same
 *     base-ui `Sheet` primitive `ChangesDrawer` (#29) uses, so it gets a real
 *     `role="dialog"` + a focus trap for free instead of a second hand-rolled
 *     one — Escape, backdrop dismissal, and initial/return focus all come
 *     from `@base-ui/react`'s Dialog, not bespoke listeners.
 *
 * The host (`AcpChatPanel`) mounts whichever one applies for the current
 * `OUTLINE_NARROW_BREAKPOINT_PX` crossing — the same rail-vs-drawer split
 * `ChangesRail`/`ChangesDrawer` already use. Crossing the breakpoint while
 * open remounts the panel (a real, if rare, layout change from an inline
 * rail to a modal drawer or back), which is an accepted trade-off shared
 * with Changes, not a regression introduced here.
 */

import type { OutlineEntry } from '@emdash/chat-ui';
import { X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { Button } from '@renderer/lib/ui/button';
import { MicroLabel } from '@renderer/lib/ui/label';
import { Sheet, SheetContent } from '@renderer/lib/ui/sheet';
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

// ── Shared list content ─────────────────────────────────────────────────────

export type TranscriptOutlineListProps = {
  entries: readonly OutlineEntry[];
  /** Stable itemId of the entry that should read as "current selection", if any. */
  selectedItemId: string | null;
  onSelect: (entry: OutlineEntry) => void;
};

function TranscriptOutlineList({ entries, selectedItemId, onSelect }: TranscriptOutlineListProps) {
  return (
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
  );
}

// ── Wide layout: in-flow rail ────────────────────────────────────────────────

export type TranscriptOutlineRailProps = {
  entries: readonly OutlineEntry[];
  selectedItemId: string | null;
  onSelect: (entry: OutlineEntry) => void;
  onClose: () => void;
  /** Element focus returns to when the panel closes. */
  returnFocusRef?: React.RefObject<HTMLElement | null>;
};

export function TranscriptOutlineRail({
  entries,
  selectedItemId,
  onSelect,
  onClose,
  returnFocusRef,
}: TranscriptOutlineRailProps) {
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Move focus into the panel when it mounts, and return it to the toggle
  // control that opened it on unmount — the toggle stays mounted and
  // interactive the whole time the panel is open (see AcpChatPanel).
  // `trigger` is captured once: the toggle button is a stable node for the
  // entire time this panel exists, so reading it here (rather than inside
  // the cleanup) is safe and keeps the effect's dependency array accurate.
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
      className="relative flex h-full flex-col overflow-hidden border-l border-border bg-background-secondary-1"
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
      <TranscriptOutlineList entries={entries} selectedItemId={selectedItemId} onSelect={onSelect} />
    </div>
  );
}

// ── Narrow layout: modal drawer ──────────────────────────────────────────────

export type TranscriptOutlineDrawerProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entries: readonly OutlineEntry[];
  selectedItemId: string | null;
  onSelect: (entry: OutlineEntry) => void;
};

export function TranscriptOutlineDrawer({
  open,
  onOpenChange,
  entries,
  selectedItemId,
  onSelect,
}: TranscriptOutlineDrawerProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        showCloseButton={false}
        className="gap-0 p-0"
        style={{ width: OUTLINE_RAIL_WIDTH_PX }}
        aria-label="Outline"
        aria-modal="true"
      >
        <div className="flex h-full flex-col overflow-hidden">
          <div className="flex shrink-0 items-center justify-between px-3 py-2.5">
            <h2 className="text-sm font-medium tracking-tight text-foreground">Outline</h2>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Close outline"
              onClick={() => onOpenChange(false)}
            >
              <X className="size-3.5" />
            </Button>
          </div>
          <TranscriptOutlineList
            entries={entries}
            selectedItemId={selectedItemId}
            onSelect={onSelect}
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}
