import { observable, runInAction } from 'mobx';
import { describe, expect, it, vi } from 'vitest';
import type { TaskStore } from '@renderer/features/tasks/stores/task-store';
import { SHIPPED_FADE_WINDOW_MS } from '@shared/core/pull-requests/pr-workflow-derivation';
import type { WorkflowStage } from '@shared/core/tasks/tasks';
import { SidebarStore } from './sidebar-store';

type SidebarProjectManager = ConstructorParameters<typeof SidebarStore>[0];

vi.mock('@renderer/lib/ipc', () => ({
  events: {
    on: vi.fn(),
  },
  rpc: {},
}));

vi.mock('@renderer/lib/stores/app-state', () => ({
  appState: {},
}));

vi.mock('@renderer/features/conversations/acp/acp-chat-store', () => ({
  AcpChatStore: class {
    conversationId = '';
    dispose() {}
    bootstrap() {}
  },
}));

vi.mock('@renderer/features/conversations/acp/acp-chat-panel', () => ({
  AcpChatPanel: () => null,
}));

/**
 * Controllable conversation statuses for the real `taskAgentStatus` selector:
 * the store reads Awaiting Input status through `conversationRegistry`, so
 * tests seed per-task statuses here instead of constructing real
 * ConversationManagerStores.
 */
const registryMocks = vi.hoisted(() => {
  const statusByTaskId = new Map<string, string | null>();
  return { statusByTaskId };
});

vi.mock('@renderer/features/conversations/stores/conversation-registry', () => ({
  conversationRegistry: {
    get: (taskId: string) => {
      const status = registryMocks.statusByTaskId.get(taskId) ?? null;
      return {
        get taskStatus() {
          return status;
        },
      };
    },
  },
}));

function projectManager(projects: { id: string; createdAt: string }[]): SidebarProjectManager {
  return {
    projects: new Map(projects.map((p) => [p.id, { ...p, mountedProject: null }])),
  } as unknown as SidebarProjectManager;
}

type TaskFixture = {
  id: string;
  createdAt: string;
  workflowStage?: WorkflowStage;
  boardRank?: string;
  isPinned?: boolean;
  prs?: { status: string; mergedAt: string | null }[];
};

function task(taskId: string, createdAt: string, overrides: Partial<TaskFixture> = {}) {
  return {
    state: 'provisioned',
    data: {
      id: taskId,
      type: 'coding-agent',
      isPinned: false,
      createdAt,
      updatedAt: createdAt,
      // The store now runs the shared Shipped Fade predicate on registered
      // tasks, which reads `prs`; an empty array keeps the default non-faded.
      prs: [],
      ...overrides,
    },
  };
}

function projectManagerWithTasks(
  projects: { id: string; createdAt: string; tasks: TaskFixture[] }[]
): SidebarProjectManager {
  // The real ProjectManagerStore keeps `projects` in an observable map;
  // mirroring that here means mutations made through the fixture (deleting
  // or adding tasks) are visible to the store's own observable view of it —
  // a plain object would be deep-converted into a private copy by
  // `makeAutoObservable`, and later fixture mutations would silently no-op.
  return {
    projects: observable.map(
      projects.map((project) => [
        project.id,
        {
          id: project.id,
          createdAt: project.createdAt,
          mountedProject: {
            taskManager: {
              tasks: new Map(
                project.tasks.map((fixture) => [
                  fixture.id,
                  task(fixture.id, fixture.createdAt, fixture),
                ])
              ),
            },
          },
        },
      ])
    ),
  } as unknown as SidebarProjectManager;
}

/** Rows collapsed to `kind[:detail]` strings for readable assertions. */
function shape(rows: SidebarStore['sidebarRows']): string[] {
  return rows.map((row) => {
    switch (row.kind) {
      case 'project':
        return `project:${row.projectId}`;
      case 'board':
        return `board:${row.projectId}`;
      case 'task':
        return `task:${row.taskId}`;
      case 'stage-group':
        return `group:${row.label}:${row.count}`;
    }
  });
}

