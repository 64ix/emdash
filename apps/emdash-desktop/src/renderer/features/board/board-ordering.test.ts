import { describe, expect, it } from 'vitest';
import {
  COLUMNS,
  computeDropPosition,
  computeDropRank,
  partitionAwaitingInput,
  sortColumn,
  stageOf,
} from './board-ordering';

describe('COLUMNS', () => {
  it('leads with unstaged, followed by every workflow stage in pipeline order', () => {
    expect(COLUMNS[0]).toBe('unstaged');
    expect(COLUMNS).toEqual([
      'unstaged',
      'idea',
      'exploring',
      'spec',
      'implementing',
      'review',
      'shipped',
      'triage',
    ]);
  });
});

describe('stageOf', () => {
  it('returns unstaged for a task with no workflow stage', () => {
    expect(stageOf({ workflowStage: undefined } as never)).toBe('unstaged');
  });

  it('returns the task workflow stage when set', () => {
    expect(stageOf({ workflowStage: 'spec' } as never)).toBe('spec');
  });
});

describe('sortColumn', () => {
  it('sorts ranked entries ascending by rank', () => {
    const entries = [
      { id: 'c', rank: 'z' },
      { id: 'a', rank: 'a' },
      { id: 'b', rank: 'm' },
    ];
    expect(sortColumn(entries).map((e) => e.id)).toEqual(['a', 'b', 'c']);
  });

  it('places unranked entries after ranked ones, in their pre-existing order', () => {
    const entries = [
      { id: 'unranked-1', rank: null },
      { id: 'ranked', rank: 'm' },
      { id: 'unranked-2', rank: null },
    ];
    expect(sortColumn(entries).map((e) => e.id)).toEqual(['ranked', 'unranked-1', 'unranked-2']);
  });

  it('is stable for an all-unranked column (keeps the pre-existing order)', () => {
    const entries = [
      { id: 'x', rank: null },
      { id: 'y', rank: null },
      { id: 'z', rank: null },
    ];
    expect(sortColumn(entries).map((e) => e.id)).toEqual(['x', 'y', 'z']);
  });

  it('never mutates or assigns a rank', () => {
    const entries = [{ id: 'a', rank: null }];
    const sorted = sortColumn(entries);
    expect(sorted[0]!.rank).toBeNull();
    expect(entries[0]!.rank).toBeNull();
  });

  it('returns a new array, leaving the input untouched', () => {
    const entries = [
      { id: 'b', rank: 'b' },
      { id: 'a', rank: 'a' },
    ];
    const sorted = sortColumn(entries);
    expect(sorted).not.toBe(entries);
    expect(entries.map((e) => e.id)).toEqual(['b', 'a']);
  });
});

