import { describe, expect, it } from 'vitest';
import type { AgentStatus } from '@shared/core/agents/agentEvents';
import { SHIPPED_FADE_WINDOW_MS } from '@shared/core/pull-requests/pr-workflow-derivation';
import type { PullRequest } from '@shared/core/pull-requests/pull-requests';
import type { Task } from '@shared/core/tasks/tasks';
import { EMPTY_BOARD_FILTERS, type BoardFilterState } from './board-filters';
import {
  buildGlobalBoardColumns,
  computeGlobalDropPosition,
  projectPassesGlobalBoardFilter,
  type GlobalBoardBuildOptions,
  type GlobalBoardColumns,
  type GlobalBoardProjectInput,
} from './board-global';
import { COLUMNS, type ColumnId } from './board-ordering';

// spec #104 / ticket #106: the Global Board aggregation module — external
// behavior only, exactly like the Feature Board's prior art
// (board-ordering.test.ts, board-columns.test.ts, board-filters.test.ts).
// Given per-project task sets with their stage, Board Rank, merged-at dates,
// agent statuses and filter selections, the module returns the expected
// columns in the expected order with the expected card-project markers; given
// a drop target, the drop mapper returns the expected { stage, rank },
// including inter-project Board Rank interpolation in the shared per-column
// rank space. Tests never assert store or virtual-list internals.

const NOW = new Date('2026-07-31T00:00:00.000Z').getTime();

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    projectId: 'project-1',
    name: 'Example task',
    status: 'todo',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    statusChangedAt: '2026-01-01T00:00:00.000Z',
    isPinned: false,
    prs: [],
    conversations: {},
    type: 'task',
    ...overrides,
  };
}

function makePr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    url: 'https://github.com/acme/repo/pull/1',
    provider: 'github',
    repositoryUrl: 'https://github.com/acme/repo',
    baseRefName: 'main',
    baseRefOid: 'base',
    headRepositoryUrl: 'https://github.com/acme/repo',
    headRefName: 'feature',
    headRefOid: 'head',
    identifier: '#1',
    title: 'Test PR',
    description: null,
    status: 'merged',
    isDraft: false,
    additions: null,
    deletions: null,
    changedFiles: null,
    commitCount: null,
    mergeableStatus: null,
    mergeStateStatus: null,
    reviewDecision: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    mergedAt: null,
    author: null,
    labels: [],
    assignees: [],
    checks: [],
    ...overrides,
  };
}

function makeProject(
  projectId: string,
  tasks: readonly Task[],
  agentStatuses: Record<string, AgentStatus | null> = {}
): GlobalBoardProjectInput {
  return { projectId, tasks: [...tasks], agentStatuses: new Map(Object.entries(agentStatuses)) };
}

function cardIds(columns: GlobalBoardColumns, column: ColumnId): string[] {
  return (columns.display.get(column) ?? []).map((card) => card.id);
}

function build(
  projects: readonly GlobalBoardProjectInput[],
  filters: BoardFilterState = EMPTY_BOARD_FILTERS,
  options: GlobalBoardBuildOptions = {}
): GlobalBoardColumns {
  return buildGlobalBoardColumns(projects, filters, { now: NOW, ...options });
}

describe('buildGlobalBoardColumns — column building', () => {
  it("mixes all projects' tasks into the shared per-stage columns, each card carrying its project marker", () => {
    const columns = build([
      makeProject('project-1', [
        makeTask({ id: 'p1-spec-a', name: 'Spec A', workflowStage: 'spec', boardRank: 'a' }),
        makeTask({ id: 'p1-idea', name: 'Idea', workflowStage: 'idea', boardRank: 'b' }),
      ]),
      makeProject('project-2', [
        makeTask({ id: 'p2-spec-b', name: 'Spec B', workflowStage: 'spec', boardRank: 'b' }),
        makeTask({ id: 'p2-spec-unranked', name: 'Spec unranked', workflowStage: 'spec' }),
      ]),
    ]);
    expect(cardIds(columns, 'spec')).toEqual(['p1-spec-a', 'p2-spec-b', 'p2-spec-unranked']);
    expect(columns.display.get('spec')).toEqual([
      { id: 'p1-spec-a', rank: 'a', projectId: 'project-1' },
      { id: 'p2-spec-b', rank: 'b', projectId: 'project-2' },
      { id: 'p2-spec-unranked', rank: null, projectId: 'project-2' },
    ]);
  });

  it('includes Unstaged and Triage columns with their cards, in COLUMNS order', () => {
    const columns = build([
      makeProject('project-1', [
        makeTask({ id: 'unstaged-1', name: 'Unstaged', workflowStage: undefined }),
        makeTask({ id: 'triage-1', name: 'Triage', workflowStage: 'triage' }),
      ]),
    ]);
    expect(cardIds(columns, 'unstaged')).toEqual(['unstaged-1']);
    expect(cardIds(columns, 'triage')).toEqual(['triage-1']);
    expect([...columns.display.keys()]).toEqual(COLUMNS);
  });

  it('orders every column like the Feature Board: ranked ascending first, unranked after in input order', () => {
    const columns = build([
      makeProject('project-1', [
        makeTask({ id: 'p1-unranked-1', workflowStage: 'review' }),
        makeTask({ id: 'p1-mid', workflowStage: 'review', boardRank: 'm' }),
        makeTask({ id: 'p1-unranked-2', workflowStage: 'review' }),
      ]),
      makeProject('project-2', [
        makeTask({ id: 'p2-first', workflowStage: 'review', boardRank: 'a' }),
        makeTask({ id: 'p2-last', workflowStage: 'review', boardRank: 'z' }),
      ]),
    ]);
    expect(cardIds(columns, 'review')).toEqual([
      'p2-first',
      'p1-mid',
      'p2-last',
      'p1-unranked-1',
      'p1-unranked-2',
    ]);
  });
});

