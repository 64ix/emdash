import { describe, expect, it } from 'vitest';
import type { LinkedIssue } from '@shared/core/linked-issue';
import type { PrWorkflowFact } from '@shared/core/pull-requests/pr-workflow-derivation';
import type { StageHoldingPr } from '@shared/core/tasks/tasks';
import { rankBetween } from '@shared/lib/board-rank';
import {
  buildStageGroupedRows,
  computeSidebarDropPosition,
  sidebarStageMoveOptions,
  taskRowVariants,
  type SidebarRow,
  type SidebarStageMoveTask,
  type StageGroupableTask,
  type StageGroupRowsInput,
} from './stage-group-row-model';

function task(id: string, overrides: Partial<StageGroupableTask> = {}): StageGroupableTask {
  return { id, ...overrides };
}

/** Collapses rows to `kind[:detail]` strings so expectations read top-down. */
function shape(rows: SidebarRow[]): string[] {
  return rows.map((row) => {
    switch (row.kind) {
      case 'project':
        return `project:${row.projectId}`;
      case 'task':
        return `task:${row.taskId}`;
      case 'stage-group':
        return `group:${row.label}:${row.count}`;
    }
  });
}

function build(
  input: Omit<StageGroupRowsInput, 'projectId'> & { projectId?: string }
): SidebarRow[] {
  return buildStageGroupedRows({ projectId: 'p1', ...input });
}

