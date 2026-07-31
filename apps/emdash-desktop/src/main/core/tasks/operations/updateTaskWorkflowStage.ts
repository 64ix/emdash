import { eq, sql } from 'drizzle-orm';
import { db } from '@main/db/client';
import { tasks } from '@main/db/schema';
import { type WorkflowStage } from '@shared/core/tasks/tasks';

export async function updateTaskWorkflowStage(
  taskId: string,
  stage: WorkflowStage | null
): Promise<void> {
  const [row] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
  if (!row) throw new Error(`Task not found: ${taskId}`);
  if (row.workflowStage === stage) return;

  await db
    .update(tasks)
    .set({
      workflowStage: stage,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .where(eq(tasks.id, taskId));
}
