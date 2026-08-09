import { describe, expect, it } from 'vitest';
import type { WorkflowStage } from '@shared/core/tasks/tasks';
import {
  buildProjectCards,
  LIVE_SIGNAL_PRIORITY,
  PROJECT_HUES,
  projectHue,
  projectHueName,
  type ProjectCardModelInput,
  type ProjectHue,
  type SidebarCardModel,
} from './project-card-model';
import {
  buildStageGroupedRows,
  type SidebarRow,
  type StageGroupableTask,
} from './stage-group-row-model';

function task(id: string, overrides: Partial<StageGroupableTask> = {}): StageGroupableTask {
  return { id, ...overrides };
}

/**
 * Builds the stage-grouped row stream the way `SidebarStore.sidebarRows`
 * does (one project after another, `buildStageGroupedRows` per project), so
 * the fixtures exercise the real store seam — including collapsed-group
 * task omission.
 */
function stream(
  projects: Array<{
    projectId: string;
    tasks: StageGroupableTask[];
    collapsedStages?: WorkflowStage[];
  }>
): SidebarRow[] {
  const rows: SidebarRow[] = [];
  for (const project of projects) {
    rows.push(
      ...buildStageGroupedRows({
        projectId: project.projectId,
        tasks: project.tasks,
        collapsedStages: new Set(project.collapsedStages ?? []),
      })
    );
  }
  return rows;
}

/** Collapses cards to compact strings so expectations read top-down. */
function shape(cards: SidebarCardModel[]): string[] {
  return cards.map(
    (card) =>
      `${card.projectId} [${card.stageGroups.map((g) => `${g.stage}:${g.count}`).join(',')}]` +
      ` (${card.tasks.map((t) => t.taskId).join(',')})`
  );
}

function build(input: ProjectCardModelInput): SidebarCardModel[] {
  return buildProjectCards(input);
}

