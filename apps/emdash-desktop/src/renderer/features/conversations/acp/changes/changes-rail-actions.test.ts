import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EditedChangesFootprintEntry, ReadChangesFootprintEntry } from './acp-changes-footprint';
import {
  openChangesFootprintDiff,
  openChangesFootprintEntry,
  openChangesFootprintFile,
} from './changes-rail-actions';

const mocks = vi.hoisted(() => ({
  openFileInTaskEditor: vi.fn(),
  getTaskView: vi.fn(),
  getWorkspaceForTask: vi.fn(),
}));

vi.mock('@renderer/features/tasks/stores/open-file-in-file-editor', () => ({
  openFileInTaskEditor: mocks.openFileInTaskEditor,
}));

vi.mock('@renderer/features/tasks/stores/task-selectors', () => ({
  getTaskView: mocks.getTaskView,
  getWorkspaceForTask: mocks.getWorkspaceForTask,
}));

function editedEntry(overrides: Partial<EditedChangesFootprintEntry> = {}): EditedChangesFootprintEntry {
  return {
    kind: 'edited',
    path: 'src/a.ts',
    status: 'modified',
    additions: 1,
    deletions: 0,
    source: { turnId: 'turn-1', itemId: 'item-1' },
    ...overrides,
  };
}

function readEntry(overrides: Partial<ReadChangesFootprintEntry> = {}): ReadChangesFootprintEntry {
  return {
    kind: 'read',
    path: 'src/b.ts',
    source: { turnId: 'turn-1', itemId: 'item-2' },
    ...overrides,
  };
}

describe('openChangesFootprintFile', () => {
  beforeEach(() => vi.clearAllMocks());

  it('opens the given path through the existing file editor route', () => {
    openChangesFootprintFile('project-1', 'task-1', 'src/a.ts');
    expect(mocks.openFileInTaskEditor).toHaveBeenCalledWith('project-1', 'task-1', 'src/a.ts');
  });
});

describe('openChangesFootprintDiff', () => {
  beforeEach(() => vi.clearAllMocks());

  it('opens the disk-vs-HEAD diff pane with the entry status', () => {
    const open = vi.fn();
    mocks.getTaskView.mockReturnValue({ activePane: { open } });
    mocks.getWorkspaceForTask.mockReturnValue({ path: '/repo' });

    openChangesFootprintDiff('project-1', 'task-1', editedEntry({ status: 'deleted' }));

    expect(open).toHaveBeenCalledWith(
      'diff',
      {
        activeFile: {
          path: '/repo/src/a.ts',
          type: 'disk',
          group: 'disk',
          originalRef: { kind: 'commit', sha: 'HEAD' },
        },
        status: 'deleted',
      },
      { preview: true }
    );
  });

  it('does nothing when the task view is unavailable', () => {
    mocks.getTaskView.mockReturnValue(null);
    mocks.getWorkspaceForTask.mockReturnValue({ path: '/repo' });

    openChangesFootprintDiff('project-1', 'task-1', editedEntry());

    expect(mocks.openFileInTaskEditor).not.toHaveBeenCalled();
  });

  it('does nothing when the workspace is unavailable', () => {
    mocks.getTaskView.mockReturnValue({ activePane: { open: vi.fn() } });
    mocks.getWorkspaceForTask.mockReturnValue(null);

    openChangesFootprintDiff('project-1', 'task-1', editedEntry());

    expect(mocks.openFileInTaskEditor).not.toHaveBeenCalled();
  });
});

describe('openChangesFootprintEntry — default action when there is nothing to jump to', () => {
  beforeEach(() => vi.clearAllMocks());

  it('opens the diff pane for an edited entry', () => {
    const open = vi.fn();
    mocks.getTaskView.mockReturnValue({ activePane: { open } });
    mocks.getWorkspaceForTask.mockReturnValue({ path: '/repo' });

    openChangesFootprintEntry('project-1', 'task-1', editedEntry());

    expect(open).toHaveBeenCalled();
    expect(mocks.openFileInTaskEditor).not.toHaveBeenCalled();
  });

  it('opens the file editor for a read entry', () => {
    openChangesFootprintEntry('project-1', 'task-1', readEntry());

    expect(mocks.openFileInTaskEditor).toHaveBeenCalledWith('project-1', 'task-1', 'src/b.ts');
  });

  it('degrades gracefully for a Git-only entry with no transcript provenance (a rename)', () => {
    const open = vi.fn();
    mocks.getTaskView.mockReturnValue({ activePane: { open } });
    mocks.getWorkspaceForTask.mockReturnValue({ path: '/repo' });

    openChangesFootprintEntry(
      'project-1',
      'task-1',
      editedEntry({ path: 'src/renamed.ts', status: 'renamed', source: null })
    );

    expect(open).toHaveBeenCalledWith(
      'diff',
      expect.objectContaining({
        activeFile: expect.objectContaining({ path: '/repo/src/renamed.ts' }),
        status: 'renamed',
      }),
      { preview: true }
    );
  });
});
