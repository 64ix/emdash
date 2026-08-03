import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openDiffInReviewSurface, openFileInTaskEditor } from './open-file-in-file-editor';

/**
 * `asProvisioned` defaults to the real narrowing (task-store.ts#isProvisioned:
 * `state === 'provisioned'`) so tests can drive it purely through
 * `getTaskStore`. It stays a `vi.fn` so a test that would rather hand back a
 * provisioned store directly can override it — see `narrowByState()` for
 * restoring the default afterwards.
 *
 * task-selectors is stubbed rather than imported so this test doesn't pull in
 * its real transitive chain (project-manager/app-state/telemetryClient), which
 * has DOM/singleton side effects unrelated to this unit.
 */
const mocks = vi.hoisted(() => {
  const narrow = (store: { state?: string } | undefined) =>
    store && store.state === 'provisioned' ? store : undefined;
  return {
    narrow,
    asProvisioned: vi.fn(narrow),
    getTaskStore: vi.fn(),
    getTaskView: vi.fn(),
    workspaceGet: vi.fn(),
    toast: vi.fn(),
    fileExists: vi.fn(),
    clipboardWriteText: vi.fn(),
    focusTransition: vi.fn(),
  };
});

function narrowByState() {
  mocks.asProvisioned.mockImplementation(mocks.narrow);
}

vi.mock('@renderer/features/tasks/stores/task-selectors', () => ({
  asProvisioned: mocks.asProvisioned,
  getTaskStore: mocks.getTaskStore,
  getTaskView: mocks.getTaskView,
}));

vi.mock('@renderer/features/tasks/stores/workspace-registry', () => ({
  workspaceRegistry: { get: mocks.workspaceGet },
}));

vi.mock('@renderer/lib/hooks/use-toast', () => ({
  toast: mocks.toast,
}));

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }));

vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    workspace: { files: { fileExists: mocks.fileExists } },
    app: { clipboardWriteText: mocks.clipboardWriteText, openPath: vi.fn() },
  },
}));

vi.mock('@renderer/utils/focus-tracker', () => ({
  focusTracker: { transition: mocks.focusTransition },
}));

function makeProvisioned() {
  return {
    state: 'provisioned',
    workspaceId: 'ws1',
    viewModel: {
      activePane: { open: vi.fn() },
      paneLayout: { open: vi.fn() },
    },
  };
}

describe('openFileInTaskEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    narrowByState();
    mocks.workspaceGet.mockReturnValue({ path: '/Users/dev/workspace' });
    mocks.clipboardWriteText.mockResolvedValue({ success: true });
  });

  it('opens the file in the editor when it exists', async () => {
    const provisioned = makeProvisioned();
    mocks.asProvisioned.mockReturnValue(provisioned);
    mocks.fileExists.mockResolvedValue({ success: true, data: { exists: true } });

    await openFileInTaskEditor('p1', 't1', 'src/foo.ts');

    expect(provisioned.viewModel.activePane.open).toHaveBeenCalledWith(
      'file',
      { path: '/Users/dev/workspace/src/foo.ts' },
      { preview: false }
    );
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it('reports the resolved path with a copy action instead of opening an empty tab when the file is missing', async () => {
    const provisioned = makeProvisioned();
    mocks.asProvisioned.mockReturnValue(provisioned);
    mocks.fileExists.mockResolvedValue({ success: true, data: { exists: false } });

    await openFileInTaskEditor('p1', 't1', 'src/missing.ts');

    expect(provisioned.viewModel.activePane.open).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledTimes(1);

    const toastArg = mocks.toast.mock.calls[0][0];
    expect(toastArg.title).toBe('File not found in workspace');
    expect(toastArg.description).toBe('/Users/dev/workspace/src/missing.ts');
    expect(toastArg.variant).toBe('destructive');
    expect(toastArg.action.label).toBe('Copy');

    toastArg.action.onClick();
    expect(mocks.clipboardWriteText).toHaveBeenCalledWith('/Users/dev/workspace/src/missing.ts');
  });

  it('reports the resolved path when the fileExists RPC call itself fails', async () => {
    const provisioned = makeProvisioned();
    mocks.asProvisioned.mockReturnValue(provisioned);
    mocks.fileExists.mockResolvedValue({ success: false, error: 'boom' });

    await openFileInTaskEditor('p1', 't1', 'src/missing.ts');

    expect(provisioned.viewModel.activePane.open).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledTimes(1);
    expect(mocks.toast.mock.calls[0][0].description).toBe('/Users/dev/workspace/src/missing.ts');
  });
});

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
    narrowByState();
    mocks.workspaceGet.mockReturnValue({ path: '/repo' });
    mocks.fileExists.mockResolvedValue({ success: true, data: { exists: true } });
  });

  it('opens the task diff pane (disk vs HEAD) with the resolved path', async () => {
    const open = vi.fn();
    mocks.getTaskStore.mockReturnValue(provisionedStore(open));

    await openDiffInReviewSurface('project-1', 'task-1', 'src/format-user.ts');

    expect(mocks.focusTransition).toHaveBeenCalledWith({ mainPanel: 'editor' }, 'panel_switch');
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
    expect(mocks.focusTransition).not.toHaveBeenCalled();
  });

  it('does not open the diff pane when the file no longer exists in the workspace', async () => {
    const open = vi.fn();
    mocks.getTaskStore.mockReturnValue(provisionedStore(open));
    mocks.fileExists.mockResolvedValue({ success: true, data: { exists: false } });

    await openDiffInReviewSurface('project-1', 'task-1', 'src/deleted.ts');

    expect(open).not.toHaveBeenCalled();
  });
});