describe('buildProjectCards (spec #120, ticket #121)', () => {
  it('derives one card per project, in stream order, with stage groups and task membership', () => {
    const rows = stream([
      {
        projectId: 'p1',
        tasks: [
          task('p1-spec', { workflowStage: 'spec' }),
          task('p1-idea', { workflowStage: 'idea' }),
        ],
      },
      { projectId: 'p2', tasks: [task('p2-unstaged')] },
    ]);
    expect(shape(build({ rows }))).toEqual([
      'p1 [idea:1,spec:1] (p1-idea,p1-spec)',
      'p2 [] (p2-unstaged)',
    ]);
  });

  it('keeps stage groups in board column order with their labels and counts', () => {
    // Deliberately out of column order in input: the stream (and thus the
    // card) must follow the board's COLUMNS order, not input order.
    const rows = stream([
      {
        projectId: 'p1',
        tasks: [
          task('shipped-1', { workflowStage: 'shipped' }),
          task('idea-1', { workflowStage: 'idea' }),
          task('spec-1', { workflowStage: 'spec' }),
          task('idea-2', { workflowStage: 'idea' }),
        ],
      },
    ]);
    const card = build({ rows })[0];
    expect(card.stageGroups.map((g) => `${g.label}:${g.count}`)).toEqual([
      'Idea:2',
      'Spec:1',
      'Shipped:1',
    ]);
    expect(card.tasks.map((t) => t.taskId)).toEqual(['idea-1', 'idea-2', 'spec-1', 'shipped-1']);
  });

  it('preserves the interleaved body order: Unstaged rows first, then each group followed by its own tasks', () => {
    const rows = stream([
      {
        projectId: 'p1',
        tasks: [
          task('u1'),
          task('s1', { workflowStage: 'spec' }),
          task('i1', { workflowStage: 'idea' }),
          task('s2', { workflowStage: 'spec' }),
          task('i2', { workflowStage: 'idea' }),
        ],
      },
    ]);
    const card = build({ rows })[0];
    expect(
      card.body.map((entry) =>
        entry.kind === 'task' ? `task:${entry.taskId}` : `group:${entry.stage}`
      )
    ).toEqual(['task:u1', 'group:idea', 'task:i1', 'task:i2', 'group:spec', 'task:s1', 'task:s2']);
    // The two flat lists are exactly the body's entries in their own order.
    expect(card.body).toEqual([
      { kind: 'task', projectId: 'p1', taskId: 'u1' },
      { kind: 'stage-group', stage: 'idea', label: 'Idea', count: 2 },
      { kind: 'task', projectId: 'p1', taskId: 'i1' },
      { kind: 'task', projectId: 'p1', taskId: 'i2' },
      { kind: 'stage-group', stage: 'spec', label: 'Spec', count: 2 },
      { kind: 'task', projectId: 'p1', taskId: 's1' },
      { kind: 'task', projectId: 'p1', taskId: 's2' },
    ]);
  });

  it('drops collapsed-group tasks from the body while keeping their headers and counts', () => {
    const rows = stream([
      {
        projectId: 'p1',
        tasks: [task('i1', { workflowStage: 'idea' }), task('s1', { workflowStage: 'spec' })],
        collapsedStages: ['spec'],
      },
    ]);
    const card = build({ rows })[0];
    expect(card.body).toEqual([
      { kind: 'stage-group', stage: 'idea', label: 'Idea', count: 1 },
      { kind: 'task', projectId: 'p1', taskId: 'i1' },
      { kind: 'stage-group', stage: 'spec', label: 'Spec', count: 1 },
    ]);
  });

  it('omits the tasks of collapsed groups while keeping their headers and counts', () => {
    const rows = stream([
      {
        projectId: 'p1',
        tasks: [
          task('s1', { workflowStage: 'spec' }),
          task('s2', { workflowStage: 'spec' }),
          task('i1', { workflowStage: 'idea' }),
        ],
        collapsedStages: ['spec'],
      },
    ]);
    const card = build({ rows })[0];
    // The collapsed group's header (and count) stays; its task rows are
    // gone from the stream, so they are gone from the card membership.
    expect(card.stageGroups).toContainEqual({ stage: 'spec', label: 'Spec', count: 2 });
    expect(card.tasks.map((t) => t.taskId)).toEqual(['i1']);
    expect(card.visibleTaskCount).toBe(1);
  });

  it('produces an empty card for a project row with no content (collapsed project)', () => {
    const rows: SidebarRow[] = [{ kind: 'project', projectId: 'p1' }];
    const card = build({ rows })[0];
    expect(card).toMatchObject({
      projectId: 'p1',
      stageGroups: [],
      tasks: [],
      aggregateSignal: null,
      attentionCount: 0,
      visibleTaskCount: 0,
    });
  });

  it('keeps one card per project even for interleaved rows (defensive)', () => {
    // The store emits rows pre-grouped, but the projection must not depend
    // on that: a task row of p1 after p2's project row still lands on p1's
    // card, in stream order.
    const rows: SidebarRow[] = [
      { kind: 'project', projectId: 'p1' },
      { kind: 'task', projectId: 'p1', taskId: 'p1-a' },
      { kind: 'project', projectId: 'p2' },
      { kind: 'stage-group', projectId: 'p2', stage: 'spec', label: 'Spec', count: 1 },
      { kind: 'task', projectId: 'p2', taskId: 'p2-a' },
      { kind: 'stage-group', projectId: 'p1', stage: 'idea', label: 'Idea', count: 1 },
    ];
    expect(shape(build({ rows }))).toEqual(['p1 [idea:1] (p1-a)', 'p2 [spec:1] (p2-a)']);
  });

  it('never mutates the input rows', () => {
    const rows = stream([{ projectId: 'p1', tasks: [task('s1', { workflowStage: 'spec' })] }]);
    const snapshot = rows.map((row) => ({ ...row }));
    build({ rows });
    expect(rows).toEqual(snapshot);
  });
});

