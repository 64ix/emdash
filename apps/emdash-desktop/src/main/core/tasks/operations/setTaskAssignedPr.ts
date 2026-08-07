import { eq, sql } from 'drizzle-orm';
import { db } from '@main/db/client';
import { pullRequests, tasks } from '@main/db/schema';

/**
 * Sets (or clears) a task's Assigned PR (CONTEXT.md "Assigned PR",
 * docs/adr/0009): `prUrl` must be a PR synced for the task's project — the
 * same picker-scoped set the Task Detail Panel offers — and is validated
 * against `pull_requests` up front (the FK would reject a dangling url
 * anyway; this turns the constraint violation into a clear error). `null`
 * unassigns, reverting display to derivation. Renderer-initiated (ticket
 * #100): the caller applies the change optimistically, so no hook/event is
 * fired here — the same seam `setTaskPinned` uses.
 */
export async function setTaskAssignedPr(taskId: string, prUrl: string | null): Promise<void> {
  const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
  if (!row) throw new Error(`Task not found: ${taskId}`);

  if (prUrl !== null) {
    const [pr] = await db
      .select({ url: pullRequests.url })
      .from(pullRequests)
      .where(eq(pullRequests.url, prUrl))
      .limit(1);
    if (!pr) throw new Error(`Pull request not found: ${prUrl}`);
  }

  await db
    .update(tasks)
    .set({ assignedPrUrl: prUrl, updatedAt: sql`CURRENT_TIMESTAMP` })
    .where(eq(tasks.id, taskId));
}
