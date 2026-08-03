import type { TranscriptTurn } from '@emdash/core/acp/client';

/**
 * Minimal shape `AcpChatSearchController` needs from `@emdash/chat-ui`'s
 * `PendingPrompt`. Declared locally (rather than `import type` from
 * `@emdash/chat-ui`) so this file has zero dependency — runtime or type — on
 * the chat-ui package: its built bundle touches `document` at import time,
 * which would force every test importing this controller to mock the whole
 * package (see `acp-chat-store.test.ts`'s `vi.mock('@emdash/chat-ui', ...)`
 * for why). Matching/advancing logic is injected instead (see
 * `AcpSearchMatcher`/`AcpSearchAdvance` below), so this controller is
 * unit-testable with plain fakes and no module mocking at all — the same
 * reasoning `PermissionResolutionController` and `AcpSubmissionController`
 * already apply to their own dependencies.
 *
 * The result type itself is a type parameter (`TResult`) rather than a
 * locally-declared shape: `AcpChatStore` instantiates this controller with
 * the real `@emdash/chat-ui` `TranscriptSearchResult` (a type-only import,
 * erased at compile time — never a runtime dependency), so callers get the
 * exact public result type back with no unsafe cast at the boundary, while
 * this file and its own tests stay free to use a minimal local shape.
 */
export type AcpSearchPendingPrompt = { id: string; text: string };

/** Minimum shape a search result must have for selection/navigation to work. */
export type AcpSearchResultLike = { readonly id: string; readonly itemId: string };

export type AcpSearchTranscriptSnapshot = {
  committedTurns: readonly TranscriptTurn[];
  activeTurn: TranscriptTurn | null;
  pendingPrompt: AcpSearchPendingPrompt | null;
};

export type AcpSearchMatcher<TResult extends AcpSearchResultLike> = (
  committedTurns: readonly TranscriptTurn[],
  activeTurn: TranscriptTurn | null,
  pendingPrompt: AcpSearchPendingPrompt | null,
  query: string
) => TResult[];

export type AcpSearchAdvance = (
  resultCount: number,
  currentIndex: number | null,
  direction: 1 | -1
) => number | null;

export interface AcpChatSearchHooks {
  /** Called synchronously whenever open/query/results/currentIndex changes, so the host can bump its own observable. */
  onChange: () => void;
  /** Called when the *selected* result changes as a result of explicit navigation (never a silent background recompute) — the host jumps the transcript to it. */
  onJump: (itemId: string) => void;
}

/** Debounce window between the last keystroke and re-running the matcher. */
const SEARCH_DEBOUNCE_MS = 150;

/**
 * AcpChatSearchController — query/results/selection state machine for
 * transcript search (ticket #36, spec #18). Framework-free: no MobX, no DOM,
 * no `@emdash/chat-ui` import (see the module doc above).
 *
 * Scope decision: this controller only ever searches the transcript snapshot
 * `getSnapshot()` currently returns — i.e. whatever `AcpHistoryPagination` has
 * already paged in (see `state/transcript-search.ts`'s own "Scope: loaded
 * history only" doc). It does not page in older history itself; the host
 * (`AcpChatStore`) is responsible for exposing whether persisted history is
 * exhausted and for re-running `refresh()` after it fetches an older page —
 * see `AcpChatStore.searchHistoryExhausted` / the `_search.refresh()` call
 * sites next to `_syncOutline()`.
 *
 * Two kinds of recompute, matching the acceptance criterion "changing or
 * closing the query cancels stale indexing and page requests":
 *   - `setQuery` (a keystroke) is *debounced* — every call cancels any
 *     not-yet-run recompute scheduled for a previous keystroke, so a fast
 *     typist never lets a stale query's results land after a newer one.
 *   - `refresh()` (the transcript grew, or an older page just loaded) runs
 *     immediately — new content matching an already-open query must appear
 *     without waiting on the debounce window, and it is a no-op while the
 *     panel is closed or the query is blank so a closed search can never be
 *     silently repopulated by a page load that happens to still be in flight.
 *
 * Selection stability: recompute keeps the same *logical* selection (by
 * result `id`) across a refresh when possible, rather than resetting to the
 * first hit — so an older page prepending earlier matches never yanks the
 * user off the result they were just looking at.
 *
 * Never auto-jumps on a silent recompute (typing, or the transcript growing
 * in the background) — only `next()`/`previous()`/`select()` call `onJump`,
 * so a background content update never moves the viewport out from under a
 * user who did not ask to navigate.
 */