describe('SidebarStore project ordering', () => {
  it('sorts projects newest first by default', () => {
    const store = new SidebarStore(
      projectManager([
        { id: 'old', createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 'new', createdAt: '2026-01-02T00:00:00.000Z' },
      ])
    );

    expect(store.orderedProjects.map((project) => project.id)).toEqual(['new', 'old']);
  });

  it('places projects missing from a saved manual order first', () => {
    const store = new SidebarStore(
      projectManager([
        { id: 'old', createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 'manual', createdAt: '2026-01-02T00:00:00.000Z' },
        { id: 'new', createdAt: '2026-01-03T00:00:00.000Z' },
      ])
    );

    store.setProjectOrder(['manual', 'old']);

    expect(store.orderedProjects.map((project) => project.id)).toEqual(['new', 'manual', 'old']);
  });
});

describe('SidebarStore grouped rows (spec #85, ticket #86)', () => {
  it('renders one collapsible Stage Group per non-empty stage, in board column order', () => {
    const store = new SidebarStore(
      projectManagerWithTasks([
        {
          id: 'project-1',
          createdAt: '2026-01-01T00:00:00.000Z',
          tasks: [
            { id: 'shipped-1', createdAt: '2026-01-01T00:00:01.000Z', workflowStage: 'shipped' },
            { id: 'idea-1', createdAt: '2026-01-01T00:00:02.000Z', workflowStage: 'idea' },
            { id: 'spec-1', createdAt: '2026-01-01T00:00:03.000Z', workflowStage: 'spec' },
            { id: 'idea-2', createdAt: '2026-01-01T00:00:04.000Z', workflowStage: 'idea' },
          ],
        },
      ])
    );

    store.ensureProjectExpanded('project-1');

    expect(shape(store.sidebarRows)).toEqual([
      'project:project-1',
      'board:project-1',
      'group:Idea:2',
      'task:idea-1',
      'task:idea-2',
      'group:Spec:1',
      'task:spec-1',
      'group:Shipped:1',
      'task:shipped-1',
    ]);
  });

  it('keeps Unstaged tasks as loose rows between the Board row and the first group', () => {
    const store = new SidebarStore(
      projectManagerWithTasks([
        {
          id: 'project-1',
          createdAt: '2026-01-01T00:00:00.000Z',
          tasks: [
            { id: 'spec-1', createdAt: '2026-01-01T00:00:01.000Z', workflowStage: 'spec' },
            { id: 'unstaged-1', createdAt: '2026-01-01T00:00:02.000Z' },
            { id: 'unstaged-2', createdAt: '2026-01-01T00:00:03.000Z', boardRank: 'a' },
          ],
        },
      ])
    );

    store.ensureProjectExpanded('project-1');

    expect(shape(store.sidebarRows)).toEqual([
      'project:project-1',
      'board:project-1',
      'task:unstaged-2',
      'task:unstaged-1',
      'group:Spec:1',
      'task:spec-1',
    ]);
  });

  it('orders a group by Board Rank, unranked after, with Awaiting Input elevated', () => {
    const store = new SidebarStore(
      projectManagerWithTasks([
        {
          id: 'project-1',
          createdAt: '2026-01-01T00:00:00.000Z',
          tasks: [
            { id: 'unranked-1', createdAt: '2026-01-01T00:00:01.000Z', workflowStage: 'spec' },
            {
              id: 'ranked-z',
              createdAt: '2026-01-01T00:00:02.000Z',
              workflowStage: 'spec',
              boardRank: 'z',
            },
            {
              id: 'awaiting',
              createdAt: '2026-01-01T00:00:03.000Z',
              workflowStage: 'spec',
              boardRank: 'm',
            },
            {
              id: 'ranked-a',
              createdAt: '2026-01-01T00:00:04.000Z',
              workflowStage: 'spec',
              boardRank: 'a',
            },
          ],
        },
      ])
    );
    registryMocks.statusByTaskId.set('awaiting', 'awaiting-input');

    store.ensureProjectExpanded('project-1');

    expect(shape(store.sidebarRows)).toEqual([
      'project:project-1',
      'board:project-1',
      'group:Spec:4',
      'task:awaiting',
      'task:ranked-a',
      'task:ranked-z',
      'task:unranked-1',
    ]);
  });

  it('shows the visible-task count on each group header', () => {
    const store = new SidebarStore(
      projectManagerWithTasks([
        {
          id: 'project-1',
          createdAt: '2026-01-01T00:00:00.000Z',
          tasks: [
            { id: 's1', createdAt: '2026-01-01T00:00:01.000Z', workflowStage: 'spec' },
            { id: 's2', createdAt: '2026-01-01T00:00:02.000Z', workflowStage: 'spec' },
          ],
        },
      ])
    );
    store.ensureProjectExpanded('project-1');

    expect(store.sidebarRows).toContainEqual({
      kind: 'stage-group',
      projectId: 'project-1',
      stage: 'spec',
      label: 'Spec',
      count: 2,
    });
  });

  it('keeps a collapsed group header and count while omitting its task rows', () => {
    const store = new SidebarStore(
      projectManagerWithTasks([
        {
          id: 'project-1',
          createdAt: '2026-01-01T00:00:00.000Z',
          tasks: [
            { id: 's1', createdAt: '2026-01-01T00:00:01.000Z', workflowStage: 'spec' },
            { id: 's2', createdAt: '2026-01-01T00:00:02.000Z', workflowStage: 'spec' },
            { id: 'i1', createdAt: '2026-01-01T00:00:03.000Z', workflowStage: 'idea' },
          ],
        },
      ])
    );
    store.ensureProjectExpanded('project-1');
    store.toggleStageGroupCollapsed('project-1', 'spec');

    expect(shape(store.sidebarRows)).toEqual([
      'project:project-1',
      'board:project-1',
      'group:Idea:1',
      'task:i1',
      'group:Spec:2',
    ]);
    expect(store.isStageGroupCollapsed('project-1', 'spec')).toBe(true);
  });

  it('expands a collapsed group again on toggle', () => {
    const store = new SidebarStore(
      projectManagerWithTasks([
        {
          id: 'project-1',
          createdAt: '2026-01-01T00:00:00.000Z',
          tasks: [{ id: 's1', createdAt: '2026-01-01T00:00:01.000Z', workflowStage: 'spec' }],
        },
      ])
    );
    store.ensureProjectExpanded('project-1');
    store.toggleStageGroupCollapsed('project-1', 'spec');
    store.toggleStageGroupCollapsed('project-1', 'spec');

    expect(store.isStageGroupCollapsed('project-1', 'spec')).toBe(false);
    expect(shape(store.sidebarRows)).toEqual([
      'project:project-1',
      'board:project-1',
      'group:Spec:1',
      'task:s1',
    ]);
  });

  it('persists collapsed groups in the snapshot and restores them', () => {
    const store = new SidebarStore(
      projectManagerWithTasks([
        {
          id: 'project-1',
          createdAt: '2026-01-01T00:00:00.000Z',
          tasks: [
            { id: 's1', createdAt: '2026-01-01T00:00:01.000Z', workflowStage: 'spec' },
            { id: 'i1', createdAt: '2026-01-01T00:00:02.000Z', workflowStage: 'idea' },
          ],
        },
      ])
    );
    store.ensureProjectExpanded('project-1');
    store.toggleStageGroupCollapsed('project-1', 'spec');

    const restored = new SidebarStore(
      projectManagerWithTasks([
        {
          id: 'project-1',
          createdAt: '2026-01-01T00:00:00.000Z',
          tasks: [
            { id: 's1', createdAt: '2026-01-01T00:00:01.000Z', workflowStage: 'spec' },
            { id: 'i1', createdAt: '2026-01-01T00:00:02.000Z', workflowStage: 'idea' },
          ],
        },
      ])
    );
    restored.restoreSnapshot(store.snapshot);

    expect(restored.collapsedStageGroupIdsByProject).toEqual({ 'project-1': ['spec'] });
    expect(restored.isStageGroupCollapsed('project-1', 'spec')).toBe(true);
    restored.ensureProjectExpanded('project-1');
    expect(shape(restored.sidebarRows)).toEqual([
      'project:project-1',
      'board:project-1',
      'group:Idea:1',
      'task:i1',
      'group:Spec:1',
    ]);
  });

  it('ignores unknown stage ids when restoring a snapshot', () => {
    const store = new SidebarStore(projectManager([]));
    store.restoreSnapshot({
      collapsedStageGroupIdsByProject: {
        'project-1': ['spec', 'not-a-stage' as WorkflowStage],
      },
    });
    expect(store.collapsedStageGroupIdsByProject).toEqual({ 'project-1': ['spec'] });
  });

  it('prunes stale collapsed ids so a newly non-empty group appears expanded', () => {
    const projectManager = projectManagerWithTasks([
      {
        id: 'project-1',
        createdAt: '2026-01-01T00:00:00.000Z',
        tasks: [{ id: 's1', createdAt: '2026-01-01T00:00:01.000Z', workflowStage: 'spec' }],
      },
    ]);
    const store = new SidebarStore(projectManager);
    store.ensureProjectExpanded('project-1');
    store.toggleStageGroupCollapsed('project-1', 'spec');
    expect(store.sidebarRows.some((row) => row.kind === 'stage-group')).toBe(true);

    // The group empties (task deleted elsewhere, e.g. on the board) — the
    // stale collapsed id must be pruned.
    const taskManager = projectManager.projects.get('project-1')!.mountedProject!.taskManager;
    taskManager.tasks.delete('s1');
    runInAction(() => {
      store.toggleProjectExpanded('project-1');
      store.toggleProjectExpanded('project-1');
    });
    expect(store.collapsedStageGroupIdsByProject['project-1']).toBeUndefined();

    // A new task in the same stage must appear expanded, not collapsed.
    taskManager.tasks.set(
      's2',
      task('s2', '2026-01-02T00:00:01.000Z', {
        workflowStage: 'spec',
      }) as unknown as TaskStore
    );
    runInAction(() => {
      store.toggleProjectExpanded('project-1');
      store.toggleProjectExpanded('project-1');
    });
    expect(store.isStageGroupCollapsed('project-1', 'spec')).toBe(false);
    expect(shape(store.sidebarRows)).toEqual([
      'project:project-1',
      'board:project-1',
      'group:Spec:1',
      'task:s2',
    ]);
  });

  it('leaves the pinned strip unchanged and keeps pinned tasks out of the rows', () => {
    const store = new SidebarStore(
      projectManagerWithTasks([
        {
          id: 'project-1',
          createdAt: '2026-01-01T00:00:00.000Z',
          tasks: [
            {
              id: 'pinned-1',
              createdAt: '2026-01-01T00:00:01.000Z',
              workflowStage: 'spec',
              isPinned: true,
            },
            { id: 'regular-1', createdAt: '2026-01-01T00:00:02.000Z', workflowStage: 'spec' },
          ],
        },
      ])
    );
    store.ensureProjectExpanded('project-1');

    expect(shape(store.sidebarRows)).toEqual([
      'project:project-1',
      'board:project-1',
      'group:Spec:1',
      'task:regular-1',
    ]);
    expect(store.pinnedSidebarEntries).toEqual([{ projectId: 'project-1', taskId: 'pinned-1' }]);
  });

  it('makes the manual task order inert in grouped mode without migrating it', () => {
    const store = new SidebarStore(
      projectManagerWithTasks([
        {
          id: 'project-1',
          createdAt: '2026-01-01T00:00:00.000Z',
          tasks: [
            {
              id: 'spec-1',
              createdAt: '2026-01-01T00:00:01.000Z',
              workflowStage: 'spec',
              boardRank: 'a',
            },
            {
              id: 'spec-2',
              createdAt: '2026-01-01T00:00:02.000Z',
              workflowStage: 'spec',
              boardRank: 'b',
            },
          ],
        },
      ])
    );
    store.ensureProjectExpanded('project-1');
    store.setTaskOrder('project-1', ['spec-2', 'spec-1']);

    expect(shape(store.sidebarRows)).toEqual([
      'project:project-1',
      'board:project-1',
      'group:Spec:2',
      'task:spec-1',
      'task:spec-2',
    ]);
  });

  it('omits the board row for a collapsed project', () => {
    const store = new SidebarStore(
      projectManagerWithTasks([
        {
          id: 'project-1',
          createdAt: '2026-01-01T00:00:00.000Z',
          tasks: [{ id: 'task-1a', createdAt: '2026-01-01T00:00:01.000Z' }],
        },
      ])
    );

    expect(store.sidebarRows).toEqual([{ kind: 'project', projectId: 'project-1' }]);
  });

  it('omits the board row for an expanded project that has not mounted yet', () => {
    const store = new SidebarStore(
      projectManager([{ id: 'project-1', createdAt: '2026-01-01T00:00:00.000Z' }])
    );
    store.ensureProjectExpanded('project-1');

    expect(store.sidebarRows).toEqual([{ kind: 'project', projectId: 'project-1' }]);
  });

  it('returns visible task entries in rendered project-tree order', () => {
    const store = new SidebarStore(
      projectManagerWithTasks([
        {
          id: 'project-1',
          createdAt: '2026-01-01T00:00:00.000Z',
          tasks: [
            { id: 'idea-1', createdAt: '2026-01-01T00:00:01.000Z', workflowStage: 'idea' },
            { id: 'unstaged-1', createdAt: '2026-01-01T00:00:02.000Z' },
          ],
        },
        {
          id: 'project-2',
          createdAt: '2026-01-02T00:00:00.000Z',
          tasks: [{ id: 'task-2a', createdAt: '2026-01-02T00:00:01.000Z' }],
        },
      ])
    );

    store.setProjectOrder(['project-1', 'project-2']);
    store.ensureProjectExpanded('project-1');
    store.ensureProjectExpanded('project-2');

    expect(store.visibleTaskEntries).toEqual([
      { projectId: 'project-1', taskId: 'unstaged-1' },
      { projectId: 'project-1', taskId: 'idea-1' },
      { projectId: 'project-2', taskId: 'task-2a' },
    ]);
  });

  it('returns visible task ids in row order, excluding tasks of collapsed groups', () => {
    const store = new SidebarStore(
      projectManagerWithTasks([
        {
          id: 'project-1',
          createdAt: '2026-01-01T00:00:00.000Z',
          tasks: [
            { id: 's1', createdAt: '2026-01-01T00:00:01.000Z', workflowStage: 'spec' },
            { id: 'i1', createdAt: '2026-01-01T00:00:02.000Z', workflowStage: 'idea' },
          ],
        },
      ])
    );
    store.ensureProjectExpanded('project-1');
    store.toggleStageGroupCollapsed('project-1', 'spec');

    expect(store.visibleTaskIdsForProject('project-1')).toEqual(['i1']);
  });
});

