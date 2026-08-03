import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AcpChatSearchController,
  type AcpSearchAdvance,
  type AcpSearchMatcher,
  type AcpSearchTranscriptSnapshot,
} from './acp-chat-search-controller';

// ── Fixtures ──────────────────────────────────────────────────────────────────

type FakeResult = {
  readonly id: string;
  readonly itemId: string;
  readonly turnId: string;
  readonly kind: string;
  readonly snippet: string;
  readonly matchStart: number;
  readonly matchLength: number;
};

function result(id: string, overrides: Partial<FakeResult> = {}): FakeResult {
  return {
    id,
    itemId: id,
    turnId: `turn-for-${id}`,
    kind: 'response',
    snippet: id,
    matchStart: 0,
    matchLength: 0,
    ...overrides,
  };
}

/** Real `advanceSearchResultIndex` semantics, reimplemented — trivial, no reason to fake it. */
const realAdvance: AcpSearchAdvance = (resultCount, currentIndex, direction) => {
  if (resultCount === 0) return null;
  if (currentIndex === null) return direction === 1 ? 0 : resultCount - 1;
  return (currentIndex + direction + resultCount) % resultCount;
};

const emptySnapshot: AcpSearchTranscriptSnapshot = {
  committedTurns: [],
  activeTurn: null,
  pendingPrompt: null,
};