describe('buildStageGroupedRows', () => {
  it('leads every project with its project row', () => {
    expect(shape(build({ tasks: [] }))).toEqual(['project:p1']);
  });

  it('groups tasks by stage in board column order, skipping empty stages', () => {
    // Deliberately out of column order in input: grouping must follow COLUMNS.
    const rows = build({
      tasks: [
        task('shipped-1', { workflowStage: 'shipped' }),
        task('idea-1', { workflowStage: 'idea' }),
        task('triage-1', { workflowStage: 'triage' }),
        task('spec-1', { workflowStage: 'spec' }),
        task('idea-2', { workflowStage: 'idea' }),
      ],
    });
    expect(shape(rows)).toEqual([
      'project:p1',
      'group:Idea:2',
      'task:idea-1',
      'task:idea-2',
      'group:Spec:1',
      'task:spec-1',
      'group:Shipped:1',
      'task:shipped-1',
      'group:Triage:1',
      'task:triage-1',
    ]);
  });

  it('keeps Unstaged tasks as loose rows under the project row, with no header', () => {
    const rows = build({
      tasks: [
        task('spec-1', { workflowStage: 'spec' }),
        task('unstaged-1'),
        task('unstaged-2', { boardRank: 'a' }),
      ],
    });
    expect(shape(rows)).toEqual([
      'project:p1',
      'task:unstaged-2',
      'task:unstaged-1',
      'group:Spec:1',
      'task:spec-1',
    ]);
  });

  it('orders a group by Board Rank, unranked after in input order', () => {
    const rows = build({
      tasks: [
        task('u2', { workflowStage: 'spec' }),
        task('r-z', { workflowStage: 'spec', boardRank: 'z' }),
        task('u1', { workflowStage: 'spec' }),
        task('r-a', { workflowStage: 'spec', boardRank: 'a' }),
      ],
    });
    expect(shape(rows)).toEqual([
      'project:p1',
      'group:Spec:4',
      'task:r-a',
      'task:r-z',
      'task:u2',
      'task:u1',
    ]);
  });

  it('elevates Awaiting Input tasks to the top of their group at render time only', () => {
    const rows = build({
      tasks: [
        task('ranked-a', { workflowStage: 'spec', boardRank: 'a' }),
        task('awaiting-ranked', { workflowStage: 'spec', boardRank: 'c' }),
        task('unranked', { workflowStage: 'spec' }),
      ],
      awaitingInputIds: new Set(['awaiting-ranked']),
    });
    expect(shape(rows)).toEqual([
      'project:p1',
      'group:Spec:3',
      'task:awaiting-ranked',
      'task:ranked-a',
      'task:unranked',
    ]);
  });

  it('elevates Awaiting Input among Unstaged loose rows too', () => {
    const rows = build({
      tasks: [task('u1'), task('awaiting-u', { boardRank: 'b' }), task('u2')],
      awaitingInputIds: new Set(['awaiting-u']),
    });
    expect(shape(rows)).toEqual(['project:p1', 'task:awaiting-u', 'task:u1', 'task:u2']);
  });

  it('shows the visible-task count on each group header', () => {
    const rows = build({
      tasks: [
        task('s1', { workflowStage: 'spec' }),
        task('s2', { workflowStage: 'spec' }),
        task('s3', { workflowStage: 'spec' }),
      ],
    });
    const group = rows.find((row) => row.kind === 'stage-group');
    expect(group).toMatchObject({ kind: 'stage-group', stage: 'spec', count: 3 });
  });

  it('keeps a collapsed group header (and its count) while omitting its task rows', () => {
    const rows = build({
      tasks: [
        task('s1', { workflowStage: 'spec' }),
        task('s2', { workflowStage: 'spec' }),
        task('i1', { workflowStage: 'idea' }),
      ],
      collapsedStages: new Set(['spec']),
    });
    expect(shape(rows)).toEqual(['project:p1', 'group:Idea:1', 'task:i1', 'group:Spec:2']);
  });

  it('ignores collapsed ids for stages with no visible tasks (stale ids)', () => {
    const rows = build({
      tasks: [task('i1', { workflowStage: 'idea' })],
      collapsedStages: new Set(['review', 'shipped']),
    });
    expect(shape(rows)).toEqual(['project:p1', 'group:Idea:1', 'task:i1']);
  });

  it('applies the visibility filter to group membership and counts (ticket #87 seam)', () => {
    const hidden = new Set(['hidden-spec', 'hidden-unstaged']);
    const rows = build({
      tasks: [
        task('hidden-spec', { workflowStage: 'spec' }),
        task('s1', { workflowStage: 'spec' }),
        task('hidden-unstaged'),
        task('u1'),
      ],
      isVisible: (t) => !hidden.has(t.id),
    });
    expect(shape(rows)).toEqual(['project:p1', 'task:u1', 'group:Spec:1', 'task:s1']);
  });

  it('drops the Shipped group header entirely when the visibility filter hides every shipped task', () => {
    const rows = build({
      tasks: [
        task('shipped-1', { workflowStage: 'shipped' }),
        task('shipped-2', { workflowStage: 'shipped' }),
        task('spec-1', { workflowStage: 'spec' }),
      ],
      // The Shipped Fade rule (ticket #87): every shipped task's PR merged
      // past the window — an empty Shipped group is not rendered at all.
      isVisible: (t) => t.workflowStage !== 'shipped',
    });
    expect(shape(rows)).toEqual(['project:p1', 'group:Spec:1', 'task:spec-1']);
  });

  it('counts only non-faded tasks in the Shipped group, mirroring the board column', () => {
    const rows = build({
      tasks: [
        task('faded', { workflowStage: 'shipped' }),
        task('recent', { workflowStage: 'shipped' }),
        task('unranked-recent', { workflowStage: 'shipped' }),
      ],
      // Ticket #87: the shared fade predicate excludes only the faded task;
      // the group's count and rows reflect the remaining visible tasks.
      isVisible: (t) => t.id !== 'faded',
    });
    const group = rows.find((row) => row.kind === 'stage-group');
    expect(group).toMatchObject({
      kind: 'stage-group',
      stage: 'shipped',
      label: 'Shipped',
      count: 2,
    });
    expect(shape(rows)).toEqual([
      'project:p1',
      'group:Shipped:2',
      'task:recent',
      'task:unranked-recent',
    ]);
  });

  it('never mutates the input tasks or assigns a rank', () => {
    const tasks = [
      task('a', { workflowStage: 'spec', boardRank: 'z' }),
      task('b', { workflowStage: 'spec' }),
    ];
    build({ tasks });
    expect(tasks[0]).toEqual({ id: 'a', workflowStage: 'spec', boardRank: 'z' });
    expect(tasks[1]).toEqual({ id: 'b', workflowStage: 'spec' });
  });
});

