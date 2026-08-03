/**
 * AttentionBanner — the sticky offscreen attention indicator (ticket #33,
 * spec #18).
 *
 * Presentational only: `AcpChatPanel`'s `ComposerForStore` supplies the
 * ordered `queue`, the item traversal currently shows (`focusedItem`), and
 * the transcript's `atBottom` signal (ticket #37) — see
 * `acp-attention-queue.ts`'s module doc for why `atBottom` is the visibility
 * proxy for a transcript-anchored item, and why a composer-anchored one
 * (failed submission) is always considered visible.
 *
 * Renders nothing when there is nothing pending, or when the focused item's
 * target is already sufficiently visible — appearing/disappearing is a pure
 * function of props, so mounting or re-rendering this component never
 * scrolls or moves focus on its own; only `onActivate`/`onNext`/`onPrevious`
 * (explicit user activation) do anything, and even then only through the
 * caller's own handlers.
 */
import { AlertTriangle, ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@renderer/lib/ui/button';
import { isAttentionTargetVisible, type AttentionItem } from './acp-attention-queue';

const ACTIVATE_LABEL: Record<AttentionItem['kind'], string> = {
  permission: 'Review request',
  question: 'Review question',
  'failed-submission': 'Review message',
  error: 'Jump to it',
};

export interface AttentionBannerProps {
  /** The full ordered/deduplicated queue — see `AcpChatStore.attentionQueue`. */
  queue: readonly AttentionItem[];
  /** The item traversal currently shows — see `AcpChatStore.attentionFocusedItem`. */
  focusedItem: AttentionItem | null;
  /** Whether the transcript is currently at the tail — see `AcpChatStore.setAtBottom`. */
  atBottom: boolean;
  onNext: () => void;
  onPrevious: () => void;
  onActivate: (item: AttentionItem) => void;
}

export function AttentionBanner({
  queue,
  focusedItem,
  atBottom,
  onNext,
  onPrevious,
  onActivate,
}: AttentionBannerProps) {
  if (queue.length === 0 || !focusedItem) return null;
  if (isAttentionTargetVisible(focusedItem.target, atBottom)) return null;

  const index = queue.findIndex((item) => item.id === focusedItem.id);
  const position = index === -1 ? 1 : index + 1;

  return (
    <div
      role="status"
      aria-live="polite"
      className="mb-2 flex items-center justify-between gap-2 rounded-md border border-border-warning bg-background-warning px-3 py-1.5 text-sm text-foreground-warning"
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />
        <div className="flex min-w-0 flex-col">
          <span className="text-xs opacity-80">
            {queue.length > 1
              ? `Needs your attention (${position} of ${queue.length})`
              : 'Needs your attention'}
          </span>
          <span className="truncate">{focusedItem.summary}</span>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {queue.length > 1 && (
          <>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Previous item needing attention"
              onClick={onPrevious}
            >
              <ChevronLeft className="size-4" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Next item needing attention"
              onClick={onNext}
            >
              <ChevronRight className="size-4" />
            </Button>
          </>
        )}
        <Button variant="outline" size="sm" onClick={() => onActivate(focusedItem)}>
          {ACTIVATE_LABEL[focusedItem.kind]}
        </Button>
      </div>
    </div>
  );
}
