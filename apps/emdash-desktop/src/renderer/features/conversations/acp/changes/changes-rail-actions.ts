import { openFileInTaskEditor } from '@renderer/features/tasks/stores/open-file-in-file-editor';
import { getTaskView, getWorkspaceForTask } from '@renderer/features/tasks/stores/task-selectors';
import { resolveWorkspacePath } from '@renderer/features/tasks/stores/workspace-path';
import { commitRef } from '@shared/core/git/utils';
import type { ChangesFootprintEntry } from './acp-changes-footprint';

/**
 * Opens the relevant surface for a Changes footprint entry: the existing
 * diff view for an edited entry (reusing the same disk-vs-HEAD diff route
 * the task's own Changes/diff panel uses), or the existing file editor for
 * a read entry. Never opens an independent viewer.
 */
export function openChangesFootprintEntry(
  projectId: string,
  taskId: string,
  entry: ChangesFootprintEntry
): void {
  if (entry.kind === 'read') {
    void openFileInTaskEditor(projectId, taskId, entry.path);
    return;
  }

  const taskView = getTaskView(projectId, taskId);
  const workspace = getWorkspaceForTask(projectId, taskId);
  if (!taskView || !workspace) return;

  taskView.activePane.open(
    'diff',
    {
      activeFile: {
        path: resolveWorkspacePath(workspace.path, entry.path),
        type: 'disk',
        group: 'disk',
        originalRef: commitRef('HEAD'),
      },
      status: entry.status,
    },
    { preview: true }
  );
}
