import { describe, expect, it, vi } from 'vitest';
import type { TaskStore } from '@renderer/features/tasks/stores/task-store';
import type { Task } from '@shared/core/tasks/tasks';

const mocks = vi.hoisted(() => ({
  taskAgentStatus: vi.fn(),
}));

vi.mock('@renderer/features/tasks/stores/task-selectors', () => ({
  taskAgentStatus: mocks.taskAgentStatus,
}));

vi.mock('@renderer/features/tasks/stores/task-store', () => ({
  registeredTaskData: (store: { data: Task | undefined }) => store.data,
}));

// `agentStatusNeedsAttention` itself is covered by `agent-attention.test.ts`
// next to its dependency-free leaf module (see that module's docstring for
// why `board-filters.ts` and this module share it instead of each declaring
// a copy). This file covers the one thing specific to this module:
// `isBoardDisplayable` gating. The sidebar's attention badge and the board's
// Needs Attention filter both apply `taskNeedsAttention` per task; neither
// needs a counting helper (the sidebar also filters Hidden Tasks).
import { taskNeedsAttention } from './board-attention';

type FakeStore = { data: Task | undefined };

/** The mocked `task-store`/`task-selectors` modules above only care about `.data` —
 * cast so tests can stay free of `TaskStore`'s full (irrelevant) shape. */
function asStore(store: FakeStore): TaskStore {
  return store as unknown as TaskStore;
}

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

describe('taskNeedsAttention', () => {
  it('is true for a displayable task with an attention-needing agent status', () => {
    mocks.taskAgentStatus.mockReturnValue('awaiting-input');
    const store: FakeStore = { data: makeTask() };
    expect(taskNeedsAttention(asStore(store))).toBe(true);
  });

  it('is false when the agent status does not need attention', () => {
    mocks.taskAgentStatus.mockReturnValue('working');
    const store: FakeStore = { data: makeTask() };
    expect(taskNeedsAttention(asStore(store))).toBe(false);
  });

  it('is false for an archived task even with an attention-needing status', () => {
    mocks.taskAgentStatus.mockReturnValue('error');
    const store: FakeStore = { data: makeTask({ archivedAt: '2026-01-02T00:00:00.000Z' }) };
    expect(taskNeedsAttention(asStore(store))).toBe(false);
  });

  it('is false for a task with no registered data', () => {
    mocks.taskAgentStatus.mockReturnValue('error');
    const store: FakeStore = { data: undefined };
    expect(taskNeedsAttention(asStore(store))).toBe(false);
  });
});