describe('buildGlobalBoardColumns — Shipped Fade', () => {
  it('hides a shipped card merged before the fade window and keeps one merged within it, exactly as the Feature Board does', () => {
    const oldMergedAt = new Date(NOW - (SHIPPED_FADE_WINDOW_MS + 1000)).toISOString();
    const recentMergedAt = new Date(NOW - 1000).toISOString();
    const columns = build([
      makeProject('project-1', [
        makeTask({
          id: 'faded',
          workflowStage: 'shipped',
          prs: [makePr({ status: 'merged', mergedAt: oldMergedAt })],
        }),
        makeTask({
          id: 'recent',
          workflowStage: 'shipped',
          prs: [makePr({ status: 'merged', mergedAt: recentMergedAt })],
        }),
        makeTask({ id: 'shipped-no-pr', workflowStage: 'shipped' }),
      ]),
    ]);
    expect(cardIds(columns, 'shipped')).toEqual(['recent', 'shipped-no-pr']);
  });

  it('keeps a faded card in the true rank space so the drop mapper can guard against it', () => {
    const oldMergedAt = new Date(NOW - (SHIPPED_FADE_WINDOW_MS + 1000)).toISOString();
    const columns = build([
      makeProject('project-1', [
        makeTask({
          id: 'faded',
          workflowStage: 'shipped',
          boardRank: '5',
          prs: [makePr({ status: 'merged', mergedAt: oldMergedAt })],
        }),
        makeTask({ id: 'recent', workflowStage: 'shipped', boardRank: '7' }),
      ]),
    ]);
    expect((columns.trueSorted.get('shipped') ?? []).map((card) => card.id)).toEqual([
      'faded',
      'recent',
    ]);
    expect(cardIds(columns, 'shipped')).toEqual(['recent']);
  });

  it('omits projects without a single displayable card from the board and the candidate set', () => {
    const columns = build([
      makeProject('project-1', [
        makeTask({ id: 'archived', workflowStage: 'spec', archivedAt: '2026-01-02T00:00:00.000Z' }),
      ]),
      makeProject('project-2', [makeTask({ id: 'ok', workflowStage: 'idea' })]),
      makeProject('project-3', []),
    ]);
    expect(columns.presentProjects).toEqual(['project-2']);
    expect(cardIds(columns, 'spec')).toEqual([]);
    expect(cardIds(columns, 'idea')).toEqual(['ok']);
  });
});

