import { beforeEach, describe, expect, it, vi } from 'vitest';
import { openFileInTaskEditor } from './open-file-in-file-editor';

const mocks = vi.hoisted(() => ({
  asProvisioned: vi.fn(),
  getTaskStore: vi.fn(),
  getTaskView: vi.fn(),
  workspaceGet: vi.fn(),
  toast: vi.fn(),
  fileExists: vi.fn(),
  clipboardWriteText: vi.fn(),
  focusTransition: vi.fn(),
}));

vi.mock('@renderer/features/tasks/stores/task-selectors', () => ({
  asProvisioned: mocks.asProvisioned,
  getTaskStore: mocks.getTaskStore,
  getTaskView: mocks.getTaskView,
}));

vi.mock('./workspace-registry', () => ({
  workspaceRegistry: { get: mocks.workspaceGet },
}));

vi.mock('@renderer/lib/hooks/use-toast', () => ({
  toast: mocks.toast,
}));

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
