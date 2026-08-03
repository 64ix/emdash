import {
  asProvisioned,
  getTaskStore,
  getTaskView,
} from '@renderer/features/tasks/stores/task-selectors';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { focusTracker } from '@renderer/utils/focus-tracker';
import { commitRef } from '@shared/core/git/utils';
import { resolveWorkspacePath } from './workspace-path';
import { workspaceRegistry } from './workspace-registry';

function isAbsolutePath(filePath: string): boolean {
  const normalizedPath = filePath.replace(/\\/g, '/');
  return normalizedPath.startsWith('/') || /^[A-Za-z]:\//.test(normalizedPath);
}

function isPathInsideWorkspace(workspacePath: string, filePath: string): boolean {
  const root = workspacePath.replace(/\\/g, '/').replace(/\/+$/, '');
  const path = filePath.replace(/\\/g, '/');
  return path === root || path.startsWith(`${root}/`);
}

function resolveEditorFilePath(workspacePath: string, filePath: string): string | null {
  const resolvedPath = resolveWorkspacePath(workspacePath, filePath);
  if (isAbsolutePath(filePath) && !isPathInsideWorkspace(workspacePath, resolvedPath)) {
    return null;
  }
  return resolvedPath;
}

/** Shows the resolved target and a copy action instead of silently opening an empty tab. */
function reportMissingWorkspaceFile(filePath: string): void {
  toast({
    title: 'File not found in workspace',
    description: filePath,
    variant: 'destructive',
    action: {
      label: 'Copy',
      onClick: () => {
        void rpc.app.clipboardWriteText(filePath);
      },
    },
  });
}

export async function openFileInTaskEditor(
  projectId: string,
  taskId: string,
  filePath: string
): Promise<void> {
  const provisioned = asProvisioned(getTaskStore(projectId, taskId));
  if (!provisioned) return;
  const workspace = workspaceRegistry.get(projectId, provisioned.workspaceId);
  if (!workspace) return;
  const resolvedPath = resolveEditorFilePath(workspace.path, filePath);
  if (resolvedPath === null) {
    void openExternalFilePath(projectId, taskId, filePath);
    return;
  }

  // Agent output often points at paths that don't exist in the worktree
  // (subdirectory-relative, deleted, etc.) — precheck so we can toast a
  // useful error instead of opening an empty tab.
  const exists = await rpc.workspace.files.fileExists(
    projectId,
    provisioned.workspaceId,
    resolvedPath
  );
  if (!exists.success || !exists.data.exists) {
    reportMissingWorkspaceFile(resolvedPath);
    return;
  }

  focusTracker.transition({ mainPanel: 'editor' }, 'panel_switch');
  provisioned.viewModel?.activePane.open('file', { path: resolvedPath }, { preview: false });
}

/**
 * Opens a file in the pane immediately to the right of the currently focused
 * pane. If no right pane exists it is created by splitting. Intended for
 * diff-header clicks so the file appears beside the chat without replacing the
 * active editor tab.
 */
export async function openFileInAdjacentPane(
  projectId: string,
  taskId: string,
  filePath: string
): Promise<void> {
  const provisioned = asProvisioned(getTaskStore(projectId, taskId));
  if (!provisioned) return;
  const workspace = workspaceRegistry.get(projectId, provisioned.workspaceId);
  if (!workspace) return;

  const resolvedPath = resolveEditorFilePath(workspace.path, filePath);
  if (resolvedPath === null) {
    void openExternalFilePath(projectId, taskId, filePath);
    return;
  }

  const exists = await rpc.workspace.files.fileExists(
    projectId,
    provisioned.workspaceId,
    resolvedPath
  );
  if (!exists.success || !exists.data.exists) {
    reportMissingWorkspaceFile(resolvedPath);
    return;
  }

  focusTracker.transition({ mainPanel: 'editor' }, 'panel_switch');
  provisioned.viewModel?.paneLayout.open(
    'file',
    { path: resolvedPath },
    { preview: false, target: 'right' }
  );
}

/**
 * Opens the task's full-diff review surface (the working-tree-vs-HEAD "disk"
 * diff tab already used by the Changes panel's unstaged section) for
 * `filePath`, instead of the raw file. Intended for the ACP diff card's
 * "Open full diff" action — reviewing beyond the bounded in-transcript
 * preview should land on the same diff surface a user reaches by clicking
 * the file in the Changes panel, not a plain editor tab.
 */
export async function openDiffInReviewSurface(
  projectId: string,
  taskId: string,
  filePath: string
): Promise<void> {
  const provisioned = asProvisioned(getTaskStore(projectId, taskId));
  if (!provisioned) return;
  const workspace = workspaceRegistry.get(projectId, provisioned.workspaceId);
  if (!workspace) return;

  const resolvedPath = resolveEditorFilePath(workspace.path, filePath);
  if (resolvedPath === null) {
    void openExternalFilePath(projectId, taskId, filePath);
    return;
  }

  const exists = await rpc.workspace.files.fileExists(
    projectId,
    provisioned.workspaceId,
    resolvedPath
  );
  if (!exists.success || !exists.data.exists) {
    // Ticket #20's shared reporter: names the resolved target and offers Copy,
    // rather than a bare message the user cannot act on.
    reportMissingWorkspaceFile(resolvedPath);
    return;
  }

  focusTracker.transition({ mainPanel: 'editor' }, 'panel_switch');
  provisioned.viewModel?.activePane.open(
    'diff',
    {
      activeFile: {
        path: resolvedPath,
        type: 'disk',
        group: 'disk',
        originalRef: commitRef('HEAD'),
      },
    },
    { preview: false }
  );
}

export async function openExternalFilePath(
  projectId: string,
  taskId: string,
  filePath: string
): Promise<void> {
  if (filePath.toLowerCase().endsWith('.md')) {
    const provisioned = asProvisioned(getTaskStore(projectId, taskId));
    if (!provisioned) return;
    focusTracker.transition({ mainPanel: 'editor' }, 'panel_switch');
    getTaskView(projectId, taskId)?.activePane.open(
      'file',
      { path: filePath, external: true },
      { preview: false }
    );
    return;
  }
  const result = await rpc.app.openPath(filePath);
  if (!result.success) {
    toast({
      title: `Could not open ${filePath}`,
      description: result.error,
      variant: 'destructive',
    });
  }
}

export function makeFileLinkHandlers(
  projectId: string,
  taskId: string
): { onOpenFile: (filePath: string) => void; onOpenExternal: (filePath: string) => void } {
  return {
    onOpenFile: (filePath) => {
      void openFileInTaskEditor(projectId, taskId, filePath);
    },
    onOpenExternal: (filePath) => {
      void openExternalFilePath(projectId, taskId, filePath);
    },
  };
}