describe('SidebarStore hidden tasks (spec #85, ticket #87)', () => {
  it('hides a task from the sidebar only, group count and rows included', () => {
    const store = new SidebarStore(
      projectManagerWithTasks([
        {
          id: 'project-1',
          createdAt: '2026-01-01T00:00:00.000Z',
          tasks: [
            { id: 's1', createdAt: '2026-01-01T00:00:01.000Z', workflowStage: 'spec' },
            { id: 's2', createdAt: '2026-01-01T00:00:02.000Z', workflowStage: 'spec' },
            { id: 'u1', createdAt: '2026-01-01T00:00:03.000Z' },
          ],
        },
      ])
    );
    store.ensureProjectExpanded('project-1');
    store.hideTaskFromSidebar('project-1', 's1');

    expect(shape(store.sidebarRows)).toEqual([
      'project:project-1',
      'board:project-1',
      'task:u1',
      'group:Spec:1',
      'task:s2',
    ]);
    expect(store.isTaskHidden('project-1', 's1')).toBe(true);
    expect(store.isTaskHidden('project-1', 's2')).toBe(false);
  });

  it('hides a task from the Unstaged loose rows too', () => {
    const store = new SidebarStore(
      projectManagerWithTasks([
        {
          id: 'project-1',
          createdAt: '2026-01-01T00:00:00.000Z',
          tasks: [{ id: 'u1', createdAt: '2026-01-01T00:00:01.000Z' }],
        },
      ])
    );
    store.ensureProjectExpanded('project-1');
    store.hideTaskFromSidebar('project-1', 'u1');

    expect(store.sidebarRows).toEqual([
      { kind: 'project', projectId: 'project-1' },
      { kind: 'board', projectId: 'project-1' },
    ]);
  });

  it('drops the group header entirely when every task of a stage is hidden', () => {
    const store = new SidebarStore(
      projectManagerWithTasks([
        {
          id: 'project-1',
          createdAt: '2026-01-01T00:00:00.000Z',
          tasks: [{ id: 's1', createdAt: '2026-01-01T00:00:01.000Z', workflowStage: 'spec' }],
        },
      ])
    );
    store.ensureProjectExpanded('project-1');
    store.hideTaskFromSidebar('project-1', 's1');

    expect(store.sidebarRows).toEqual([
      { kind: 'project', projectId: 'project-1' },
      { kind: 'board', projectId: 'project-1' },
    ]);
  });

  it('showing a hidden task restores its row', () => {
    const store = new SidebarStore(
      projectManagerWithTasks([
        {
          id: 'project-1',
          createdAt: '2026-01-01T00:00:00.000Z',
          tasks: [{ id: 's1', createdAt: '2026-01-01T00:00:01.000Z', workflowStage: 'spec' }],
        },
      ])
    );
    store.ensureProjectExpanded('project-1');
    store.hideTaskFromSidebar('project-1', 's1');
    store.showTaskInSidebar('project-1', 's1');

    expect(store.isTaskHidden('project-1', 's1')).toBe(false);
    expect(shape(store.sidebarRows)).toEqual([
      'project:project-1',
      'board:project-1',
      'group:Spec:1',
      'task:s1',
    ]);
    // Showing a task that was never hidden is a no-op.
    expect(() => store.showTaskInSidebar('project-1', 's1')).not.toThrow();
  });

  it('persists the hidden set in the snapshot and restores it', () => {
    const fixtures = (): { id: string; createdAt: string; tasks: TaskFixture[] }[] => [
      {
        id: 'project-1',
        createdAt: '2026-01-01T00:00:00.000Z',
        tasks: [
          { id: 's1', createdAt: '2026-01-01T00:00:01.000Z', workflowStage: 'spec' },
          { id: 'i1', createdAt: '2026-01-01T00:00:02.000Z', workflowStage: 'idea' },
        ],
      },
    ];
    const store = new SidebarStore(projectManagerWithTasks(fixtures()));
    store.ensureProjectExpanded('project-1');
    store.hideTaskFromSidebar('project-1', 's1');

    const restored = new SidebarStore(projectManagerWithTasks(fixtures()));
    restored.restoreSnapshot(store.snapshot);
    restored.ensureProjectExpanded('project-1');

    expect(restored.hiddenTaskIdsByProject).toEqual({ 'project-1': ['s1'] });
    // s1 is the only Spec task, so its group drops its header entirely.
    expect(shape(restored.sidebarRows)).toEqual([
      'project:project-1',
      'board:project-1',
      'group:Idea:1',
      'task:i1',
    ]);
    expect(restored.isTaskHidden('project-1', 's1')).toBe(true);
  });

  it('drops non-string ids when restoring a snapshot', () => {
    const store = new SidebarStore(projectManager([]));
    store.restoreSnapshot({
      hiddenTaskIdsByProject: { 'project-1': ['s1', 42 as unknown as string] },
    });
    expect(store.hiddenTaskIdsByProject).toEqual({ 'project-1': ['s1'] });
  });

  it('excludes hidden tasks from per-project navigation order', () => {
    const store = new SidebarStore(
      projectManagerWithTasks([
        {
          id: 'project-1',
          createdAt: '2026-01-01T00:00:00.000Z',
          tasks: [
            { id: 's1', createdAt: '2026-01-01T00:00:01.000Z', workflowStage: 'spec' },
            { id: 'i1', createdAt: '2026-01-01T00:00:02.000Z', workflowStage: 'idea' },
            { id: 'u1', createdAt: '2026-01-01T00:00:03.000Z' },
          ],
        },
      ])
    );
    store.ensureProjectExpanded('project-1');
    store.hideTaskFromSidebar('project-1', 'i1');

    expect(store.visibleTaskIdsForProject('project-1')).toEqual(['u1', 's1']);
  });

  it('excludes hidden tasks from Next/Previous entries across projects', () => {
    const store = new SidebarStore(
      projectManagerWithTasks([
        {
          id: 'project-1',
          createdAt: '2026-01-01T00:00:00.000Z',
          tasks: [{ id: 't1', createdAt: '2026-01-01T00:00:01.000Z', workflowStage: 'spec' }],
        },
        {
          id: 'project-2',
          createdAt: '2026-01-02T00:00:00.000Z',
          tasks: [{ id: 't2', createdAt: '2026-01-02T00:00:01.000Z', workflowStage: 'idea' }],
        },
      ])
    );
    store.setProjectOrder(['project-1', 'project-2']);
    store.ensureProjectExpanded('project-1');
    store.ensureProjectExpanded('project-2');
    store.hideTaskFromSidebar('project-2', 't2');

    expect(store.visibleTaskEntries).toEqual([
      { projectId: 'project-1', taskId: 't1' },
    ]);
  });

  it('keeps the hidden set while the project is collapsed and restores rows on expand', () => {
    const store = new SidebarStore(
      projectManagerWithTasks([
        {
          id: 'project-1',
          createdAt: '2026-01-01T00:00:00.000Z',
          tasks: [{ id: 's1', createdAt: '2026-01-01T00:00:01.000Z', workflowStage: 'spec' }],
        },
      ])
    );
    store.ensureProjectExpanded('project-1');
    store.hideTaskFromSidebar('project-1', 's1');
    store.toggleProjectExpanded('project-1');

    expect(store.hiddenTaskIdsByProject).toEqual({ 'project-1': ['s1'] });
  });
});