describe('buildGlobalBoardColumns — Awaiting Input', () => {
  it('floats awaiting-input cards to the top of their shared column, across projects', () => {
    const columns = build(
      [
        makeProject('project-1', [
          makeTask({ id: 'p1-a', workflowStage: 'spec', boardRank: 'a' }),
          makeTask({ id: 'p1-b', workflowStage: 'spec', boardRank: 'b' }),
        ]),
        makeProject(
          'project-2',
          [makeTask({ id: 'p2-awaiting', workflowStage: 'spec', boardRank: 'z' })],
          { 'p2-awaiting': 'awaiting-input' }
        ),
      ],
      EMPTY_BOARD_FILTERS
    );
    expect(cardIds(columns, 'spec')).toEqual(['p2-awaiting', 'p1-a', 'p1-b']);
  });

  it('keeps the relative order within each partition while floating', () => {
    const columns = build([
      makeProject(
        'project-1',
        [
          makeTask({ id: 'p1-awaiting-a', workflowStage: 'idea' }),
          makeTask({ id: 'p1-rest', workflowStage: 'idea' }),
          makeTask({ id: 'p1-awaiting-b', workflowStage: 'idea' }),
        ],
        { 'p1-awaiting-a': 'awaiting-input', 'p1-awaiting-b': 'awaiting-input' }
      ),
      makeProject(
        'project-2',
        [
          makeTask({ id: 'p2-awaiting', workflowStage: 'idea' }),
          makeTask({ id: 'p2-rest', workflowStage: 'idea' }),
        ],
        { 'p2-awaiting': 'awaiting-input' }
      ),
    ]);
    expect(cardIds(columns, 'idea')).toEqual([
      'p1-awaiting-a',
      'p1-awaiting-b',
      'p2-awaiting',
      'p1-rest',
      'p2-rest',
    ]);
  });

  it('freezes the float while a drag is active, returning the sorted order unchanged', () => {
    const projects = [
      makeProject('project-1', [
        makeTask({ id: 'p1-a', workflowStage: 'spec', boardRank: 'a' }),
        makeTask({ id: 'p1-b', workflowStage: 'spec', boardRank: 'b' }),
      ]),
      makeProject(
        'project-2',
        [makeTask({ id: 'p2-awaiting', workflowStage: 'spec', boardRank: 'z' })],
        { 'p2-awaiting': 'awaiting-input' }
      ),
    ];
    expect(cardIds(build(projects, EMPTY_BOARD_FILTERS, { frozen: true }), 'spec')).toEqual([
      'p1-a',
      'p1-b',
      'p2-awaiting',
    ]);
  });
});

describe('buildGlobalBoardColumns — board filters and project selection', () => {
  it('applies the Board Header filters per card exactly as the Feature Board does', () => {
    const filters: BoardFilterState = { ...EMPTY_BOARD_FILTERS, query: 'alpha' };
    const columns = build(
      [
        makeProject('project-1', [
          makeTask({ id: 'alpha', name: 'Alpha feature', workflowStage: 'spec' }),
          makeTask({ id: 'beta', name: 'Beta feature', workflowStage: 'spec' }),
        ]),
        makeProject('project-2', [
          makeTask({ id: 'gamma', name: 'Gamma feature', workflowStage: 'spec' }),
        ]),
      ],
      filters
    );
    expect(cardIds(columns, 'spec')).toEqual(['alpha']);
  });

  it('keeps a project whose cards the ephemeral header filters hide in the candidate set', () => {
    const filters: BoardFilterState = { ...EMPTY_BOARD_FILTERS, query: 'alpha' };
    const columns = build(
      [
        makeProject('project-1', [
          makeTask({ id: 'alpha', name: 'Alpha feature', workflowStage: 'spec' }),
          makeTask({ id: 'beta', name: 'Beta feature', workflowStage: 'spec' }),
        ]),
        makeProject('project-2', [
          makeTask({ id: 'gamma', name: 'Gamma feature', workflowStage: 'spec' }),
        ]),
      ],
      filters
    );
    expect(columns.presentProjects).toEqual(['project-1', 'project-2']);
  });

  it("omits deselected projects' cards from the board but keeps them in the candidate set and the true rank space", () => {
    const columns = build(
      [
        makeProject('project-1', [
          makeTask({ id: 'p1-card', workflowStage: 'spec', boardRank: 'a' }),
        ]),
        makeProject('project-2', [
          makeTask({ id: 'p2-card', workflowStage: 'spec', boardRank: 'b' }),
        ]),
      ],
      EMPTY_BOARD_FILTERS,
      { selectedProjectIds: new Set(['project-1']) }
    );
    expect(cardIds(columns, 'spec')).toEqual(['p1-card']);
    expect(columns.presentProjects).toEqual(['project-1', 'project-2']);
    expect((columns.trueSorted.get('spec') ?? []).map((card) => card.id)).toEqual([
      'p1-card',
      'p2-card',
    ]);
  });
});

describe('projectPassesGlobalBoardFilter', () => {
  const present = new Set(['project-1', 'project-2']);

  it('omits deselected projects while keeping selected ones', () => {
    const selected = new Set(['project-2']);
    expect(projectPassesGlobalBoardFilter('project-1', present, selected)).toBe(false);
    expect(projectPassesGlobalBoardFilter('project-2', present, selected)).toBe(true);
  });

  it('treats an empty selection as "all projects"', () => {
    expect(projectPassesGlobalBoardFilter('project-1', present, new Set())).toBe(true);
    expect(projectPassesGlobalBoardFilter('project-2', present, new Set())).toBe(true);
  });

  it('omits projects without a single displayable card from the candidate set, even when selected', () => {
    const selected = new Set(['project-3']);
    expect(projectPassesGlobalBoardFilter('project-3', present, new Set())).toBe(false);
    expect(projectPassesGlobalBoardFilter('project-3', present, selected)).toBe(false);
  });
});

