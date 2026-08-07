import { and, count, desc, eq, inArray } from 'drizzle-orm';
import { assemblePullRequest } from '@main/core/pull-requests/pr-utils';
import { db } from '@main/db/client';
import { conversations, pullRequests, tasks, workspaces } from '@main/db/schema';
import { type Task } from '@shared/core/tasks/tasks';
import { mapTaskRowToTask } from '../utils/utils';

export async function getTasks(projectId?: string): Promise<Task[]> {
  const rows = projectId
    ? await db
        .select()
        .from(tasks)
        .where(and(eq(tasks.projectId, projectId)))
        .orderBy(desc(tasks.updatedAt))
    : await db.select().from(tasks).orderBy(desc(tasks.updatedAt));

  if (rows.length === 0) return [];

  const taskIds = rows.map((r) => r.id);

  const convRows = await db
    .select({
      taskId: conversations.taskId,
      provider: conversations.provider,
      count: count(),
    })
    .from(conversations)
    .where(inArray(conversations.taskId, taskIds))
    .groupBy(conversations.taskId, conversations.provider);

  const convByTask = new Map<string, Record<string, number>>();
  for (const { taskId, provider, count: c } of convRows) {
    const rec = convByTask.get(taskId) ?? {};
    rec[provider ?? 'unknown'] = c;
    convByTask.set(taskId, rec);
  }

  const wsIds = rows.map((r) => r.workspaceId).filter((id): id is string => id != null);
  const wsRows = wsIds.length
    ? await db
        .select({
          id: workspaces.id,
          linesAdded: workspaces.linesAdded,
          linesDeleted: workspaces.linesDeleted,
        })
        .from(workspaces)
        .where(inArray(workspaces.id, wsIds))
    : [];
  const wsByWsId = new Map(wsRows.map((r) => [r.id, r]));

  // Resolve each task's Assigned PR (CONTEXT.md "Assigned PR", docs/adr/0009)
  // from the `assigned_pr_url` FK so the renderer needs no extra fetch. The
  // assembled PR carries no related collections (labels/assignees/checks) —
  // the assigned-PR consumers only display row-level fields (number, status,
  // title, url), and ticket #100's assignment surface can extend this if it
  // needs the decorated view.
  const assignedPrUrls = rows
    .map((r) => r.assignedPrUrl)
    .filter((url): url is string => url != null);
  const assignedPrRows = assignedPrUrls.length
    ? await db.select().from(pullRequests).where(inArray(pullRequests.url, assignedPrUrls))
    : [];
  const assignedPrByUrl = new Map(
    assignedPrRows.map((r) => [r.url, assemblePullRequest(r, null, [], [], [])])
  );

  return rows.map((row) => {
    const ws = row.workspaceId ? wsByWsId.get(row.workspaceId) : undefined;
    const assignedPr = row.assignedPrUrl ? assignedPrByUrl.get(row.assignedPrUrl) : undefined;
    return {
      ...mapTaskRowToTask(row, [], {}, assignedPr),
      prs: [],
      conversations: convByTask.get(row.id) ?? {},
      workspaceGit:
        ws?.linesAdded != null
          ? { linesAdded: ws.linesAdded, linesDeleted: ws.linesDeleted ?? 0 }
          : undefined,
    };
  });
}
