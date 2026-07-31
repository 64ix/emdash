import { eq } from 'drizzle-orm';
import { mapTaskRowToTask } from '@main/core/tasks/utils/utils';
import { db } from '@main/db/client';
import { tasks } from '@main/db/schema';
import { telemetryService } from '@main/lib/telemetry';
import {
  setLinkedIssueRole,
  type LinkedIssue,
  type LinkedIssueRole,
} from '@shared/core/linked-issue';
import type { Task } from '@shared/core/tasks/tasks';

/**
 * Sets (or clears, with `issue: null`) a single typed role — Origin, Map, or
 * Spec — on a task's linked issues. At most one issue per role; setting a
 * role replaces whatever issue previously occupied it.
 */
export async function updateLinkedIssueRole(
  taskId: string,
  role: LinkedIssueRole,
  issue: LinkedIssue | null
): Promise<Task | undefined> {
  const [existingRow] = await db
    .select({ id: tasks.id, projectId: tasks.projectId, linkedIssues: tasks.linkedIssues })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1);
  if (!existingRow) return undefined;

  const nextRoles = setLinkedIssueRole(existingRow.linkedIssues, role, issue);

  const [updatedRow] = await db
    .update(tasks)
    .set({
      linkedIssues: nextRoles ?? null,
    })
    .where(eq(tasks.id, taskId))
    .returning();

  if (issue) {
    telemetryService.capture('issue_linked_to_task', {
      provider: issue.provider,
      role,
      project_id: existingRow.projectId,
      task_id: existingRow.id,
    });
  }

  return updatedRow ? mapTaskRowToTask(updatedRow) : undefined;
}
