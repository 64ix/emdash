/**
 * Unit + integration coverage for `AcpHistoryPagination`, the coordinator
 * `AcpChatStore` uses to connect chat-ui's reach-start/loadOlder primitives to
 * the ACP `getHistory({ before, limit })` wire contract.
 *
 * The "paging beyond the initial window (>100 turns)" describe block's first
 * test is the ticket's required integration scenario: a 240-turn
 * conversation (> the 100-turn initial page) exercised end to end, asserting
 * concurrency (a reach-start firing mid-request is refused), deduplication
 * (no turn id appears twice), chronological ordering across every page
 * boundary, and durable exhaustion once the start of history is reached. The
 * paired scroll-anchoring guarantee this seam depends on — the previously
 * visible item + offset resolving correctly once older turns shift every
 * index — is unit-tested directly against the production anchor math in
 * `@emdash/chat-ui`'s `state/load-older-anchor.test.ts` (including its own
 * >100-turn scenario), since the DOM/scroll concern lives entirely in that
 * package, not here.
 */
import type { TranscriptTurn } from '@emdash/core/acp/client';
import { describe, expect, it } from 'vitest';
import { AcpHistoryPagination } from './acp-history-pagination';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeTurn(seq: number): TranscriptTurn {
  return {
    id: `turn-${seq}`,
    seq,
    initiator: seq % 2 === 0 ? 'agent' : 'user',
    items: [],
    outcome: { kind: 'done' },
  };
}

/**
 * Simulates the server-side `getHistory(before, limit)` semantics from
 * `session-manager.ts`: turns strictly older than `before` (by seq), most
 * recent `limit` of them, ascending order, with a durable `nextCursor`.
 */
function fakeServerHistory(totalTurns: number, before: number | undefined, limit: number) {
  const all = Array.from({ length: totalTurns }, (_, i) => makeTurn(i));
  const filtered = before === undefined ? all : all.filter((turn) => turn.seq < before);
  const page = filtered.slice(Math.max(0, filtered.length - limit));
  const nextCursor = page.length === limit ? page[0].seq : null;
  return { turns: page, nextCursor };
}

// ── seed / exhausted ──────────────────────────────────────────────────────────

describe('AcpHistoryPagination.seed', () => {
  it('is not exhausted before bootstrap', () => {
    const pagination = new AcpHistoryPagination();
    expect(pagination.exhausted).toBe(false);
  });

  it('marks history exhausted when the initial page already covers everything', () => {
    const pagination = new AcpHistoryPagination();
    const page = fakeServerHistory(10, undefined, 100);
    pagination.seed(page);
    expect(pagination.exhausted).toBe(true);
  });

  it('is not exhausted when the initial page is a partial window', () => {
    const pagination = new AcpHistoryPagination();
    const page = fakeServerHistory(150, undefined, 100);
    pagination.seed(page);
    expect(pagination.exhausted).toBe(false);
  });
});

// ── beginLoadOlder / completeLoadOlder — the core >100-turn pagination path ──

