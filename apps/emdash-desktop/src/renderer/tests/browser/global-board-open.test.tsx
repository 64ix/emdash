/**
 * Browser-mode tests for the Global Board open sync (spec #104, ticket #108):
 * opening the `global-board` view through the REAL navigation store funnels
 * into the view's `canActivate`, which fires exactly ONE best-effort global
 * `tasks.getTasks()` — no projectId, no per-project fan-out — and merges the
 * result into every mounted project's task manager. Failures must never
 * block or error the view.
 *
 * The panel itself is stubbed (its behavior is covered by
 * `global-board.test.tsx`); everything under test here — navigation,
 * the guard, the refresh, the merge distribution — is real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '@shared/core/tasks/tasks';

// `globalBoardView` imports the panel purely for its component reference
// (`canActivate` never touches it) — stub it like `global-board-view.test.ts`.
vi.mock('@renderer/features/board/global-board-main-panel', () => ({
  GlobalBoardMainPanel: () => null,
}));

const mocks = vi.hoisted(() => ({
  getTasks: vi.fn(),
  projects: new Map<string, unknown>(),
  managers: new Map<string, { mergeGlobalTasks: ReturnType<typeof vi.fn> }>(),
  captureTelemetry: vi.fn(),
  navigation: undefined as unknown,
}));

vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    tasks: {
      getTasks: mocks.getTasks,
    },
  },
  events: {
    on: vi.fn(() => () => {}),
  },
}));

vi.mock('@renderer/features/tasks/stores/task-selectors', () => ({
  getTaskManagerStore: (projectId: string) => mocks.managers.get(projectId),
}));

vi.mock('@renderer/lib/stores/app-state', () => ({
  appState: {
    // Read lazily: the factory runs at module init, before each test assigns
    // the fresh NavigationStore instance.
    get navigation() {
      return mocks.navigation;
    },
    projects: { projects: mocks.projects },
    history: { push: vi.fn() },
  },
}));

vi.mock('@renderer/utils/telemetryClient', () => ({
  captureTelemetry: mocks.captureTelemetry,
}));

import { globalBoardView } from '@renderer/features/board/global-board-view';
import { NavigationStore } from '@renderer/lib/stores/navigation-store';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    projectId: 'project-1',
    name: 'Task 1',
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

let navigation: NavigationStore;

describe('Global Board open sync (spec #104, ticket #108)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.projects.clear();
    mocks.managers.clear();
    mocks.getTasks.mockResolvedValue([]);

    // The same registration `setupNavigationGuards()` performs at startup.
    navigation = new NavigationStore();
    navigation.registerView('global-board');
    navigation.registerGuard('global-board', globalBoardView.canActivate);
    mocks.navigation = navigation;
  });

  afterEach(() => {
    // The mocked appState outlives the test; drop the navigation reference.
    mocks.navigation = undefined;
  });

  it('opening the view fires exactly ONE global getTasks (no projectId) — no per-project fan-out', async () => {
    mocks.projects.set('p1', {});
    mocks.projects.set('p2', {});

    navigation.navigate('global-board');

    expect(navigation.currentViewId).toBe('global-board');
    await vi.waitFor(() => {
      expect(mocks.getTasks).toHaveBeenCalledTimes(1);
    });
    // Shape: the single call carries no projectId — the no-projectId global
    // path (wave 1). Any per-project fan-out would show up as extra calls or
    // calls with an argument.
    expect(mocks.getTasks.mock.calls).toEqual([[]]);
  });

  it('merges the single global result into every mounted project task manager', async () => {
    mocks.projects.set('p1', {});
    mocks.projects.set('p2', {});
    const manager1 = { mergeGlobalTasks: vi.fn() };
    const manager2 = { mergeGlobalTasks: vi.fn() };
    mocks.managers.set('p1', manager1);
    mocks.managers.set('p2', manager2);
    const tasks = [
      makeTask({ id: 't1', projectId: 'p1' }),
      makeTask({ id: 't2', projectId: 'p2' }),
    ];
    mocks.getTasks.mockResolvedValue(tasks);

    navigation.navigate('global-board');

    await vi.waitFor(() => {
      expect(manager1.mergeGlobalTasks).toHaveBeenCalledWith(tasks);
      expect(manager2.mergeGlobalTasks).toHaveBeenCalledWith(tasks);
    });
  });

  it('opens normally when the best-effort refresh fails — no block, no error', async () => {
    mocks.projects.set('p1', {});
    mocks.getTasks.mockRejectedValue(new Error('refresh failed'));

    navigation.navigate('global-board');

    // The guard grants unconditionally: the view opens before the refresh
    // settles.
    expect(navigation.currentViewId).toBe('global-board');
    await vi.waitFor(() => {
      expect(mocks.getTasks).toHaveBeenCalledTimes(1);
    });
    // The rejection is swallowed inside the refresh; reaching this point
    // (with no unhandled rejection failing the test) proves the view was
    // neither blocked nor errored.
  });
});
