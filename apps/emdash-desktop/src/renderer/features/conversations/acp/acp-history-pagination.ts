import type { HistoryPage, TranscriptTurn } from '@emdash/core/acp/client';

/**
 * AcpHistoryPagination — pagination coordinator for a single ACP
 * conversation's transcript history.
 *
 * Wraps the wire-level `getHistory({ before, limit })` contract (see
 * `HistoryPage` in `@emdash/core/acp/client`) with the bookkeeping the
 * chat-ui "load older" seam needs but the wire contract does not provide on
 * its own:
 *
 *   - the next `before` cursor to request for an older page (`null` once the
 *     start of history has been reached — durable for the session);
 *   - a single-flight guard so repeated reach-start events firing while a
 *     request is in flight never start a second request for the same cursor;
 *   - deduplication by turn id, so a page fetched twice (retry, or overlap
 *     with a streaming refresh) is never prepended/appended twice;
 *   - an epoch guard so a stale in-flight response from before a `reset()`
 *     (re-bootstrap / retry) is ignored instead of corrupting the new session.
 *
 * This is the seam later ACP transcript features (Changes rail, outline,
 * search, durable reading position) are expected to build on: they can ask
 * "has all persisted history been loaded?" via `exhausted`, and rely on the
 * same turn-id dedup guarantee this class already provides for their own
 * incremental loads. Callers own the actual `getHistory` RPC calls and the
 * chat-ui `history.prepend`/`history.append` writes; this class only decides
 * *whether* to call and *which* turns are actually new.
 *
 * Not itself aware of ChatState, ChatView, or the DOM — see
 * `@emdash/chat-ui`'s `state/load-older-anchor.ts` for the paired scroll-
 * anchor decision helpers consumed on the rendering side.
 */
export class AcpHistoryPagination {
  private _cursor: number | null = null;
  private _bootstrapped = false;
  private _loading = false;
  private _loadedIds = new Set<string>();
  private _epoch = 0;

  /** True once the oldest turn returned by the server had no older predecessor. */
  get exhausted(): boolean {
    return this._bootstrapped && this._cursor === null;
  }

  /** True while an older-page request is in flight. */
  get isLoadingOlder(): boolean {
    return this._loading;
  }

  /**
   * Reset all pagination state (new session start, or retry after a load
   * error). Any request already in flight is fenced off by the epoch bump:
   * its eventual `completeLoadOlder`/`abortLoadOlder` call becomes a no-op.
   */
  reset(): void {
    this._cursor = null;
    this._bootstrapped = false;
    this._loading = false;
    this._loadedIds.clear();
    this._epoch += 1;
  }

  /** Record the initial (most-recent-window) page and its older-page cursor. */
  seed(page: Pick<HistoryPage, 'turns' | 'nextCursor'>): void {
    this._loadedIds = new Set(page.turns.map((turn) => turn.id));
    this._cursor = page.nextCursor;
    this._bootstrapped = true;
  }

  /**
   * Request permission to start an older-page load (typically from a
   * chat-ui reach-start event). Returns a request token — pass it to
   * `completeLoadOlder` or `abortLoadOlder` — or `null` when a load must not
   * start: bootstrap has not completed yet, a request is already in flight
   * for the current cursor, or history is already exhausted.
   */
  beginLoadOlder(): { epoch: number; before: number } | null {
    if (!this._bootstrapped || this._loading || this._cursor === null) return null;
    this._loading = true;
    return { epoch: this._epoch, before: this._cursor };
  }

  /**
   * Apply a completed older-page fetch. Returns the deduplicated turns to
   * prepend, in the chronological order the server already returns them in,
   * or `null` when the response is stale (a `reset()` happened while the
   * request was in flight — the caller should discard it).
   */
  completeLoadOlder(
    epoch: number,
    page: Pick<HistoryPage, 'turns' | 'nextCursor'>
  ): readonly TranscriptTurn[] | null {
    if (epoch !== this._epoch) return null;
    this._loading = false;
    this._cursor = page.nextCursor;
    return this._dedupe(page.turns);
  }

  /**
   * Release the in-flight guard after a failed load without consuming the
   * cursor, so the next reach-start event can retry the same page.
   */
  abortLoadOlder(epoch: number): void {
    if (epoch !== this._epoch) return;
    this._loading = false;
  }

  /**
   * Reconcile a freshly-fetched recent window (the "refresh after a turn
   * commits" fetch) against already-loaded turns. Returns only the turns not
   * yet known, so the caller can `history.append()` them without discarding
   * any older pages already prepended via `completeLoadOlder`.
   */
  reconcileRefresh(turns: readonly TranscriptTurn[]): readonly TranscriptTurn[] {
    return this._dedupe(turns);
  }

  private _dedupe(turns: readonly TranscriptTurn[]): readonly TranscriptTurn[] {
    const fresh = turns.filter((turn) => !this._loadedIds.has(turn.id));
    for (const turn of fresh) this._loadedIds.add(turn.id);
    return fresh;
  }
}