describe('computeGlobalDropPosition', () => {
  function buildSpecBoard(): GlobalBoardColumns {
    return build([
      makeProject('project-1', [
        makeTask({ id: 'dragged', workflowStage: 'spec', boardRank: 'a' }),
      ]),
      makeProject('project-2', [
        makeTask({ id: 'p2-first', workflowStage: 'spec', boardRank: '4' }),
        makeTask({ id: 'p2-second', workflowStage: 'spec', boardRank: '6' }),
      ]),
    ]);
  }

  it('changes the Workflow Stage for an inter-column drop', () => {
    const columns = buildSpecBoard();
    const result = computeGlobalDropPosition(columns, 'implementing', 'dragged', 0);
    expect(result.stage).toBe('implementing');
    expect(typeof result.rank).toBe('string');
    expect(result.rank.length).toBeGreaterThan(0);
  });

  it('clears the Workflow Stage when dropping into Unstaged', () => {
    const result = computeGlobalDropPosition(buildSpecBoard(), 'unstaged', 'dragged', 0);
    expect(result.stage).toBeNull();
  });

  it("interpolates Board Rank between another project's cards in the shared column, keeping the stage", () => {
    // Project-2's cards hold ranks '4' and '6' in the shared `spec` column;
    // dropping project-1's card between them must land strictly between the
    // two — rankBetween('4', '6') === '5' — with the stage unchanged.
    const result = computeGlobalDropPosition(buildSpecBoard(), 'spec', 'dragged', 1);
    expect(result.stage).toBe('spec');
    expect(result.rank).toBe('5');
  });

  it('produces a rank before the first card and after the last card of the shared column', () => {
    const columns = buildSpecBoard();
    expect(computeGlobalDropPosition(columns, 'spec', 'dragged', 0).rank < '4').toBe(true);
    expect(computeGlobalDropPosition(columns, 'spec', 'dragged', 2).rank > '6').toBe(true);
  });

  it('accepts a drop into an empty column and returns a usable rank', () => {
    const result = computeGlobalDropPosition(buildSpecBoard(), 'idea', 'dragged', 0);
    expect(result.stage).toBe('idea');
    expect(result.rank.length).toBeGreaterThan(0);
  });

  it("never collides with a header-filter-hidden card's rank in the shared column", () => {
    // `hidden` (project-1) holds rank '5' but an Agent State filter hides it;
    // it still occupies the shared `spec` rank space, so the naive
    // rankBetween('4', '6') === '5' must fall back to the true neighbours.
    const filters: BoardFilterState = { ...EMPTY_BOARD_FILTERS, agentStates: new Set(['working']) };
    const columns = build(
      [
        makeProject(
          'project-1',
          [
            makeTask({ id: 'dragged', workflowStage: 'spec', boardRank: 'a' }),
            makeTask({ id: 'hidden', workflowStage: 'spec', boardRank: '5' }),
          ],
          { dragged: 'working', hidden: 'completed' }
        ),
        makeProject(
          'project-2',
          [
            makeTask({ id: 'p2-first', workflowStage: 'spec', boardRank: '4' }),
            makeTask({ id: 'p2-second', workflowStage: 'spec', boardRank: '6' }),
          ],
          { 'p2-first': 'working', 'p2-second': 'working' }
        ),
      ],
      filters
    );
    const result = computeGlobalDropPosition(columns, 'spec', 'dragged', 1);
    expect(result.rank > '4').toBe(true);
    expect(result.rank < '6').toBe(true);
    expect(result.rank).not.toBe('5');
  });

  it("never collides with a deselected project's rank in the shared column", () => {
    // `hidden` lives in deselected project-2 but still holds rank '5' in the
    // shared `spec` rank space — the collision guard must see past the
    // project selection, or the drop would duplicate a real stored rank.
    const columns = build(
      [
        makeProject('project-1', [
          makeTask({ id: 'dragged', workflowStage: 'spec', boardRank: 'a' }),
        ]),
        makeProject('project-2', [
          makeTask({ id: 'hidden', workflowStage: 'spec', boardRank: '5' }),
        ]),
        makeProject('project-3', [
          makeTask({ id: 'p3-first', workflowStage: 'spec', boardRank: '4' }),
          makeTask({ id: 'p3-second', workflowStage: 'spec', boardRank: '6' }),
        ]),
      ],
      EMPTY_BOARD_FILTERS,
      { selectedProjectIds: new Set(['project-1', 'project-3']) }
    );
    const result = computeGlobalDropPosition(columns, 'spec', 'dragged', 1);
    expect(result.rank > '4').toBe(true);
    expect(result.rank < '6').toBe(true);
    expect(result.rank).not.toBe('5');
  });
});