export class AcpChatSearchController<TResult extends AcpSearchResultLike> {
  private _isOpen = false;
  private _query = '';
  private _results: TResult[] = [];
  private _currentIndex: number | null = null;
  private _debounceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly getSnapshot: () => AcpSearchTranscriptSnapshot,
    private readonly matcher: AcpSearchMatcher<TResult>,
    private readonly advance: AcpSearchAdvance,
    private readonly hooks: AcpChatSearchHooks
  ) {}

  get isOpen(): boolean {
    return this._isOpen;
  }

  get query(): string {
    return this._query;
  }

  get results(): readonly TResult[] {
    return this._results;
  }

  get currentIndex(): number | null {
    return this._currentIndex;
  }

  get currentResult(): TResult | null {
    return this._currentIndex !== null ? (this._results[this._currentIndex] ?? null) : null;
  }

  open(): void {
    if (this._isOpen) return;
    this._isOpen = true;
    this.hooks.onChange();
  }

  /** Close and cancel any pending debounced recompute — nothing stale can land after this. */
  close(): void {
    this._clearTimer();
    if (!this._isOpen && this._query === '' && this._results.length === 0) return;
    this._isOpen = false;
    this._query = '';
    this._results = [];
    this._currentIndex = null;
    this.hooks.onChange();
  }

  /**
   * Record a keystroke. Cancels any recompute still pending for a previous
   * keystroke (stale indexing) before scheduling a fresh, debounced one. A
   * blank query clears results immediately — no reason to wait on a timer to
   * show "no search".
   */
  setQuery(query: string): void {
    this._query = query;
    this._clearTimer();
    if (query.trim().length === 0) {
      this._results = [];
      this._currentIndex = null;
      this.hooks.onChange();
      return;
    }
    this._debounceTimer = setTimeout(() => {
      this._debounceTimer = null;
      this._recompute();
    }, SEARCH_DEBOUNCE_MS);
    this.hooks.onChange();
  }

  /**
   * Re-run the current query against the latest transcript snapshot
   * immediately (no debounce) — for transcript growth (streaming, a turn
   * committing) or after an older history page loads. No-op while closed or
   * the query is blank.
   */
  refresh(): void {
    if (!this._isOpen || this._query.trim().length === 0) return;
    this._recompute();
  }

  /** Select and jump to the next result, wrapping past the last one. */
  next(): void {
    this._select(this.advance(this._results.length, this._currentIndex, 1));
  }

  /** Select and jump to the previous result, wrapping past the first one. */
  previous(): void {
    this._select(this.advance(this._results.length, this._currentIndex, -1));
  }

  /** Select and jump to a specific result (e.g. a click in a results list). */
  selectResult(result: TResult): void {
    const index = this._results.findIndex((candidate) => candidate.id === result.id);
    if (index === -1) return;
    this._select(index);
  }

  private _select(index: number | null): void {
    if (index === null) return;
    this._currentIndex = index;
    this.hooks.onChange();
    const target = this._results[index];
    if (target) this.hooks.onJump(target.itemId);
  }

  private _recompute(): void {
    const previousId = this.currentResult?.id ?? null;
    const snapshot = this.getSnapshot();
    this._results = this.matcher(
      snapshot.committedTurns,
      snapshot.activeTurn,
      snapshot.pendingPrompt,
      this._query
    );
    this._currentIndex = this._resolveIndexAfterRecompute(previousId);
    this.hooks.onChange();
  }

  /**
   * Keep the same logical selection stable across a recompute when possible
   * (see the module doc's "Selection stability" section) — but never
   * *establish* a first selection here. If there was no previous selection
   * (a fresh query, or one whose selection was already lost), leave the
   * index `null` rather than silently jumping to the first hit: `next()`
   * already resolves a `null` index to the first result via `advance()`
   * (and `previous()` to the last), so the *first* explicit Next/Previous
   * press always lands on the first/last hit — never skips over it because
   * a silent recompute had already claimed index 0.
   */
  private _resolveIndexAfterRecompute(previousId: string | null): number | null {
    if (previousId === null) return null;
    const index = this._results.findIndex((result) => result.id === previousId);
    return index === -1 ? null : index;
  }

  private _clearTimer(): void {
    if (this._debounceTimer !== null) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
  }
}