describe('SidebarStore Shipped Fade (spec #85, ticket #87)', () => {
  it('excludes a faded shipped task from the Shipped group, keeping its stage and archive state', () => {
    const oldMergedAt = new Date(Date.now() - (SHIPPED_FADE_WINDOW_MS + 60_000)).toISOString();
    const manager = projectManagerWithTasks([
      {
        id: 'project-1',
        createdAt: '2026-01-01T00:00:00.000Z',
        tasks: [
          {
            id: 'faded',
            createdAt: '2026-01-01T00:00:01.000Z',
            workflowStage: 'shipped',
            prs: [{ status: 'merged', mergedAt: oldMergedAt }],
          },
          {
            id: 'fresh',
            createdAt: '2026-01-01T00:00:02.000Z',
            workflowStage: 'shipped',
            prs: [{ status: 'merged', mergedAt: new Date().toISOString() }],
          },
        ],
      },
    ]);
    const store = new SidebarStore(manager);
    store.ensureProjectExpanded('project-1');

    expect(shape(store.sidebarRows)).toEqual([
      'project:project-1',
      'board:project-1',
      'group:Shipped:1',
      'task:fresh',
    ]);
    // The faded task itself is untouched: still Shipped, still not archived,
    // so it stays reachable in the project view's task list.
    const fadedData = manager.projects
      .get('project-1')!
      .mountedProject!.taskManager.tasks.get('faded') as unknown as {
      data: { workflowStage?: WorkflowStage; archivedAt?: string };
    };
    expect(fadedData.data.workflowStage).toBe('shipped');
    expect(fadedData.data.archivedAt).toBeUndefined();
    expect(store.visibleTaskIdsForProject('project-1')).toEqual(['fresh']);
  });

  it('leaves a shipped task inside the fade window in the group', () => {
    const recentMergedAt = new Date(Date.now() - 60_000).toISOString();
    const store = new SidebarStore(
      projectManagerWithTasks([
        {
          id: 'project-1',
          createdAt: '2026-01-01T00:00:00.000Z',
          tasks: [
            {
              id: 'recent',
              createdAt: '2026-01-01T00:00:01.000Z',
              workflowStage: 'shipped',
              prs: [{ status: 'merged', mergedAt: recentMergedAt }],
            },
          ],
        },
      ])
    );
    store.ensureProjectExpanded('project-1');

    expect(shape(store.sidebarRows)).toEqual([
      'project:project-1',
      'board:project-1',
      'group:Shipped:1',
      'task:recent',
    ]);
  });

  it('counts only visible tasks when fade and hidden filtering overlap', () => {
    const oldMergedAt = new Date(Date.now() - (SHIPPED_FADE_WINDOW_MS + 60_000)).toISOString();
    const store = new SidebarStore(
      projectManagerWithTasks([
        {
          id: 'project-1',
          createdAt: '2026-01-01T00:00:00.000Z',
          tasks: [
            {
              id: 'faded',
              createdAt: '2026-01-01T00:00:01.000Z',
              workflowStage: 'shipped',
              prs: [{ status: 'merged', mergedAt: oldMergedAt }],
            },
            {
              id: 'hidden',
              createdAt: '2026-01-01T00:00:02.000Z',
              workflowStage: 'shipped',
              prs: [{ status: 'merged', mergedAt: new Date().toISOString() }],
            },
            {
              id: 'visible',
              createdAt: '2026-01-01T00:00:03.000Z',
              workflowStage: 'shipped',
              prs: [{ status: 'merged', mergedAt: new Date().toISOString() }],
            },
          ],
        },
      ])
    );
    store.ensureProjectExpanded('project-1');
    store.hideTaskFromSidebar('project-1', 'hidden');

    expect(shape(store.sidebarRows)).toEqual([
      'project:project-1',
      'board:project-1',
      'group:Shipped:1',
      'task:visible',
    ]);
  });
});
