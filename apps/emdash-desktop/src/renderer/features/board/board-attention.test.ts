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

import {
  agentStatusNeedsAttention,
  countTasksNeedingAttention,
  taskNeedsAttention,
} from './board-attention';

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

describe('agentStatusNeedsAttention', () => {
  it('flags awaiting-input, error, and completed as needing attention', () => {
    expect(agentStatusNeedsAttention('awaiting-input')).toBe(true);
    expect(agentStatusNeedsAttention('error')).toBe(true);
    expect(agentStatusNeedsAttention('completed')).toBe(true);
  });

  it('does not flag working (still in progress) or idle', () => {
    expect(agentStatusNeedsAttention('working')).toBe(false);
    expect(agentStatusNeedsAttention('idle')).toBe(false);
  });

  it('does not flag no status at all', () => {
    expect(agentStatusNeedsAttention(null)).toBe(false);
  });
});

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

describe('countTasksNeedingAttention', () => {
  it('counts only the tasks needing attention, matching the per-task predicate', () => {
    mocks.taskAgentStatus.mockImplementation((store: FakeStore) =>
      store.data?.id === 't1' ? 'awaiting-input' : 'working'
    );
    const tasks = new Map<string, TaskStore>([
      ['t1', asStore({ data: makeTask({ id: 't1' }) })],
      ['t2', asStore({ data: makeTask({ id: 't2' }) })],
      ['t3', asStore({ data: makeTask({ id: 't3', archivedAt: '2026-01-02T00:00:00.000Z' }) })],
    ]);
    expect(countTasksNeedingAttention(tasks)).toBe(1);
  });

  it('is zero for an empty task map', () => {
    expect(countTasksNeedingAttention(new Map<string, TaskStore>())).toBe(0);
  });
});