describe('partitionAwaitingInput', () => {
  const entries = [
    { id: 'a', rank: 'a' },
    { id: 'b', rank: 'b' },
    { id: 'c', rank: 'c' },
    { id: 'd', rank: 'd' },
  ];

  it('elevates awaiting-input cards to the top, keeping relative order within each group', () => {
    const awaiting = new Set(['c', 'a']);
    const result = partitionAwaitingInput(entries, awaiting, false);
    expect(result.map((e) => e.id)).toEqual(['a', 'c', 'b', 'd']);
  });

  it('returns the input order unchanged when nothing is awaiting input', () => {
    const result = partitionAwaitingInput(entries, new Set(), false);
    expect(result.map((e) => e.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('elevates all cards in original order when every card is awaiting input', () => {
    const awaiting = new Set(['a', 'b', 'c', 'd']);
    const result = partitionAwaitingInput(entries, awaiting, false);
    expect(result.map((e) => e.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('freezes the partition while a drag is active, returning the input order unchanged', () => {
    const awaiting = new Set(['d']);
    const result = partitionAwaitingInput(entries, awaiting, true);
    expect(result.map((e) => e.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('never writes rank — the entries themselves pass through unchanged', () => {
    const awaiting = new Set(['c']);
    const result = partitionAwaitingInput(entries, awaiting, false);
    const elevated = result.find((e) => e.id === 'c')!;
    expect(elevated.rank).toBe('c');
  });
});

describe('computeDropRank', () => {
  it('produces a rank between the neighbouring ranked cards at the drop index', () => {
    const entries = [{ rank: 'a' }, { rank: 'z' }];
    const rank = computeDropRank(entries, 1);
    expect(rank > 'a').toBe(true);
    expect(rank < 'z').toBe(true);
  });

  it('accepts drops into an empty column', () => {
    const rank = computeDropRank([], 0);
    expect(typeof rank).toBe('string');
    expect(rank.length).toBeGreaterThan(0);
  });

  it('produces a rank before the first card when dropped at the very start', () => {
    const entries = [{ rank: 'm' }, { rank: 'z' }];
    const rank = computeDropRank(entries, 0);
    expect(rank < 'm').toBe(true);
  });

  it('produces a rank after the last card when dropped at the very end', () => {
    const entries = [{ rank: 'a' }, { rank: 'm' }];
    const rank = computeDropRank(entries, 2);
    expect(rank > 'm').toBe(true);
  });

  it('clamps a drop inside the unranked tail to the end of the ranked prefix', () => {
    const entries = [{ rank: 'a' }, { rank: 'm' }, { rank: null }, { rank: null }];
    const droppedAtEndOfList = computeDropRank(entries, 4);
    const droppedJustAfterRanked = computeDropRank(entries, 2);
    const droppedInsideUnranked = computeDropRank(entries, 3);
    expect(droppedAtEndOfList).toBe(droppedJustAfterRanked);
    expect(droppedInsideUnranked).toBe(droppedJustAfterRanked);
    expect(droppedAtEndOfList > 'm').toBe(true);
  });

  it('drops into an all-unranked column as the first rank (index clamped to 0)', () => {
    const entries = [{ rank: null }, { rank: null }];
    const rank = computeDropRank(entries, 1);
    expect(typeof rank).toBe('string');
    expect(rank.length).toBeGreaterThan(0);
  });

  it('clamps a negative index to the start', () => {
    const entries = [{ rank: 'm' }];
    const rank = computeDropRank(entries, -5);
    expect(rank < 'm').toBe(true);
  });
});

describe('computeDropRank — hidden-card rank collision (ticket #45 follow-up)', () => {
  // Stored (unfiltered) order: '4' < '5' < '6'. A filter hides the interior
  // card ranked '5' — e.g. it doesn't pass an Agent State filter — so the
  // *visible* list is just ['4', '6']. Dropping between those two visible
  // neighbours must never produce '5': that's the hidden card's own,
  // already-in-use Board Rank, a genuine duplicate the stable sort would
  // then only break by insertion order, and a later drop treating the
  // resulting ('4', '5') pair as adjacent bounds would throw inside
  // `rankBetween`'s own "a must sort strictly before b" guard.
  const visible = [
    { id: 'keep-a', rank: '4' },
    { id: 'keep-c', rank: '6' },
  ];
  const trueOrder = [
    { id: 'keep-a', rank: '4' },
    { id: 'hidden', rank: '5' },
    { id: 'keep-c', rank: '6' },
  ];

  it('computes the rank against the true unfiltered neighbours, never colliding with the hidden card between them', () => {
    const rank = computeDropRank(visible, 1, trueOrder);
    expect(rank > '4').toBe(true);
    expect(rank < '6').toBe(true);
    expect(rank).not.toBe('5');
  });

  it('leaves the naive (visible-only) interpolation untouched when it does not collide — the common case', () => {
    // Mirrors the board-header.test.tsx regression: 'D' < 'H' < 'n', 'H'
    // hidden. rankBetween('D', 'n') doesn't land on 'H', so supplying
    // `trueEntries` must not change the result versus the 2-arg call.
    const visibleWide = [
      { id: 'keep-a', rank: 'D' },
      { id: 'keep-c', rank: 'n' },
    ];
    const trueOrderWide = [
      { id: 'keep-a', rank: 'D' },
      { id: 'hidden', rank: 'H' },
      { id: 'keep-c', rank: 'n' },
    ];
    expect(computeDropRank(visibleWide, 1, trueOrderWide)).toBe(computeDropRank(visibleWide, 1));
  });

  it('a boundary collision at the very top (no visible predecessor) falls back to the true predecessor', () => {
    // rankBetween(null, '3') === '1' — exactly the hidden card's own rank.
    const rank = computeDropRank([{ id: 'keep-c', rank: '3' }], 0, [
      { id: 'hidden', rank: '1' },
      { id: 'keep-c', rank: '3' },
    ]);
    expect(rank > '1').toBe(true);
    expect(rank < '3').toBe(true);
    expect(rank).not.toBe('1');
  });

  it('a boundary collision at the very end (no visible successor) falls back to the true successor', () => {
    // rankBetween('4', null) === 'X' — exactly the hidden card's own rank.
    const rank = computeDropRank([{ id: 'keep-a', rank: '4' }], 1, [
      { id: 'keep-a', rank: '4' },
      { id: 'hidden', rank: 'X' },
    ]);
    expect(rank > '4').toBe(true);
    expect(rank < 'X').toBe(true);
    expect(rank).not.toBe('X');
  });

  it('falls back to the old (visible-only) interpolation when no true order is supplied', () => {
    // Backward-compatible 2-arg call site — unaffected by this fix.
    const rank = computeDropRank(visible, 1);
    expect(rank > '4').toBe(true);
    expect(rank < '6').toBe(true);
  });
});

describe('computeDropPosition', () => {
  it('resolves the destination stage from the column', () => {
    const result = computeDropPosition('spec', [], 0);
    expect(result.stage).toBe('spec');
  });

  it('clears the workflow stage when dropping into the unstaged column', () => {
    const result = computeDropPosition('unstaged', [{ rank: 'm' }], 0);
    expect(result.stage).toBeNull();
    expect(result.rank < 'm').toBe(true);
  });

  it('accepts a drop into an empty column and returns a usable rank', () => {
    const result = computeDropPosition('implementing', [], 0);
    expect(result.stage).toBe('implementing');
    expect(typeof result.rank).toBe('string');
  });
});
