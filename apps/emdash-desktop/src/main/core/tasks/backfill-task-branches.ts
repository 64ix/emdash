import { and, eq, isNull, sql } from 'drizzle-orm';
import type { AppDb } from '@main/db/client';
import { tasks, workspaces } from '@main/db/schema';
import { deriveBranchName } from './resolve-workspace-intent';

/**
 * Backfills `tasks.task_branch` from the machine-local workspace row.
 *
 * The branch identity lives in `workspaces.config`, which is never synced; the
 * task's own row is the only branch identity a synced task carries to another
 * machine (spec #130 story 25). Tasks created before `createTask` started
 * mirroring the branch onto the task row (and rows whose branch changed after
 * creation) still have `task_branch = NULL`, so provisioning them on the
 * receiving machine fails with `no-intent`.
 *
 * Runs at app startup. Idempotent: only touches rows with a NULL
 * `task_branch`, derives the branch from the parsed workspace config (falling
 * back to the workspace `branch_name` column for legacy rows), and bumps
 * `updated_at` so the sync engine pushes the repaired row.
 */
export function backfillTaskBranches(appDb: AppDb): void {
  const rows = appDb
    .select({
      taskId: tasks.id,
      config: workspaces.config,
      branchName: workspaces.branchName,
    })
    .from(tasks)
    .innerJoin(workspaces, eq(tasks.workspaceId, workspaces.id))
    .where(isNull(tasks.taskBranch))
    .all();

  for (const row of rows) {
    const branch = (row.config ? deriveBranchName(row.config.git) : null) ?? row.branchName ?? null;
    if (!branch) continue;

    appDb
      .update(tasks)
      .set({ taskBranch: branch, updatedAt: sql`CURRENT_TIMESTAMP` })
      .where(and(eq(tasks.id, row.taskId), isNull(tasks.taskBranch)))
      .run();
  }
}
