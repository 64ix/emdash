import { beforeEach, describe, expect, it, vi } from 'vitest';
import { rpc } from '@renderer/lib/ipc';
import type { Task } from '@shared/core/tasks/tasks';
import { createUnprovisionedTask, registeredTaskData } from './task-store';

type MockViewModel = {
  initialize: ReturnType<typeof vi.fn>;
  suspend: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  restoreSnapshot: ReturnType<typeof vi.fn>;
};

type MockDraftComments = {
  dispose: ReturnType<typeof vi.fn>;
};

const mocks = vi.hoisted(() => ({
  draftComments: [] as MockDraftComments[],
  viewModels: [] as MockViewModel[],
  workspaceAcquire: vi.fn(),
  workspaceRelease: vi.fn(),
}));

vi.mock('@renderer/features/tasks/diff-view/stores/draft-comments-store', () => ({
  DraftCommentsStore: class {
    dispose = vi.fn();

    constructor() {
      mocks.draftComments.push(this);
    }
  },
}));

vi.mock('./workspace-view-model', () => ({
  WorkspaceViewModel: class {
    initialize = vi.fn();
    suspend = vi.fn();
    dispose = vi.fn();
    restoreSnapshot = vi.fn();

    constructor() {
      mocks.viewModels.push(this);
    }
  },
}));

vi.mock('./workspace-registry', () => ({
  workspaceRegistry: {
    acquire: mocks.workspaceAcquire,
    release: mocks.workspaceRelease,
  },
}));

vi.mock('@renderer/features/conversations/stores/conversation-registry', () => ({
  conversationRegistry: {
    get: vi.fn(),
  },
}));

vi.mock('@renderer/utils/logger', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('@renderer/lib/ipc', () => ({
  events: {
    on: vi.fn(() => () => {}),
  },
  rpc: {
    tasks: {
      renameTask: vi.fn(),
      updateTaskStatus: vi.fn(),
      updateTaskBoardPosition: vi.fn(),
      setTaskPinned: vi.fn(),
      updateLinkedIssueRole: vi.fn(),
      convertAutomationTask: vi.fn(),
    },
  },
}));

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
    workspaceId: 'workspace-1',
    type: 'task',
    ...overrides,
  };
}

describe('TaskStore frontend runtime lifecycle', () => {
  beforeEach(() => {
    mocks.draftComments.length = 0;
    mocks.viewModels.length = 0;
    mocks.workspaceAcquire.mockReset();
    mocks.workspaceRelease.mockReset();
  });

  it('can transition a provisioned task back to a dry unprovisioned state', () => {
    const task = makeTask();
    const store = createUnprovisionedTask(task);

    store.transitionToProvisioned(task, '/tmp/workspace-1', 'workspace-1', {} as never);
    const viewModel = mocks.viewModels[0];
    const draftComments = mocks.draftComments[0];

    store.transitionToDryUnprovisioned({ ...task, archivedAt: '2026-01-02T00:00:00.000Z' });

    expect(viewModel.dispose).toHaveBeenCalledOnce();
    expect(draftComments.dispose).toHaveBeenCalledOnce();
    expect(mocks.workspaceRelease).toHaveBeenCalledWith('project-1', 'workspace-1');
    expect(store.state).toBe('unprovisioned');
    expect(store.phase).toBe('idle');
    expect(store.workspaceId).toBeNull();
    expect(store.viewModel).toBeNull();
    expect(store.draftComments).toBeNull();
    expect((store.data as Task).archivedAt).toBe('2026-01-02T00:00:00.000Z');
  });

  it('registers the workspace before restoring the snapshot, and restores before initialize', () => {
    const task = makeTask();
    const store = createUnprovisionedTask(task);
    const savedSnapshot = { sidebarTab: 'conversations' } as never;

    const order: string[] = [];
    mocks.workspaceAcquire.mockImplementation(() => order.push('acquire'));
    const viewModel = mocks.viewModels[0];
    viewModel.restoreSnapshot.mockImplementation(() => order.push('restore'));
    viewModel.initialize.mockImplementation(() => order.push('initialize'));

    store.transitionToProvisioned(
      task,
      '/tmp/workspace-1',
      'workspace-1',
      {} as never,
      undefined,
      savedSnapshot
    );

    expect(viewModel.restoreSnapshot).toHaveBeenCalledWith(savedSnapshot);
    expect(order).toEqual(['acquire', 'restore', 'initialize']);
  });

  it('recreates registered stores before reprovisioning a dry task', () => {
    const task = makeTask();
    const store = createUnprovisionedTask(task);
    const firstViewModel = mocks.viewModels[0];

    store.transitionToDryUnprovisioned(task);
    expect(store.viewModel).toBeNull();

    store.transitionToProvisioned(task, '/tmp/workspace-1', 'workspace-1', {} as never);

    expect(mocks.viewModels).toHaveLength(2);
    expect(store.viewModel).toBe(mocks.viewModels[1]);
    expect(store.viewModel).not.toBe(firstViewModel);
    expect(mocks.viewModels[1].initialize).toHaveBeenCalledOnce();
    expect(store.draftComments).toBe(mocks.draftComments[1]);
    expect(store.state).toBe('provisioned');
  });
});

describe('TaskStore.updateBoardPosition', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('optimistically applies the new stage and rank before the RPC resolves', async () => {
    const task = makeTask({ workflowStage: 'idea', boardRank: undefined });
    const store = createUnprovisionedTask(task);
    let resolveRpc: () => void = () => {};
    vi.mocked(rpc.tasks.updateTaskBoardPosition).mockReturnValue(
      new Promise((resolve) => {
        resolveRpc = () => resolve(undefined);
      })
    );

    const pending = store.updateBoardPosition('spec', 'm');

    expect(registeredTaskData(store)?.workflowStage).toBe('spec');
    expect(registeredTaskData(store)?.boardRank).toBe('m');

    resolveRpc();
    await pending;

    expect(rpc.tasks.updateTaskBoardPosition).toHaveBeenCalledWith('task-1', 'spec', 'm');
  });

  it('clears the workflow stage on the store when dropping into Unstaged', async () => {
    const task = makeTask({ workflowStage: 'spec' });
    const store = createUnprovisionedTask(task);
    vi.mocked(rpc.tasks.updateTaskBoardPosition).mockResolvedValue(undefined);

    await store.updateBoardPosition(null, 'm');

    expect(registeredTaskData(store)?.workflowStage).toBeUndefined();
    expect(registeredTaskData(store)?.boardRank).toBe('m');
  });

  it('rolls back stage and rank when the RPC call fails', async () => {
    const task = makeTask({ workflowStage: 'idea', boardRank: 'a' });
    const store = createUnprovisionedTask(task);
    vi.mocked(rpc.tasks.updateTaskBoardPosition).mockRejectedValue(new Error('offline'));

    await expect(store.updateBoardPosition('spec', 'm')).rejects.toThrow('offline');

    expect(registeredTaskData(store)?.workflowStage).toBe('idea');
    expect(registeredTaskData(store)?.boardRank).toBe('a');
  });
});
