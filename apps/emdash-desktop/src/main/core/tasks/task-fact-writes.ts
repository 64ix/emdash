import { eq, sql } from 'drizzle-orm';
import { db } from '@main/db/client';
import { tasks } from '@main/db/schema';
import { events } from '@main/lib/events';
import type { LinkedIssue, LinkedIssueRole } from '@shared/core/linked-issue';
import {
  taskLinkedIssueRoleUpdatedChannel,
  taskWorkflowStageUpdatedChannel,
} from '@shared/core/tasks/taskEvents';
import type { Task, WorkflowStage } from '@shared/core/tasks/tasks';
import { updateLinkedIssueRole } from './operations/updateLinkedIssueRole';

/**
 * Writes a task's Workflow Stage and, on an actual change, emits
 * `taskWorkflowStageUpdatedChannel` so every window observes it — manual board
 * drags persist through `updateTaskBoardPosition` instead; this path is for
 * main-process fact writers (the inbound issues sync and `BoardSyncService`
 * deriving stages from GitHub facts). A no-op write (the task is already at
 * `stage`) makes neither a DB write nor an event, matching the "idempotent
 * pass" criterion.
 *
 * Kept separate from `TaskService` so main-process callers that only need to
 * write task facts don't pull in its much heavier dependency graph
 * (project/workspace/session managers).
 */
export async function writeTaskWorkflowStage(
  taskId: string,
  stage: WorkflowStage | null
): Promise<void> {
  const [row] = await db
    .select({ projectId: tasks.projectId, workflowStage: tasks.workflowStage })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1);
  if (!row) throw new Error(`Task not found: ${taskId}`);
  if (row.workflowStage === stage) return;

  await db
    .update(tasks)
    .set({ workflowStage: stage, updatedAt: sql`CURRENT_TIMESTAMP` })
    .where(eq(tasks.id, taskId));
  events.emit(taskWorkflowStageUpdatedChannel, { taskId, projectId: row.projectId, stage });
}

/**
 * Sets (or clears) a task's Map/Spec/Origin Linked Issue Role through the
 * same operation layer used everywhere else and, on an actual change, emits
 * `taskLinkedIssueRoleUpdatedChannel`. See `writeTaskWorkflowStage` above for
 * why this lives apart from `TaskService`. Returns the updated task, or
 * `undefined` when the task doesn't exist.
 */
export async function writeLinkedIssueRole(
  taskId: string,
  role: LinkedIssueRole,
  issue: LinkedIssue | null
): Promise<Task | undefined> {
  const task = await updateLinkedIssueRole(taskId, role, issue);
  if (!task) return undefined;
  events.emit(taskLinkedIssueRoleUpdatedChannel, {
    taskId: task.id,
    projectId: task.projectId,
    role,
    issue,
  });
  return task;
}
