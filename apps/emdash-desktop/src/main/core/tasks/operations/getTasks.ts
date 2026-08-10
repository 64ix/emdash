import { and, count, desc, eq, inArray } from 'drizzle-orm';
import { assemblePullRequest, pullRequestRepositoryScope } from '@main/core/pull-requests/pr-utils';
import { getTaskPrBranch } from '@main/core/workspaces/workspace-branch';
import { db } from '@main/db/client';
import { conversations, projectRemotes, pullRequests, tasks, workspaces } from '@main/db/schema';
import type { PullRequest } from '@shared/core/pull-requests/pull-requests';
import { type Task } from '@shared/core/tasks/tasks';
import { mapTaskRowToTask } from '../utils/utils';

/** The subset of `workspaces` rows `getTasks` loads (workspaceGit + PR branch). */
type WorkspaceSummaryRow = {
  id: string;
  linesAdded: number | null;
  linesDeleted: number | null;
  kind: string | null;
  branchName: string | null;
};

/**
 * Global Board seam (spec #104, ticket #105): batch-loads the branch-matched
 * PRs for the no-projectId `getTasks()` path — every task of every project —
 * with ONE `pull_requests` query (plus one `project_remotes` query), instead
 * of the N per-task `getPullRequestsForTask` round-trips the Feature Board
 * renderer still uses.
 *
 * Semantics mirror `PrQueryService.getTaskPullRequests` exactly: a task's PRs
 * are the PRs whose head ref matches the task workspace's branch name and
 * whose repository (base or head) belongs to the task's project remotes. The
 * batched query scopes by every returned branch and every returned project's
 * remotes at once; the per-task scoping is then applied in JS over that
 * single row set, so a branch name shared across projects can never leak a PR
 * from one project's repo onto another project's task.
 *
 * Only the no-projectId path uses this: the projectId path keeps its existing
 * contract (`prs: []` — the Feature Board's renderer fills them per task), so
 * the Feature Board's behavior is untouched.
 */
async function batchLoadTaskPrs(
  taskRows: (typeof tasks.$inferSelect)[],
  wsByWsId: Map<string, WorkspaceSummaryRow>
): Promise<Map<string, PullRequest[]>> {
  const projectIds = [...new Set(taskRows.map((r) => r.projectId))];
  const remoteRows = await db
    .select({ projectId: projectRemotes.projectId, remoteUrl: projectRemotes.remoteUrl })
    .from(projectRemotes)
    .where(inArray(projectRemotes.projectId, projectIds));

  const remotesByProject = new Map<string, string[]>();
  for (const { projectId, remoteUrl } of remoteRows) {
    const list = remotesByProject.get(projectId) ?? [];
    list.push(remoteUrl);
    remotesByProject.set(projectId, list);
  }
  const allRemoteUrls = [...new Set(remoteRows.map((r) => r.remoteUrl))];

  const projectIdByTask = new Map(taskRows.map((r) => [r.id, r.projectId] as const));
  const branchByTask = new Map<string, string>();
  for (const row of taskRows) {
    const workspace = row.workspaceId ? wsByWsId.get(row.workspaceId) : undefined;
    const branch = workspace ? getTaskPrBranch(workspace) : null;
    if (branch) branchByTask.set(row.id, branch);
  }
  const branchNames = [...new Set(branchByTask.values())];

  // One batched query, not N per task: every returned branch at once, scoped
  // to the repositories of the returned tasks' projects.
  const prRows =
    branchNames.length > 0 && allRemoteUrls.length > 0
      ? await db
          .select()
          .from(pullRequests)
          .where(
            and(
              inArray(pullRequests.headRefName, branchNames),
              pullRequestRepositoryScope(allRemoteUrls)
            )
          )
      : [];

  const prsByTask = new Map<string, PullRequest[]>();
  for (const [taskId, branch] of branchByTask) {
    const projectId = projectIdByTask.get(taskId);
    const projectRemoteUrls = projectId ? (remotesByProject.get(projectId) ?? []) : [];
    const prs = prRows
      .filter(
        (pr) =>
          pr.headRefName === branch &&
          (projectRemoteUrls.includes(pr.repositoryUrl) ||
            projectRemoteUrls.includes(pr.headRepositoryUrl))
      )
      .map((pr) => assemblePullRequest(pr, null, [], [], []));
    prsByTask.set(taskId, prs);
  }
  return prsByTask;
}

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
          // The task's PR branch (spec #104): read by the no-projectId PR batch.
          kind: workspaces.kind,
          branchName: workspaces.branchName,
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

  // Global Board seam (spec #104, ticket #105): the no-projectId path batch-
  // loads every returned task's PRs (one query) so Global Board cards can show
  // PR badges without per-task round-trips. The projectId path is untouched —
  // its renderer still fills `prs` per task via `getPullRequestsForTask`.
  const prsByTask = projectId ? undefined : await batchLoadTaskPrs(rows, wsByWsId);

  return rows.map((row) => {
    const ws = row.workspaceId ? wsByWsId.get(row.workspaceId) : undefined;
    const assignedPr = row.assignedPrUrl ? assignedPrByUrl.get(row.assignedPrUrl) : undefined;
    return {
      ...mapTaskRowToTask(row, [], {}, assignedPr),
      prs: prsByTask?.get(row.id) ?? [],
      conversations: convByTask.get(row.id) ?? {},
      workspaceGit:
        ws?.linesAdded != null
          ? { linesAdded: ws.linesAdded, linesDeleted: ws.linesDeleted ?? 0 }
          : undefined,
    };
  });
}