describe('taskRowVariants', () => {
  it('marks every task of a group as grouped, Unstaged rows as underProject', () => {
    const rows = build({
      tasks: [
        task('u1'),
        task('s1', { workflowStage: 'spec' }),
        task('s2', { workflowStage: 'spec' }),
        task('i1', { workflowStage: 'idea' }),
      ],
    });
    const variants = taskRowVariants(rows);
    expect(variants.get('p1:u1')).toBe('underProject');
    expect(variants.get('p1:s1')).toBe('grouped');
    expect(variants.get('p1:s2')).toBe('grouped');
    expect(variants.get('p1:i1')).toBe('grouped');
  });

  it('keeps grouping after a collapsed group, and resets across projects', () => {
    const rows = build({
      tasks: [
        task('s1', { workflowStage: 'spec' }),
        task('i1', { workflowStage: 'idea' }),
        task('i2', { workflowStage: 'idea' }),
      ],
      collapsedStages: new Set(['spec']),
    });
    const variants = taskRowVariants(rows);
    expect(variants.get('p1:s1')).toBeUndefined(); // collapsed — no row
    expect(variants.get('p1:i1')).toBe('grouped');
    expect(variants.get('p1:i2')).toBe('grouped');

    // A following project's loose rows must not inherit the previous
    // project's group.
    const nextProject = buildStageGroupedRows({
      projectId: 'p2',
      tasks: [task('u2'), task('s2', { workflowStage: 'spec' })],
    });
    const nextVariants = taskRowVariants(nextProject);
    expect(nextVariants.get('p2:u2')).toBe('underProject');
    expect(nextVariants.get('p2:s2')).toBe('grouped');
  });
});

describe('computeSidebarDropPosition', () => {
  it('interpolates a rank between visible neighbours for a positioned within-group drop', () => {
    const entries = [
      { id: 'a', rank: 'a' },
      { id: 'c', rank: 'c' },
    ];
    const position = computeSidebarDropPosition('spec', entries, 1);
    expect(position).toEqual({ stage: 'spec', rank: rankBetween('a', 'c') });
  });

  it('produces the first rank of the column for a drop before the first ranked task', () => {
    const entries = [
      { id: 'a', rank: 'b' },
      { id: 'c', rank: 'c' },
    ];
    const position = computeSidebarDropPosition('spec', entries, 0);
    expect(position).toEqual({ stage: 'spec', rank: rankBetween(null, 'b') });
  });

  it('appends after the ranked prefix when the drop index lands in the unranked tail', () => {
    const entries = [
      { id: 'a', rank: 'a' },
      { id: 'u1', rank: null },
      { id: 'u2', rank: null },
    ];
    // Index 2 lands among unranked entries — clamps to the end of the
    // ranked prefix, exactly like a board drop.
    const position = computeSidebarDropPosition('spec', entries, 2);
    expect(position).toEqual({ stage: 'spec', rank: rankBetween('a', null) });
  });

  it('returns a stage-only position (no rank) for an unpositioned end-of-group drop', () => {
    const entries = [
      { id: 'a', rank: 'a' },
      { id: 'b', rank: 'b' },
    ];
    const position = computeSidebarDropPosition('spec', entries, null);
    expect(position).toEqual({ stage: 'spec', rank: null });
  });

  it('never reproduces a hidden task rank when trueEntries are supplied (board parity)', () => {
    // Visible neighbours '4' and '6' midpoint to '5' — the rank a hidden
    // task already holds. The board's trueEntries guard (ticket #45) must
    // fall back to interpolating against the true neighbour instead of
    // duplicating '5' (which would violate rankBetween's ordering guard on
    // a later drop next to it).
    const entries = [
      { id: 'v4', rank: '4' },
      { id: 'v6', rank: '6' },
    ];
    const trueEntries = [
      { id: 'v4', rank: '4' },
      { id: 'hidden-5', rank: '5' },
      { id: 'v6', rank: '6' },
    ];
    const position = computeSidebarDropPosition('spec', entries, 1, trueEntries);
    expect(position.stage).toBe('spec');
    expect(position.rank).not.toBeNull();
    // Strictly between the visible lower bound and the hidden card's rank.
    expect(position.rank! > '4' && position.rank! < '5').toBe(true);
  });

  it('returns a stage-only position for a drop into an empty group body', () => {
    const position = computeSidebarDropPosition('review', [], null);
    expect(position).toEqual({ stage: 'review', rank: null });
  });

  it('clears the stage for a positioned Unstaged drop', () => {
    const entries = [
      { id: 'a', rank: 'a' },
      { id: 'c', rank: 'c' },
    ];
    const position = computeSidebarDropPosition('unstaged', entries, 1);
    expect(position).toEqual({ stage: null, rank: rankBetween('a', 'c') });
  });

  it('clears the stage and assigns no rank for an unpositioned Unstaged drop', () => {
    const position = computeSidebarDropPosition('unstaged', [], null);
    expect(position).toEqual({ stage: null, rank: null });
  });
});