describe('buildProjectCards aggregates', () => {
  it('aggregates the live signal with priority error > awaiting-input > working', () => {
    expect(LIVE_SIGNAL_PRIORITY.error).toBeLessThan(LIVE_SIGNAL_PRIORITY['awaiting-input']);
    expect(LIVE_SIGNAL_PRIORITY['awaiting-input']).toBeLessThan(LIVE_SIGNAL_PRIORITY.working);

    const rows = stream([
      {
        projectId: 'p1',
        tasks: [
          task('t-working', { workflowStage: 'spec' }),
          task('t-awaiting', { workflowStage: 'spec' }),
          task('t-error', { workflowStage: 'spec' }),
        ],
      },
    ]);
    expect(
      build({
        rows,
        signalByTaskId: new Map([
          ['t-working', 'working'],
          ['t-awaiting', 'awaiting-input'],
          ['t-error', 'error'],
        ]),
      })[0].aggregateSignal
    ).toBe('error');

    // Awaiting-input outranks working when no error is present.
    expect(
      build({
        rows,
        signalByTaskId: new Map([
          ['t-working', 'working'],
          ['t-awaiting', 'awaiting-input'],
        ]),
      })[0].aggregateSignal
    ).toBe('awaiting-input');
  });

  it('never lights the header from a completed, idle or missing signal', () => {
    const rows = stream([{ projectId: 'p1', tasks: [task('t-done', { workflowStage: 'spec' })] }]);
    // Completed alone: no header signal.
    expect(
      build({ rows, signalByTaskId: new Map([['t-done', 'completed']]) })[0].aggregateSignal
    ).toBeNull();
    // Missing lookup (idle/missing agent): no header signal.
    expect(build({ rows })[0].aggregateSignal).toBeNull();
    // Completed next to working: working lights the header, completed does not.
    const mixed = stream([
      {
        projectId: 'p1',
        tasks: [
          task('t-done', { workflowStage: 'spec' }),
          task('t-work', { workflowStage: 'spec' }),
        ],
      },
    ]);
    expect(
      build({
        rows: mixed,
        signalByTaskId: new Map([
          ['t-done', 'completed'],
          ['t-work', 'working'],
        ]),
      })[0].aggregateSignal
    ).toBe('working');
  });

  it('folds collapsed-group tasks into the header aggregates of an expanded card', () => {
    // Ticket #121 review: the header aggregates over all project refs,
    // regardless of expand state — a task inside a collapsed Stage Group
    // still counts and can still light the header signal.
    const rows = stream([
      {
        projectId: 'p1',
        tasks: [
          task('visible-1', { workflowStage: 'spec' }),
          task('collapsed-1', { workflowStage: 'idea' }),
        ],
        collapsedStages: ['idea'],
      },
    ]);
    const card = build({
      rows,
      signalByTaskId: new Map([
        ['visible-1', 'working'],
        ['collapsed-1', 'error'],
      ]),
      attentionTaskIdsByProject: new Map([['p1', new Set(['visible-1', 'collapsed-1'])]]),
      headerTaskIdsByProjectId: new Map([['p1', ['collapsed-1']]]),
    })[0];
    expect(card.tasks.map((t) => t.taskId)).toEqual(['visible-1']);
    expect(card.visibleTaskCount).toBe(2); // stream rows + folded collapsed-group tasks
    expect(card.aggregateSignal).toBe('error'); // the collapsed-group error wins the header
    // Attention matches the old project-row badge: every non-hidden task of
    // the project counts, collapsed-group tasks included.
    expect(card.attentionCount).toBe(2);
  });

  it('folds caller-supplied refs into the header aggregates of a collapsed project', () => {
    // `sidebarRows` emits only the `project` row for a collapsed project
    // (sidebar-store.ts), so the card body is empty; ticket #122 supplies
    // the project's visible task ids and the header still carries count,
    // live signal and attention (spec #120 US4-6).
    const rows: SidebarRow[] = [{ kind: 'project', projectId: 'p1' }];
    const card = build({
      rows,
      headerTaskIdsByProjectId: new Map([['p1', ['a', 'b', 'c']]]),
      signalByTaskId: new Map([
        ['a', 'working'],
        ['b', 'error'],
        ['c', 'completed'],
      ]),
      attentionTaskIdsByProject: new Map([['p1', new Set(['b', 'c'])]]),
    })[0];
    expect(card.tasks).toEqual([]); // no task rows render in the collapsed body
    expect(card.stageGroups).toEqual([]);
    expect(card.body).toEqual([]);
    expect(card.visibleTaskCount).toBe(3);
    expect(card.aggregateSignal).toBe('error'); // the same priority over the refs
    expect(card.attentionCount).toBe(2); // the per-project attention set, refs or not
  });

  it('keeps the collapsed header at null/0 when the refs carry no live signal', () => {
    const rows: SidebarRow[] = [{ kind: 'project', projectId: 'p1' }];
    const card = build({
      rows,
      headerTaskIdsByProjectId: new Map([['p1', ['a', 'b']]]),
      signalByTaskId: new Map([
        ['a', 'completed'],
        ['b', 'completed'],
      ]),
      attentionTaskIdsByProject: new Map([['p1', new Set()]]),
    })[0];
    expect(card.visibleTaskCount).toBe(2); // the count badge still shows
    expect(card.aggregateSignal).toBeNull(); // completed never lights the header
    expect(card.attentionCount).toBe(0);
  });

  it('folds refs in addition to stream rows, with stream rows never duplicated', () => {
    // The caller supplies the stream-omitted ids per project (collapsed
    // groups); a folded id can never collide with a stream row — task ids
    // are globally unique — so the count is rows + refs, and the signal
    // folds both with the same priority.
    const rows = stream([
      { projectId: 'p1', tasks: [task('stream-a', { workflowStage: 'spec' })] },
    ]);
    const card = build({
      rows,
      headerTaskIdsByProjectId: new Map([['p1', ['ref-a']]]),
      signalByTaskId: new Map([
        ['stream-a', 'working'],
        ['ref-a', 'error'],
      ]),
    })[0];
    expect(card.tasks.map((t) => t.taskId)).toEqual(['stream-a']);
    expect(card.visibleTaskCount).toBe(2);
    expect(card.aggregateSignal).toBe('error'); // ref-a folds in and outranks
  });

  it('counts attention per project, pinned and collapsed-group tasks included', () => {
    const rows = stream([
      {
        projectId: 'p1',
        tasks: [
          task('a', { workflowStage: 'spec' }),
          task('b', { workflowStage: 'spec' }),
          task('c', { workflowStage: 'idea' }),
        ],
      },
      { projectId: 'p2', tasks: [task('d', { workflowStage: 'spec' })] },
    ]);
    const cards = build({
      rows,
      // `taskNeedsAttention` results wired by the caller (board-attention.ts);
      // pinned/automation tasks never appear in the stream but still count,
      // exactly like the old project-row attention badge.
      attentionTaskIdsByProject: new Map([
        ['p1', new Set(['a', 'c', 'pinned-1'])],
        ['p2', new Set(['d'])],
      ]),
    });
    expect(cards[0].attentionCount).toBe(3);
    expect(cards[1].attentionCount).toBe(1);
  });

  it('is deterministic: identical inputs produce deep-equal cards', () => {
    const rows = stream([
      {
        projectId: 'p1',
        tasks: [task('a', { workflowStage: 'spec' }), task('b', { workflowStage: 'idea' })],
      },
    ]);
    const input: ProjectCardModelInput = {
      rows,
      signalByTaskId: new Map([
        ['a', 'working'],
        ['b', 'error'],
      ]),
      attentionTaskIds: new Set(['b']),
    };
    expect(build(input)).toEqual(build(input));
  });
});

