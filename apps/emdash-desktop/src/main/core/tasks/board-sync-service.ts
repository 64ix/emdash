import type { IDisposable, IInitializable } from '@emdash/shared';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { pullRequestRepositoryScope } from '@main/core/pull-requests/pr-utils';
import { taskSessionManager } from '@main/core/tasks/task-session-manager';
import { db } from '@main/db/client';
import { projectRemotes, pullRequests, tasks, workspaces } from '@main/db/schema';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import {
  derivePrStage,
  findSpecMatchingPrs,
  parseIssueNumberFromIdentifier,
  type PrWorkflowFact,
} from '@shared/core/pull-requests/pr-workflow-derivation';
import { prSyncProgressChannel } from '@shared/core/pull-requests/prEvents';
import type { WorkflowStage } from '@shared/core/tasks/tasks';
import { writeTaskWorkflowStage } from './task-fact-writes';

type SpecLinkedTaskRow = {
  id: string;
  projectId: string;
  workflowStage: string | null;
  specIssueNumber: number | null;
  workspaceId: string | null;
};

/**
 * Derives a task's Workflow Stage from PR facts already synced into `pullRequests`
 * by the PR sync engine, plus the task-provisioned hook. See CONTEXT.md
 * ("Workflow Stage", "Triage") and docs/adr/0003-board-stages-derived-not-declared.md
 * for the authority model this implements.
 *
 * Two entry points:
 * - `syncProject` — the periodic/board-open derivation pass over PR facts. Piggybacks
 *   on the existing PrSyncScheduler cadence (subscribes to `prSyncProgressChannel`
 *   'done' events instead of running its own timer) and is also called directly by
 *   the `tasks.syncBoardStages` RPC when the Feature Board opens.
 * - `applyProvisionedStage` — the task-provisioned hook, which sets `implementing`
 *   for a Spec-linked task unless a stronger open/merged PR fact already proves
 *   `review`/`shipped`.
 *
 * Link-less tasks (no `linkedIssues.spec`) are never touched. Once a task is in
 * `triage`, `syncProject` never moves it out — only a user/agent gesture does
 * (a manual move, or provisioning the task again).
 */
export class BoardSyncService implements IInitializable, IDisposable {
  private _unsubProvisioned: (() => void) | null = null;
  private _unsubPrSyncDone: (() => void) | null = null;

  initialize(): void {
    this._unsubProvisioned = taskSessionManager.hooks.on('task:provisioned', ({ taskId }) => {
      void this.applyProvisionedStage(taskId).catch((error) => {
        log.error('BoardSyncService: applyProvisionedStage failed', {
          taskId,
          error: String(error),
        });
      });
    });

    this._unsubPrSyncDone = events.on(prSyncProgressChannel, (progress) => {
      if (progress.status !== 'done') return;
      void this._syncRepository(progress.remoteUrl).catch((error) => {
        log.error('BoardSyncService: syncRepository failed', {
          remoteUrl: progress.remoteUrl,
          error: String(error),
        });
      });
    });
  }

  dispose(): void {
    this._unsubProvisioned?.();
    this._unsubProvisioned = null;
    this._unsubPrSyncDone?.();
    this._unsubPrSyncDone = null;
  }

  /** Re-derives PR-facts stages for every project whose remote matches this repository. */
  private async _syncRepository(repositoryUrl: string): Promise<void> {
    const rows = await db
      .selectDistinct({ projectId: projectRemotes.projectId })
      .from(projectRemotes)
      .where(eq(projectRemotes.remoteUrl, repositoryUrl));

    for (const { projectId } of rows) {
      await this.syncProject(projectId);
    }
  }

  /**
   * The core derivation pass: recompute PR-derived stages for every Spec-linked,
   * non-archived task in a project. A sync pass over unchanged state writes nothing
   * and emits nothing.
   */
  async syncProject(projectId: string): Promise<void> {
    const repositoryUrls = await this._repositoryUrlsForProject(projectId);
    if (repositoryUrls.length === 0) return;

    const specLinkedTasks = await this._specLinkedTasks(projectId);
    if (specLinkedTasks.length === 0) return;

    const branchByWorkspace = await this._branchNamesByWorkspaceId(
      specLinkedTasks.flatMap((t) => (t.workspaceId ? [t.workspaceId] : []))
    );
    const prFacts = await this._prFactsForRepositories(repositoryUrls);

    for (const task of specLinkedTasks) {
      // Triage is a sink for the periodic pass: only a user/agent gesture leaves it.
      if (task.workflowStage === 'triage') continue;

      const taskBranch = task.workspaceId ? branchByWorkspace.get(task.workspaceId) : undefined;
      const matches = findSpecMatchingPrs(prFacts, {
        specIssueNumber: task.specIssueNumber,
        taskBranch,
      });
      const derived = derivePrStage(matches);
      if (!derived) continue; // no PR fact for this task — never touched on the periodic pass

      await writeTaskWorkflowStage(task.id, derived);
    }
  }