describe('AcpHistoryPagination — paging beyond the initial window (>100 turns)', () => {
  it('loads every older page in chronological order, refuses concurrent requests, dedupes, and durably exhausts', () => {
    const TOTAL = 240;
    const PAGE_SIZE = 100;
    const pagination = new AcpHistoryPagination();

    const initial = fakeServerHistory(TOTAL, undefined, PAGE_SIZE);
    pagination.seed(initial);
    let loaded: TranscriptTurn[] = [...initial.turns];
    expect(pagination.exhausted).toBe(false);

    // Page 2: turns [40, 140).
    let begin = pagination.beginLoadOlder();
    expect(begin).not.toBeNull();

    // Concurrency: repeated reach-start events while page 2 is in flight
    // must never start a second request for the same cursor.
    expect(pagination.beginLoadOlder()).toBeNull();
    expect(pagination.beginLoadOlder()).toBeNull();

    const page2 = fakeServerHistory(TOTAL, begin!.before, PAGE_SIZE);
    const fresh2 = pagination.completeLoadOlder(begin!.epoch, page2);
    expect(fresh2).not.toBeNull();
    loaded = [...fresh2!, ...loaded];
    expect(pagination.exhausted).toBe(false);

    // Deduplication: the same page resolving again (racing duplicate, or a
    // caller mistakenly re-completing) prepends nothing new.
    expect(pagination.completeLoadOlder(begin!.epoch, page2)).toEqual([]);

    // Page 3: remaining turns [0, 40) — shorter than a full page, so this
    // fetch reaches the true start of history.
    begin = pagination.beginLoadOlder();
    expect(begin).not.toBeNull();
    const page3 = fakeServerHistory(TOTAL, begin!.before, PAGE_SIZE);
    const fresh3 = pagination.completeLoadOlder(begin!.epoch, page3);
    loaded = [...fresh3!, ...loaded];

    expect(pagination.exhausted).toBe(true);
    expect(loaded).toHaveLength(TOTAL);
    // Chronological order preserved across all page boundaries.
    for (let i = 1; i < loaded.length; i++) {
      expect(loaded[i].seq).toBeGreaterThan(loaded[i - 1].seq);
    }
    // No duplicate turn ids anywhere in the combined, paginated history.
    expect(new Set(loaded.map((t) => t.id)).size).toBe(TOTAL);

    // Exhaustion is durable: further reach-start events never start a load.
    expect(pagination.beginLoadOlder()).toBeNull();
  });

  it('serializes in-flight loads: a second reach-start for the same cursor is refused', () => {
    const pagination = new AcpHistoryPagination();
    pagination.seed(fakeServerHistory(240, undefined, 100));

    const first = pagination.beginLoadOlder();
    expect(first).not.toBeNull();
    expect(pagination.isLoadingOlder).toBe(true);

    // A repeated reach-start event while the first request is in flight must
    // not start a second request.
    const second = pagination.beginLoadOlder();
    expect(second).toBeNull();

    const page = fakeServerHistory(240, first!.before, 100);
    const fresh = pagination.completeLoadOlder(first!.epoch, page);
    expect(fresh).toEqual(page.turns);
    expect(pagination.isLoadingOlder).toBe(false);

    // Now that the first request settled, a new load may start.
    expect(pagination.beginLoadOlder()).not.toBeNull();
  });

  it('deduplicates a page that is fetched twice (e.g. retry after a transient error)', () => {
    const pagination = new AcpHistoryPagination();
    pagination.seed(fakeServerHistory(240, undefined, 100));

    const begin = pagination.beginLoadOlder();
    const page = fakeServerHistory(240, begin!.before, 100);

    const first = pagination.completeLoadOlder(begin!.epoch, page);
    expect(first).toHaveLength(page.turns.length);

    // Re-requesting the exact same server page (as could happen from a retry
    // path) must yield zero fresh turns — no duplicates prepended.
    const second = pagination.completeLoadOlder(begin!.epoch, page);
    expect(second).toEqual([]);
  });

  it('drops a stale response after reset() (session restart / retry mid-flight)', () => {
    const pagination = new AcpHistoryPagination();
    pagination.seed(fakeServerHistory(240, undefined, 100));

    const begin = pagination.beginLoadOlder();
    expect(begin).not.toBeNull();

    // The store restarts (e.g. `retry()`), fencing off the in-flight request.
    pagination.reset();
    expect(pagination.exhausted).toBe(false);
    expect(pagination.isLoadingOlder).toBe(false);

    const page = fakeServerHistory(240, begin!.before, 100);
    const result = pagination.completeLoadOlder(begin!.epoch, page);
    expect(result).toBeNull();

    // abortLoadOlder for the same stale epoch is also a safe no-op.
    pagination.abortLoadOlder(begin!.epoch);
    expect(pagination.isLoadingOlder).toBe(false);
  });

  it('does not consume the cursor on abort, so the same page can be retried', () => {
    const pagination = new AcpHistoryPagination();
    pagination.seed(fakeServerHistory(240, undefined, 100));

    const begin = pagination.beginLoadOlder();
    expect(begin).not.toBeNull();
    pagination.abortLoadOlder(begin!.epoch);
    expect(pagination.isLoadingOlder).toBe(false);

    const retry = pagination.beginLoadOlder();
    expect(retry).toEqual(begin);
  });

  it('refuses to start a load before the initial bootstrap has seeded a page', () => {
    const pagination = new AcpHistoryPagination();
    expect(pagination.beginLoadOlder()).toBeNull();
  });
});

// ── reconcileRefresh — streaming updates must not discard already-loaded pages ─

describe('AcpHistoryPagination.reconcileRefresh', () => {
  it('returns only turns not already loaded, preserving previously-paginated turns', () => {
    const pagination = new AcpHistoryPagination();
    pagination.seed(fakeServerHistory(240, undefined, 100));
    const begin = pagination.beginLoadOlder();
    pagination.completeLoadOlder(begin!.epoch, fakeServerHistory(240, begin!.before, 100));

    // A new turn commits; the store re-fetches the recent window, which still
    // overlaps everything already loaded.
    const allTurns = Array.from({ length: 241 }, (_, i) => makeTurn(i));
    const recentWindow = allTurns.slice(-100);
    const fresh = pagination.reconcileRefresh(recentWindow);

    expect(fresh).toHaveLength(1);
    expect(fresh[0].id).toBe('turn-240');
  });

  it('is a no-op when the refresh window contains nothing new', () => {
    const pagination = new AcpHistoryPagination();
    const page = fakeServerHistory(50, undefined, 100);
    pagination.seed(page);

    expect(pagination.reconcileRefresh(page.turns)).toEqual([]);
  });
});
