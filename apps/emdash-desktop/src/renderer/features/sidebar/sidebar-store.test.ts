import { observable, runInAction } from 'mobx';
import { describe, expect, it, vi } from 'vitest';
import type { TaskStore } from '@renderer/features/tasks/stores/task-store';
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

describe('SidebarStore — a stage move re-groups the rows (spec #85, ticket #88)', () => {
  /**
   * The "Move to stage…" gesture writes through the task store's optimistic
   * `updateBoardPosition`; the sidebar rows are a projection of that same
   * observable task data, so applying the stage change here is exactly the
   * mutation the gesture applies. The write path itself (RPC call, Unstaged
   * clearing, rollback on failure) is covered by task-store.test.ts — this
   * seam only asserts the rows follow.
   */
  function taskManagerOf(
    projectManager: SidebarProjectManager,
    projectId: string
  ): {
    tasks: Map<string, { data: { workflowStage?: WorkflowStage } }>;
  } {
    return projectManager.projects.get(projectId)!.mountedProject!.taskManager as {
      tasks: Map<string, { data: { workflowStage?: WorkflowStage } }>;
    };
  }

  it('lands a menu-moved task in the target Stage Group', () => {
    const projectManager = projectManagerWithTasks([
      {
        id: 'project-1',
        createdAt: '2026-01-01T00:00:00.000Z',
        tasks: [
          { id: 'idea-1', createdAt: '2026-01-01T00:00:01.000Z', workflowStage: 'idea' },
          { id: 'spec-1', createdAt: '2026-01-01T00:00:02.000Z', workflowStage: 'spec' },
        ],
      },
    ]);
    const store = new SidebarStore(projectManager);
    store.ensureProjectExpanded('project-1');

    const tasks = taskManagerOf(projectManager, 'project-1').tasks;
    runInAction(() => {
      tasks.get('idea-1')!.data.workflowStage = 'spec';
    });

    expect(shape(store.sidebarRows)).toEqual([
      'project:project-1',
      'board:project-1',
      'group:Spec:2',
      'task:idea-1',
      'task:spec-1',
    ]);
  });

  it('lands a menu-moved task in the loose Unstaged rows when its stage is cleared', () => {
    const projectManager = projectManagerWithTasks([
      {
        id: 'project-1',
        createdAt: '2026-01-01T00:00:00.000Z',
        tasks: [
          { id: 'idea-1', createdAt: '2026-01-01T00:00:01.000Z', workflowStage: 'idea' },
          { id: 'spec-1', createdAt: '2026-01-01T00:00:02.000Z', workflowStage: 'spec' },
        ],
      },
    ]);
    const store = new SidebarStore(projectManager);
    store.ensureProjectExpanded('project-1');

    const tasks = taskManagerOf(projectManager, 'project-1').tasks;
    runInAction(() => {
      tasks.get('idea-1')!.data.workflowStage = undefined;
    });

    expect(shape(store.sidebarRows)).toEqual([
      'project:project-1',
      'board:project-1',
      'task:idea-1',
      'group:Spec:1',
      'task:spec-1',
    ]);
  });

  it('returns a task to its original group when a failed write rolls the stage back', () => {
    const projectManager = projectManagerWithTasks([
      {
        id: 'project-1',
        createdAt: '2026-01-01T00:00:00.000Z',
        tasks: [
          { id: 'idea-1', createdAt: '2026-01-01T00:00:01.000Z', workflowStage: 'idea' },
          { id: 'spec-1', createdAt: '2026-01-01T00:00:02.000Z', workflowStage: 'spec' },
        ],
      },
    ]);
    const store = new SidebarStore(projectManager);
    store.ensureProjectExpanded('project-1');

    const tasks = taskManagerOf(projectManager, 'project-1').tasks;
    // Optimistic apply, then the store's rollback restores the old stage —
    // the projection must follow both directions.
    runInAction(() => {
      tasks.get('idea-1')!.data.workflowStage = 'spec';
    });
    expect(shape(store.sidebarRows)).toContain('group:Spec:2');
    runInAction(() => {
      tasks.get('idea-1')!.data.workflowStage = 'idea';
    });
    expect(shape(store.sidebarRows)).toEqual([
      'project:project-1',
      'board:project-1',
      'group:Idea:1',
      'task:idea-1',
      'group:Spec:1',
      'task:spec-1',
    ]);
  });
});
