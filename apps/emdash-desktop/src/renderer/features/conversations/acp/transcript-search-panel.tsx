/**
 * TranscriptSearchBar — a floating find bar over the transcript (ticket #36,
 * spec #18). Renders `AcpChatStore.searchResults` and lets the user step
 * through them; the store owns matching/debounce/jump behavior (see
 * `acp-chat-search-controller.ts`) — this component only renders state and
 * forwards intent, matching `TranscriptOutlinePanel`'s split.
 *
 * ── Scope, stated honestly ────────────────────────────────────────────────────
 *
 * "The canonical transcript" can be larger than what pagination (#24) has
 * loaded. This bar never implies otherwise: while `historyExhausted` is
 * false, it shows a line saying only loaded history is searched, with an
 * explicit "Load older history" action (wired to the store's existing
 * `loadOlderHistory()` — the same single-flight, resumable seam #34's
 * outline jump already reuses) rather than silently covering a partial
 * window while looking complete.
 *
 * ── Highlighting ──────────────────────────────────────────────────────────────
 *
 * The matched substring is highlighted via `splitSnippetAtMatch`, which
 * slices `snippet` on *code points* (never UTF-16 units), so a surrogate
 * pair straddling the match boundary is never bisected — see that helper's
 * doc in `@emdash/chat-ui`. All three pieces (`before`/`match`/`after`) are
 * rendered as plain React text children, never as markup: neither the query
 * nor matched transcript content is ever interpreted as HTML/Markdown.
 *
 * ── Keyboard ──────────────────────────────────────────────────────────────────
 *
 * Enter -> next match, Shift+Enter -> previous match, Escape -> close and
 * return focus to the control that opened this bar (`returnFocusRef`) —
 * mirrors `TranscriptOutlineRail`'s own focus-in/focus-return convention.
 */

import type { TranscriptSearchResult, TranscriptSearchResultKind } from '@emdash/chat-ui';
import { splitSnippetAtMatch } from '@emdash/chat-ui';
import { ChevronDown, ChevronUp, Loader2, Search, X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { Button } from '@renderer/lib/ui/button';
import { Input } from '@renderer/lib/ui/input';
import { cn } from '@renderer/utils/utils';

function resultKindLabel(kind: TranscriptSearchResultKind): string {
  switch (kind) {
    case 'prompt':
      return 'Prompt';
    case 'response':
      return 'Response';
    case 'thinking':
      return 'Thinking';
    case 'tool':
      return 'Tool';
    case 'tool-result':
      return 'Result';
    case 'tool-error':
      return 'Error';
    case 'path':
      return 'Path';
    case 'resource':
      return 'Resource';
  }
}

function countLabel(query: string, resultCount: number, currentIndex: number | null): string {
  if (query.trim().length === 0) return '';
  if (resultCount === 0) return 'No matches';
  return currentIndex !== null ? `${currentIndex + 1} of ${resultCount}` : `${resultCount} matches`;
}

/** Plain-text render of a snippet with its match highlighted — never markup. */
function HighlightedSnippet({ result }: { result: TranscriptSearchResult }) {
  const { before, match, after } = splitSnippetAtMatch(result);
  return (
    <span className="block truncate text-xs text-foreground-muted">
      {before}
      <mark className="rounded-sm bg-background-warning px-0.5 text-foreground-warning">
        {match}
      </mark>
      {after}
    </span>
  );
}

export type TranscriptSearchBarProps = {
  query: string;
  onQueryChange: (query: string) => void;
  results: readonly TranscriptSearchResult[];
  currentIndex: number | null;
  onNext: () => void;
  onPrevious: () => void;
  onSelectResult: (result: TranscriptSearchResult) => void;
  onClose: () => void;
  historyExhausted: boolean;
  isLoadingOlderHistory: boolean;
  onLoadOlderHistory: () => void;
  /** Element focus returns to when the bar closes. */
  returnFocusRef?: React.RefObject<HTMLElement | null>;
};

export function TranscriptSearchBar({
  query,
  onQueryChange,
  results,
  currentIndex,
  onNext,
  onPrevious,
  onSelectResult,
  onClose,
  historyExhausted,
  isLoadingOlderHistory,
  onLoadOlderHistory,
  returnFocusRef,
}: TranscriptSearchBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus the input on mount, and return focus to the toggle that opened
  // this bar on unmount — mirrors TranscriptOutlineRail's convention. The
  // toggle stays mounted and interactive for the bar's entire lifetime.
  useEffect(() => {
    inputRef.current?.focus();
    const trigger = returnFocusRef?.current ?? null;
    return () => {
      trigger?.focus();
    };
  }, [returnFocusRef]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (event.shiftKey) onPrevious();
      else onNext();
    }
  };

  const currentResult = currentIndex !== null ? (results[currentIndex] ?? null) : null;
  const count = countLabel(query, results.length, currentIndex);

  return (
    <div
      role="search"
      aria-label="Transcript search"
      className="pointer-events-auto absolute top-14 right-3 z-20 flex w-80 max-w-[calc(100%-1.5rem)] flex-col gap-1.5 rounded-lg border border-border bg-background-secondary-1 p-2 shadow-md"
    >
      <div className="flex items-center gap-1.5">
        <div className="relative flex min-w-0 flex-1 items-center">
          <Search className="pointer-events-none absolute left-2.5 size-3.5 shrink-0 text-foreground-muted" />
          <Input
            ref={inputRef}
            aria-label="Search transcript"
            placeholder="Search transcript…"
            className="pl-8"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            onKeyDown={handleKeyDown}
          />
        </div>
        <span className="w-20 shrink-0 text-center text-xs text-foreground-muted" aria-live="polite">
          {count}
        </span>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Previous match"
          disabled={results.length === 0}
          onClick={onPrevious}
        >
          <ChevronUp />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="Next match"
          disabled={results.length === 0}
          onClick={onNext}
        >
          <ChevronDown />
        </Button>
        <Button variant="ghost" size="icon-xs" aria-label="Close search" onClick={onClose}>
          <X />
        </Button>
      </div>

      {currentResult && (
        <button
          type="button"
          onClick={() => onSelectResult(currentResult)}
          className="flex flex-col items-start gap-0.5 rounded-md px-1.5 py-1 text-left hover:bg-background-2"
        >
          <span className="text-[10px] uppercase text-foreground-passive">
            {resultKindLabel(currentResult.kind)}
          </span>
          <HighlightedSnippet result={currentResult} />
        </button>
      )}

      {!historyExhausted && (
        <div className="flex items-center justify-between gap-2 border-t border-border pt-1.5 text-xs text-foreground-muted">
          <span>Only loaded history is searched.</span>
          <Button
            variant="ghost"
            size="xs"
            disabled={isLoadingOlderHistory}
            onClick={onLoadOlderHistory}
            className={cn('shrink-0 gap-1', isLoadingOlderHistory && 'pointer-events-none')}
          >
            {isLoadingOlderHistory && <Loader2 className="size-3 animate-spin" />}
            Load older history
          </Button>
        </div>
      )}
    </div>
  );
}
