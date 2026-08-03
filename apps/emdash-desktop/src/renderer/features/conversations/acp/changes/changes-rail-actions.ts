import { openFileInTaskEditor } from '@renderer/features/tasks/stores/open-file-in-file-editor';
import { getTaskView, getWorkspaceForTask } from '@renderer/features/tasks/stores/task-selectors';
import { resolveWorkspacePath } from '@renderer/features/tasks/stores/workspace-path';
import { commitRef } from '@shared/core/git/utils';
import type { ChangesFootprintEntry, EditedChangesFootprintEntry } from './acp-changes-footprint';

/**
 * Opens `path` in the existing file editor (reusing its own missing-file
 * toast — see `openFileInTaskEditor`). The explicit "Open file" action for
 * every Changes entry (ticket #35), independent of whether the entry also
 * has transcript provenance to jump to.
 */
export function openChangesFootprintFile(projectId: string, taskId: string, path: string): void {
  void openFileInTaskEditor(projectId, taskId, path);
}

/**
 * Opens the existing disk-vs-HEAD diff view for an edited Changes entry (the
 * same route the task's own Changes/diff panel uses). The explicit
 * "Open diff" action (ticket #35) — only meaningful for edited entries, since
 * a read-only entry has nothing to diff.
 */
export function openChangesFootprintDiff(
  projectId: string,
  taskId: string,
  entry: EditedChangesFootprintEntry
): void {
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

/**
 * Default open action for a Changes footprint entry when there is no
 * transcript occurrence to jump to (see `changesProvenanceJumpTarget`): the
 * diff view for an edited entry, or the file editor for a read entry. Never
 * opens an independent viewer.
 */
export function openChangesFootprintEntry(
  projectId: string,
  taskId: string,
  entry: ChangesFootprintEntry
): void {
  if (entry.kind === 'read') {
    openChangesFootprintFile(projectId, taskId, entry.path);
    return;
  }
  openChangesFootprintDiff(projectId, taskId, entry);
}
