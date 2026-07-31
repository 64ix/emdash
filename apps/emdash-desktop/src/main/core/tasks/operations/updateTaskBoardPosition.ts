import { eq, sql } from 'drizzle-orm';
import { db } from '@main/db/client';
import { tasks } from '@main/db/schema';
import { telemetryService } from '@main/lib/telemetry';
import { type WorkflowStage } from '@shared/core/tasks/tasks';

/**
 * Persists a Feature Board drop: the task's Workflow Stage and Board Rank
 * are written together in a single update — one drop, one atomic write, one
 * telemetry event. `stage: null` clears the Workflow Stage (an Unstaged
 * drop); `rank: null` clears the Board Rank (should not normally happen from
 * an explicit drop, but is accepted defensively).
 */
export async function updateTaskBoardPosition(
  taskId: string,
  stage: WorkflowStage | null,
  rank: string | null
): Promise<void> {
  const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
  if (!row) throw new Error(`Task not found: ${taskId}`);
  if (row.workflowStage === stage && row.boardRank === rank) return;

  await db
    .update(tasks)
    .set({
      workflowStage: stage,
      boardRank: rank,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(eq(tasks.id, taskId));

  telemetryService.capture('board_card_moved', {
    from_stage: (row.workflowStage as WorkflowStage | null) ?? null,
    to_stage: stage,
    reordered: row.workflowStage === stage && row.boardRank !== rank,
    project_id: row.projectId,
    task_id: row.id,
  });
}
