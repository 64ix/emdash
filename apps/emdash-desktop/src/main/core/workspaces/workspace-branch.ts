import type { WorkspaceConfig } from '@shared/core/workspaces/workspace-config';
import type { WorkspaceKind } from '@shared/core/workspaces/workspaces';
import { deriveBranchName } from '../tasks/resolve-workspace-intent';

type WorkspaceBranchRow = {
  kind?: WorkspaceKind | string | null;
  branchName?: string | null;
  config?: WorkspaceConfig | null;
};

export function getProvisionedWorkspaceBranch(workspace: WorkspaceBranchRow): string | null {
  if (workspace.kind === 'project-root' || workspace.kind === 'byoi') return null;
  if (workspace.kind === 'path') return null;

  if (workspace.config) return deriveBranchName(workspace.config.git);
  if (workspace.kind === 'worktree') return workspace.branchName ?? null;

  return workspace.branchName ?? null;
}

/**
 * The branch whose PRs count as a task's *own* PRs, or `null`. Only worktrees
 * own a branch: `project-root`/`path`/`byoi` workspaces share the repository's
 * checkout branch with every other root task, so matching PRs against it would
 * let an unrelated checked-out PR prove a task's stage or show as its PR chip
 * with no way to unlink it (auto-update task linked to the PRD-153 branch's
 * PR). `null`-kind rows are legacy worktrees and keep matching.
 */
export function getTaskPrBranch(workspace: WorkspaceBranchRow): string | null {
  if (workspace.kind != null && workspace.kind !== 'worktree') return null;
  return workspace.branchName ?? null;
}