describe('project hue (spec #120, ticket #121)', () => {
  it('is stable across calls for a given project id', () => {
    expect(projectHueName('p1')).toBe(projectHueName('p1'));
    expect(projectHue('p1')).toEqual(projectHue('p1'));
    expect(projectHueName('project-7')).toBe(projectHueName('project-7'));
  });

  it('spans the fixed 8-hue palette', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      seen.add(projectHueName(`project-${i}`));
    }
    expect(seen.size).toBe(PROJECT_HUES.length);
    for (const hue of PROJECT_HUES) {
      expect(seen.has(hue)).toBe(true);
    }
  });

  it('renders tokens from the per-theme palette variables and color-mix', () => {
    // One project id per palette member, so every hue's tokens are checked.
    const projectIdByHue = new Map<ProjectHue, string>();
    for (let i = 0; i < 200 && projectIdByHue.size < PROJECT_HUES.length; i += 1) {
      const hue = projectHueName(`project-${i}`);
      if (!projectIdByHue.has(hue)) projectIdByHue.set(hue, `project-${i}`);
    }
    for (const hue of PROJECT_HUES) {
      const projectId = projectIdByHue.get(hue);
      expect(projectId).toBeDefined();
      const tokens = projectHue(projectId!);
      expect(tokens.fg).toBe(`var(--${hue}-11)`);
      expect(tokens.dot).toBe(`var(--${hue}-9)`);
      expect(tokens.rail).toBe(`color-mix(in srgb, var(--${hue}-11) 35%, transparent)`);
      expect(tokens.chipBg).toBe(`color-mix(in srgb, var(--${hue}-11) 14%, transparent)`);
    }
  });

  it("carries each card's stable hue on the model", () => {
    const rows = stream([
      { projectId: 'p1', tasks: [task('a', { workflowStage: 'spec' })] },
      { projectId: 'p2', tasks: [] },
    ]);
    const cards = build({ rows });
    expect(cards[0].hue).toBe(projectHueName('p1'));
    expect(cards[1].hue).toBe(projectHueName('p2'));
  });
});