function issue(overrides: Partial<LinkedIssue> = {}): LinkedIssue {
  return {
    provider: 'github',
    url: 'https://github.com/acme/repo/issues/1',
    title: 'Example issue',
    identifier: '#1',
    ...overrides,
  };
}

/** A Spec-referencing PR like the ones stored on the task (`PullRequest`'s
 * `PrWorkflowFact` subset plus the `StageHoldingPr` fields the authority
 * explanation labels it with). */
type StageMovePr = PrWorkflowFact &
  Pick<StageHoldingPr, 'url' | 'title' | 'identifier' | 'isDraft'>;

function pr(overrides: Partial<StageMovePr> = {}): StageMovePr {
  return {
    repositoryUrl: 'https://github.com/acme/repo',
    headRefName: 'spec/1-something',
    status: 'open',
    description: null,
    url: 'https://github.com/acme/repo/pull/1',
    identifier: '#1',
    title: 'Example PR',
    isDraft: false,
    ...overrides,
  };
}

function stageTask(overrides: Partial<SidebarStageMoveTask> = {}): SidebarStageMoveTask {
  return { workflowStage: 'idea', prs: [], ...overrides };
}

describe('sidebarStageMoveOptions (spec #85, ticket #88)', () => {
  it('offers all seven stages plus Unstaged, in pipeline order, for any task', () => {
    const { options } = sidebarStageMoveOptions(stageTask(), null);
    expect(options.map((option) => option.label)).toEqual([
      'Idea',
      'Exploring',
      'Spec',
      'Implementing',
      'Review',
      'Shipped',
      'Triage',
      'Unstaged',
    ]);
  });

  it('leaves every destination open for a manual placement, with no explanation', () => {
    const { options, explanation } = sidebarStageMoveOptions(stageTask(), null);
    expect(options.every((option) => !option.blocked)).toBe(true);
    expect(explanation).toBeNull();
  });

  it('leaves every destination open for a provisioned-implementation placement', () => {
    const task = stageTask({ workflowStage: 'implementing', workspaceId: 'workspace-1' });
    const { options, explanation } = sidebarStageMoveOptions(task, null);
    expect(options.every((option) => !option.blocked)).toBe(true);
    expect(explanation).toBeNull();
  });

  it('blocks destinations an open Map issue would re-advance into Exploring', () => {
    const map = issue({ identifier: '#55', status: 'open' });
    const { options, explanation } = sidebarStageMoveOptions(
      stageTask({ linkedIssues: { version: '1', map } }),
      null
    );
    const blocked = options.filter((option) => option.blocked).map((option) => option.label);
    expect(blocked).toEqual(['Idea', 'Exploring', 'Unstaged']);
    expect(options.find((option) => option.label === 'Triage')?.blocked).toBe(false);
    expect(explanation).toContain('linked Map issue');
  });

  it('blocks destinations at or below Spec for an open Spec issue', () => {
    const spec = issue({ identifier: '#56', status: 'open' });
    const { options, explanation } = sidebarStageMoveOptions(
      stageTask({ linkedIssues: { version: '1', spec } }),
      null
    );
    const blocked = options.filter((option) => option.blocked).map((option) => option.label);
    expect(blocked).toEqual(['Idea', 'Exploring', 'Spec', 'Unstaged']);
    expect(options.find((option) => option.label === 'Implementing')?.blocked).toBe(false);
    expect(explanation).toContain('linked Spec issue');
  });

  it('blocks every destination but Triage for a task held by an open PR', () => {
    const spec = issue({ identifier: '#56', status: 'open' });
    const task = stageTask({
      workflowStage: 'review',
      linkedIssues: { version: '1', spec },
      prs: [pr({ status: 'open', headRefName: 'spec/56-feature' })],
    });
    const { options, explanation } = sidebarStageMoveOptions(task, null);
    expect(options.filter((option) => option.blocked)).toHaveLength(7);
    expect(options.find((option) => option.label === 'Triage')?.blocked).toBe(false);
    expect(explanation).toContain('Held in Review by an open PR');
  });

  it('blocks every destination but Triage for a task held by a merged PR', () => {
    const spec = issue({ identifier: '#56', status: 'open' });
    const task = stageTask({
      workflowStage: 'shipped',
      linkedIssues: { version: '1', spec },
      prs: [pr({ status: 'merged', headRefName: 'spec/56-feature' })],
    });
    const { options, explanation } = sidebarStageMoveOptions(task, null);
    expect(options.filter((option) => option.blocked)).toHaveLength(7);
    expect(options.find((option) => option.label === 'Triage')?.blocked).toBe(false);
    expect(explanation).toContain('merged pull request is permanent');
  });

  it('blocks every destination but Triage for a closed-PR contradiction', () => {
    const spec = issue({ identifier: '#56', status: 'open' });
    const task = stageTask({
      workflowStage: 'implementing',
      linkedIssues: { version: '1', spec },
      prs: [pr({ status: 'closed', headRefName: 'spec/56-feature' })],
    });
    const { options } = sidebarStageMoveOptions(task, null);
    expect(options.filter((option) => option.blocked)).toHaveLength(7);
    expect(options.find((option) => option.label === 'Triage')?.blocked).toBe(false);
  });

  it('keeps only Review and Shipped (plus Triage) open for a closed-Spec contradiction', () => {
    const spec = issue({ identifier: '#56', status: 'closed' });
    const task = stageTask({
      workflowStage: 'implementing',
      linkedIssues: { version: '1', spec },
    });
    const { options, explanation } = sidebarStageMoveOptions(task, null);
    const open = options.filter((option) => !option.blocked).map((option) => option.label);
    expect(open).toEqual(['Review', 'Shipped', 'Triage']);
    expect(explanation).toContain('closed without a merged pull request');
  });

  it('derives the PR authority from the task branch, like the board does', () => {
    const spec = issue({ identifier: '#56', status: 'open' });
    const task = stageTask({
      workflowStage: 'review',
      linkedIssues: { version: '1', spec },
      prs: [pr({ headRefName: 'spec/56-matching-branch' })],
    });
    // The PR references the Spec via its branch, so it governs even with no
    // description — same matching the board's `authorityForTask` performs.
    const { options, explanation } = sidebarStageMoveOptions(task, 'spec/56-matching-branch');
    expect(options.filter((option) => option.blocked)).toHaveLength(7);
    expect(explanation).toContain('#1');
  });
});