  /**
   * task-provisioned hook: sets `implementing` for a Spec-linked task. An open or
   * merged matching PR is a stronger (GitHub-proven) fact and wins instead —
   * provisioning never downgrades a task out of `review`/`shipped`. Provisioning
   * itself is a user/agent gesture, so — unlike `syncProject` — it may move a task
   * out of `triage`.
   */
  async applyProvisionedStage(taskId: string): Promise<void> {
    const [row] = await db
      .select({
        id: tasks.id,
        projectId: tasks.projectId,
        workflowStage: tasks.workflowStage,
        linkedIssues: tasks.linkedIssues,
        workspaceId: tasks.workspaceId,
      })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .limit(1);

    const specIssueNumber = parseIssueNumberFromIdentifier(row?.linkedIssues?.spec?.identifier);
    if (!row || specIssueNumber == null) return; // link-less tasks are never auto-moved

    const repositoryUrls = await this._repositoryUrlsForProject(row.projectId);
    const taskBranch = row.workspaceId
      ? (await this._branchNamesByWorkspaceId([row.workspaceId])).get(row.workspaceId)
      : undefined;

    const prFacts =
      repositoryUrls.length > 0 ? await this._prFactsForRepositories(repositoryUrls) : [];
    const matches = findSpecMatchingPrs(prFacts, { specIssueNumber, taskBranch });
    const derived = derivePrStage(matches);

    const nextStage: WorkflowStage =
      derived === 'review' || derived === 'shipped' ? derived : 'implementing';

    await writeTaskWorkflowStage(row.id, nextStage);
  }

  private async _repositoryUrlsForProject(projectId: string): Promise<string[]> {
    const rows = await db
      .select({ remoteUrl: projectRemotes.remoteUrl })
      .from(projectRemotes)
      .where(eq(projectRemotes.projectId, projectId));
    return rows.map((r) => r.remoteUrl);
  }

  private async _specLinkedTasks(projectId: string): Promise<SpecLinkedTaskRow[]> {
    const rows = await db
      .select({
        id: tasks.id,
        projectId: tasks.projectId,
        workflowStage: tasks.workflowStage,
        linkedIssues: tasks.linkedIssues,
        workspaceId: tasks.workspaceId,
      })
      .from(tasks)
      .where(and(eq(tasks.projectId, projectId), isNull(tasks.archivedAt), eq(tasks.type, 'task')));

    return rows.flatMap((row) => {
      const specIssueNumber = parseIssueNumberFromIdentifier(row.linkedIssues?.spec?.identifier);
      if (specIssueNumber == null) return []; // link-less tasks are never auto-moved
      return [
        {
          id: row.id,
          projectId: row.projectId,
          workflowStage: row.workflowStage,
          specIssueNumber,
          workspaceId: row.workspaceId,
        },
      ];
    });
  }

  private async _branchNamesByWorkspaceId(workspaceIds: string[]): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (workspaceIds.length === 0) return map;

    const rows = await db
      .select({ id: workspaces.id, branchName: workspaces.branchName })
      .from(workspaces)
      .where(inArray(workspaces.id, workspaceIds));

    for (const row of rows) {
      if (row.branchName) map.set(row.id, row.branchName);
    }
    return map;
  }

  private async _prFactsForRepositories(repositoryUrls: string[]): Promise<PrWorkflowFact[]> {
    if (repositoryUrls.length === 0) return [];

    const rows = await db
      .select({
        headRefName: pullRequests.headRefName,
        status: pullRequests.status,
        description: pullRequests.description,
      })
      .from(pullRequests)
      .where(pullRequestRepositoryScope(repositoryUrls));

    return rows.map((row) => ({
      headRefName: row.headRefName,
      status: row.status as PrWorkflowFact['status'],
      description: row.description ?? null,
    }));
  }
}

export const boardSyncService = new BoardSyncService();