function setUp(matcher: AcpSearchMatcher<FakeResult>) {
  const onChange = vi.fn();
  const onJump = vi.fn();
  const controller = new AcpChatSearchController(() => emptySnapshot, matcher, realAdvance, {
    onChange,
    onJump,
  });
  return { controller, onChange, onJump };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// ── open / close ──────────────────────────────────────────────────────────────

describe('AcpChatSearchController — open/close', () => {
  it('starts closed with no query and no results', () => {
    const { controller } = setUp(vi.fn());
    expect(controller.isOpen).toBe(false);
    expect(controller.query).toBe('');
    expect(controller.results).toEqual([]);
  });

  it('open() notifies once and is idempotent', () => {
    const { controller, onChange } = setUp(vi.fn());
    controller.open();
    controller.open();
    expect(controller.isOpen).toBe(true);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('close() clears query, results, and selection', () => {
    const matcher = vi.fn(() => [result('a')]);
    const { controller } = setUp(matcher);
    controller.open();
    controller.setQuery('alpha');
    vi.advanceTimersByTime(200);

    controller.close();

    expect(controller.isOpen).toBe(false);
    expect(controller.query).toBe('');
    expect(controller.results).toEqual([]);
    expect(controller.currentIndex).toBeNull();
  });
});

// ── debounce / stale-indexing cancellation ───────────────────────────────────

describe('AcpChatSearchController — debounced recompute', () => {
  it('does not call the matcher until the debounce window elapses', () => {
    const matcher = vi.fn(() => []);
    const { controller } = setUp(matcher);
    controller.open();

    controller.setQuery('alpha');
    expect(matcher).not.toHaveBeenCalled();

    vi.advanceTimersByTime(149);
    expect(matcher).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(matcher).toHaveBeenCalledTimes(1);
    expect(matcher).toHaveBeenCalledWith([], null, null, 'alpha');
  });

  it('cancels a pending recompute when the query changes again before it fires (stale indexing)', () => {
    const matcher = vi.fn(() => []);
    const { controller } = setUp(matcher);
    controller.open();

    controller.setQuery('a');
    vi.advanceTimersByTime(100);
    controller.setQuery('ab');
    vi.advanceTimersByTime(100);
    controller.setQuery('abc');
    vi.advanceTimersByTime(200);

    // Only the final, settled query is ever actually searched.
    expect(matcher).toHaveBeenCalledTimes(1);
    expect(matcher).toHaveBeenCalledWith([], null, null, 'abc');
  });

  it('cancels a pending recompute when the query is cleared, without calling the matcher', () => {
    const matcher = vi.fn(() => []);
    const { controller } = setUp(matcher);
    controller.open();

    controller.setQuery('alpha');
    vi.advanceTimersByTime(50);
    controller.setQuery('');
    vi.advanceTimersByTime(200);

    expect(matcher).not.toHaveBeenCalled();
    expect(controller.results).toEqual([]);
  });

  it('close() cancels a pending debounced recompute — nothing stale lands after closing', () => {
    const matcher = vi.fn(() => [result('a')]);
    const { controller } = setUp(matcher);
    controller.open();

    controller.setQuery('alpha');
    controller.close();
    vi.advanceTimersByTime(500);

    expect(matcher).not.toHaveBeenCalled();
    expect(controller.results).toEqual([]);
  });
});

// ── refresh() — immediate, transcript-growth-driven recompute ───────────────

describe('AcpChatSearchController — refresh()', () => {
  it('is a no-op while closed', () => {
    const matcher = vi.fn(() => [result('a')]);
    const { controller } = setUp(matcher);
    controller.refresh();
    expect(matcher).not.toHaveBeenCalled();
  });

  it('is a no-op while the query is blank', () => {
    const matcher = vi.fn(() => [result('a')]);
    const { controller } = setUp(matcher);
    controller.open();
    controller.refresh();
    expect(matcher).not.toHaveBeenCalled();
  });

  it('recomputes immediately (no debounce) once a query is active', () => {
    let hits: FakeResult[] = [result('a')];
    const matcher: AcpSearchMatcher<FakeResult> = vi.fn(() => hits);
    const { controller } = setUp(matcher);
    controller.open();
    controller.setQuery('alpha');
    vi.advanceTimersByTime(200);
    expect(controller.results).toEqual([result('a')]);

    hits = [result('a'), result('b')];
    controller.refresh();

    expect(controller.results).toEqual([result('a'), result('b')]);
  });
});

// ── selection stability across recompute ─────────────────────────────────────

describe('AcpChatSearchController — selection stability', () => {
  it('keeps no selection established until the first explicit next()/previous()', () => {
    const matcher = vi.fn(() => [result('a'), result('b')]);
    const { controller, onJump } = setUp(matcher);
    controller.open();
    controller.setQuery('alpha');
    vi.advanceTimersByTime(200);

    expect(controller.currentIndex).toBeNull();
    expect(onJump).not.toHaveBeenCalled();
  });

  it('the first next() lands on the first result, not the second', () => {
    const matcher = vi.fn(() => [result('a'), result('b'), result('c')]);
    const { controller, onJump } = setUp(matcher);
    controller.open();
    controller.setQuery('alpha');
    vi.advanceTimersByTime(200);

    controller.next();

    expect(controller.currentIndex).toBe(0);
    expect(onJump).toHaveBeenCalledExactlyOnceWith('a');
  });

  it('the first previous() lands on the last result', () => {
    const matcher = vi.fn(() => [result('a'), result('b'), result('c')]);
    const { controller, onJump } = setUp(matcher);
    controller.open();
    controller.setQuery('alpha');
    vi.advanceTimersByTime(200);

    controller.previous();

    expect(controller.currentIndex).toBe(2);
    expect(onJump).toHaveBeenCalledExactlyOnceWith('c');
  });

  it('next()/previous() wrap around and jump on every step', () => {
    const matcher = vi.fn(() => [result('a'), result('b')]);
    const { controller, onJump } = setUp(matcher);
    controller.open();
    controller.setQuery('alpha');
    vi.advanceTimersByTime(200);

    controller.next();
    expect(controller.currentIndex).toBe(0);
    controller.next();
    expect(controller.currentIndex).toBe(1);
    controller.next();
    expect(controller.currentIndex).toBe(0); // wraps

    expect(onJump).toHaveBeenNthCalledWith(1, 'a');
    expect(onJump).toHaveBeenNthCalledWith(2, 'b');
    expect(onJump).toHaveBeenNthCalledWith(3, 'a');
  });

  it('keeps the same selected result stable across a refresh when it is still present', () => {
    let hits: FakeResult[] = [result('a'), result('b')];
    const matcher: AcpSearchMatcher<FakeResult> = vi.fn(() => hits);
    const { controller, onJump } = setUp(matcher);
    controller.open();
    controller.setQuery('alpha');
    vi.advanceTimersByTime(200);
    controller.next();
    expect(controller.currentIndex).toBe(0); // selected "a"

    // An older page prepends a new earlier match — "a" shifts to index 1.
    hits = [result('older'), result('a'), result('b')];
    controller.refresh();

    expect(controller.currentIndex).toBe(1);
    // refresh() is a silent recompute — it never re-jumps on its own.
    expect(onJump).toHaveBeenCalledTimes(1);
  });

  it('drops (rather than silently guesses) a selection whose result disappeared', () => {
    let hits: FakeResult[] = [result('a'), result('b')];
    const matcher: AcpSearchMatcher<FakeResult> = vi.fn(() => hits);
    const { controller } = setUp(matcher);
    controller.open();
    controller.setQuery('alpha');
    vi.advanceTimersByTime(200);
    controller.next();
    expect(controller.currentIndex).toBe(0);

    hits = [result('b')]; // "a" no longer matches
    controller.refresh();

    expect(controller.currentIndex).toBeNull();
  });

  it('selectResult() jumps directly to a clicked result', () => {
    const matcher = vi.fn(() => [result('a'), result('b'), result('c')]);
    const { controller, onJump } = setUp(matcher);
    controller.open();
    controller.setQuery('alpha');
    vi.advanceTimersByTime(200);

    controller.selectResult(result('c'));

    expect(controller.currentIndex).toBe(2);
    expect(onJump).toHaveBeenCalledExactlyOnceWith('c');
  });
});

// ── currentResult ──────────────────────────────────────────────────────────────

describe('AcpChatSearchController — currentResult', () => {
  it('is null before a selection is established, and reflects the selected result after', () => {
    const matcher = vi.fn(() => [result('a'), result('b')]);
    const { controller } = setUp(matcher);
    controller.open();
    controller.setQuery('alpha');
    vi.advanceTimersByTime(200);
    expect(controller.currentResult).toBeNull();

    controller.next();
    expect(controller.currentResult).toEqual(result('a'));
  });
});
