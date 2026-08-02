import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getTaskStore: vi.fn(),
  workspaceRegistryGet: vi.fn(),
  fileExists: vi.fn(),
  transition: vi.fn(),
}));

// Mirrors the real asProvisioned() narrowing (task-store.ts#isProvisioned):
// `state === 'provisioned'`. Stubbed locally so this test doesn't pull in
// task-selectors's real transitive import chain (project-manager/app-state/
// telemetryClient), which has DOM/singleton side effects unrelated to this unit.
vi.mock('@renderer/features/tasks/stores/task-selectors', () => ({
  getTaskStore: mocks.getTaskStore,
  asProvisioned: (store: { state: string } | undefined) =>
    store && store.state === 'provisioned' ? store : undefined,
  getTaskView: vi.fn(),
}));

vi.mock('@renderer/features/tasks/stores/workspace-registry', () => ({
  workspaceRegistry: { get: mocks.workspaceRegistryGet },
}));

vi.mock('@renderer/utils/focus-tracker', () => ({
  focusTracker: { transition: mocks.transition },
}));

vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    workspace: { files: { fileExists: mocks.fileExists } },
    app: { openPath: vi.fn() },
  },
}));

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

import { openDiffInReviewSurface } from './open-file-in-file-editor';

function provisionedStore(open: (kind: string, args: unknown, config?: unknown) => void) {
  return {
    state: 'provisioned',
    workspaceId: 'ws-1',
    viewModel: { activePane: { open } },
  };
}

describe('openDiffInReviewSurface', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.workspaceRegistryGet.mockReturnValue({ path: '/repo' });
    mocks.fileExists.mockResolvedValue({ success: true, data: { exists: true } });
  });

  it('opens the task diff pane (disk vs HEAD) with the resolved path', async () => {
    const open = vi.fn();
    mocks.getTaskStore.mockReturnValue(provisionedStore(open));

    await openDiffInReviewSurface('project-1', 'task-1', 'src/format-user.ts');

    expect(mocks.transition).toHaveBeenCalledWith({ mainPanel: 'editor' }, 'panel_switch');
    expect(open).toHaveBeenCalledWith(
      'diff',
      {
        activeFile: {
          path: '/repo/src/format-user.ts',
          type: 'disk',
          group: 'disk',
          originalRef: { kind: 'commit', sha: 'HEAD' },
        },
      },
      { preview: false }
    );
  });

  it('does nothing when the task is not provisioned', async () => {
    mocks.getTaskStore.mockReturnValue({ state: 'unregistered' });

    await openDiffInReviewSurface('project-1', 'task-1', 'src/format-user.ts');

    expect(mocks.fileExists).not.toHaveBeenCalled();
    expect(mocks.transition).not.toHaveBeenCalled();
  });

  it('does not open the diff pane when the file no longer exists in the workspace', async () => {
    const open = vi.fn();
    mocks.getTaskStore.mockReturnValue(provisionedStore(open));
    mocks.fileExists.mockResolvedValue({ success: true, data: { exists: false } });

    await openDiffInReviewSurface('project-1', 'task-1', 'src/deleted.ts');

    expect(open).not.toHaveBeenCalled();
  });
});
