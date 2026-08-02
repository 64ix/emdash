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
 *
 * The read and the whole-column rewrite run in one synchronous transaction so
 * two concurrent role writers (e.g. the inbound issues sync auto-attaching a
 * role while the user links another from the titlebar) can't interleave and
 * silently drop each other's role. A write that would leave the role exactly
 * as it is reports `changed: false` and touches nothing.
 */
export async function updateLinkedIssueRole(
  taskId: string,
  role: LinkedIssueRole,
  issue: LinkedIssue | null
): Promise<{ task: Task; changed: boolean } | undefined> {
  const outcome = db.transaction((tx) => {
    const [existingRow] = tx.select().from(tasks).where(eq(tasks.id, taskId)).limit(1).all();
    if (!existingRow) return undefined;

    const currentIssue = existingRow.linkedIssues?.[role] ?? null;
    if (JSON.stringify(currentIssue) === JSON.stringify(issue)) {
      return { row: existingRow, changed: false };
    }

    const nextRoles = setLinkedIssueRole(existingRow.linkedIssues, role, issue);
    const [updatedRow] = tx
      .update(tasks)
      .set({
        linkedIssues: nextRoles ?? null,
      })
      .where(eq(tasks.id, taskId))
      .returning()
      .all();
    return updatedRow ? { row: updatedRow, changed: true } : undefined;
  });
  if (!outcome) return undefined;

  if (issue && outcome.changed) {
    telemetryService.capture('issue_linked_to_task', {
      provider: issue.provider,
      role,
      project_id: outcome.row.projectId,
      task_id: outcome.row.id,
    });
  }

  return { task: mapTaskRowToTask(outcome.row), changed: outcome.changed };
}
