import type { TaskRow } from '@main/db/schema';
import type { PullRequest } from '@shared/core/pull-requests/pull-requests';
import { workflowStages, type Task, type TaskLifecycleStatus } from '@shared/core/tasks/tasks';

export function mapTaskRowToTask(
  row: TaskRow,
  prs: PullRequest[] = [],
  conversations: Record<string, number> = {},
  /**
   * The task's Assigned PR, resolved by the caller from `row.assignedPrUrl`
   * (CONTEXT.md "Assigned PR"). `getTasks` resolves it via the FK to
   * `pull_requests.url`; other construction sites leave it undefined — no
   * assignment UI exists yet, so no caller writes the column today.
   */
  assignedPr?: PullRequest
): Task {
  const stage = workflowStages.safeParse(row.workflowStage);
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    status: row.status as TaskLifecycleStatus,
    workflowStage: stage.success ? stage.data : undefined,
    boardRank: row.boardRank ?? undefined,
    linkedIssues: row.linkedIssues ?? undefined,
    archivedAt: row.archivedAt ?? undefined,
    lastInteractedAt: row.lastInteractedAt ?? undefined,
    createdAt: row.createdAt,
    prs,
    assignedPr,
    conversations,
    updatedAt: row.updatedAt,
    statusChangedAt: row.statusChangedAt,
    isPinned: row.isPinned === 1,
    workspaceId: row.workspaceId ?? undefined,
    type: (row.type as 'task' | 'automation-run') ?? 'task',
    automationRunId: row.automationRunId ?? undefined,
  };
}
