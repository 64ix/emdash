import { eq } from 'drizzle-orm';
import { db } from '@main/db/client';
import { tasks, workspaces } from '@main/db/schema';
import { isLocalProviderUsageActivity } from './provider-usage-activity-locality';

export async function isLocalProviderUsageTask(taskId: string): Promise<boolean> {
  const [workspace] = await db
    .select({
      location: workspaces.location,
      type: workspaces.type,
      legacyProvider: tasks.workspaceProvider,
    })
    .from(tasks)
    .leftJoin(workspaces, eq(tasks.workspaceId, workspaces.id))
    .where(eq(tasks.id, taskId))
    .limit(1);
  return isLocalProviderUsageActivity(workspace);
}
