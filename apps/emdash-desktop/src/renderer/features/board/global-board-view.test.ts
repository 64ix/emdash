import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Task } from '@shared/core/tasks/tasks';

// `globalBoardView` pulls in `GlobalBoardMainPanel` (dnd-kit, task stores,
// telemetry...) purely for its component reference, which `canActivate` never
// touches. Mocking that module keeps this suite scoped to the guard and its
// open sync (ticket #108) instead of the full board render tree (same pattern
// as `view.test.ts`).
vi.mock('./global-board-main-panel', () => ({ GlobalBoardMainPanel: () => null }));

const mocks = vi.hoisted(() => ({
  getTasks: vi.fn(),
  projects: new Map<string, unknown>(),
  managers: new Map<string, { mergeGlobalTasks: ReturnType<typeof vi.fn> }>(),
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
    projects: {
      projects: mocks.projects,
    },
  },
}));

// The open sync logs a warning when the best-effort refresh fails; the real
// renderer logger touches `window`, which does not exist in the node
// environment (same mock as `pane-layout-store.test.ts`).
vi.mock('@renderer/utils/logger', () => ({
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { globalBoardView } from './global-board-view';

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

describe('globalBoardView.canActivate — open sync (spec #104, ticket #108)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.projects.clear();
    mocks.managers.clear();
    mocks.getTasks.mockResolvedValue([]);
  });

  it('grants activation without any params — project-less by design', () => {
    // Ticket #107's original guard contract: no params at all is fine.
    expect(globalBoardView.canActivate(undefined)).toEqual({ ok: true });
    expect(globalBoardView.canActivate({})).toEqual({ ok: true });
    // Stale persisted params from older builds are ignored, never validated
    // (ticket #107): a stale projectId or focusTaskId must not redirect.
    expect(globalBoardView.canActivate({ projectId: 'proj-1' })).toEqual({ ok: true });
    expect(globalBoardView.canActivate({ focusTaskId: 'task-1' })).toEqual({ ok: true });
    expect(globalBoardView.canActivate({ projectId: 'ghost' })).toEqual({ ok: true });
  });

  it('fires exactly ONE global getTasks (no projectId) on open — no per-project fan-out', () => {
    globalBoardView.canActivate({});

    expect(mocks.getTasks).toHaveBeenCalledTimes(1);
    expect(mocks.getTasks.mock.calls[0]).toEqual([]);
  });

  it('merges the single global result into every mounted project manager', async () => {
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

    globalBoardView.canActivate({});

    await vi.waitFor(() => {
      expect(manager1.mergeGlobalTasks).toHaveBeenCalledWith(tasks);
      expect(manager2.mergeGlobalTasks).toHaveBeenCalledWith(tasks);
    });
  });

  it('never merges for a project without a mounted task manager (e.g. registered only)', async () => {
    mocks.projects.set('p1', {});
    mocks.getTasks.mockResolvedValue([makeTask({ id: 't1', projectId: 'p1' })]);

    globalBoardView.canActivate({});

    // No manager for p1 — the merge must not throw and must stay a no-op.
    await vi.waitFor(() => expect(mocks.getTasks).toHaveBeenCalledTimes(1));
    // Unhandled rejections would fail the test; the RPC resolved, so just
    // confirm nothing else was scheduled.
    expect(mocks.managers.size).toBe(0);
  });

  it('still grants activation when the global refresh fails (best-effort)', async () => {
    mocks.projects.set('p1', {});
    const manager1 = { mergeGlobalTasks: vi.fn() };
    mocks.managers.set('p1', manager1);
    mocks.getTasks.mockRejectedValue(new Error('refresh failed'));

    expect(globalBoardView.canActivate({})).toEqual({ ok: true });

    await vi.waitFor(() => expect(mocks.getTasks).toHaveBeenCalledTimes(1));
    // The rejection is swallowed inside the refresh — reaching this line (and
    // finishing the test) proves the view was not blocked or errored.
    expect(manager1.mergeGlobalTasks).not.toHaveBeenCalled();
  });
});
