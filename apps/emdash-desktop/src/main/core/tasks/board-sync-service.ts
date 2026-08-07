import type { IDisposable, IInitializable } from '@emdash/shared';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { parseGitHubIssueUrl } from '@main/core/issues/inbound-sync/github-issue-url';
import { pullRequestRepositoryScope } from '@main/core/pull-requests/pr-utils';
import { taskSessionManager } from '@main/core/tasks/task-session-manager';
import { db } from '@main/db/client';
import { projectRemotes, pullRequests, tasks, workspaces } from '@main/db/schema';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import {
  derivePrStage,
  deriveTaskStageAuthorityFact,
  findSpecMatchingPrs,
  parseIssueNumberFromIdentifier,
  type PrDerivedStage,
  type PrWorkflowFact,
  type TaskStageAuthorityFact,
} from '@shared/core/pull-requests/pr-workflow-derivation';
import { prSyncProgressChannel } from '@shared/core/pull-requests/prEvents';
import type { PullRequestStatus } from '@shared/core/pull-requests/pull-requests';
import type { TaskStageAuthority, WorkflowStage } from '@shared/core/tasks/tasks';
import { writeTaskWorkflowStage } from './task-fact-writes';

/** A PR fact carrying the extra display fields the Task Detail Panel's stage
 * authority section needs (CONTEXT.md "Workflow Stage") — same matching shape
 * as `PrWorkflowFact`, extended for display rather than re-queried elsewhere. */
type StageAuthorityPrFact = PrWorkflowFact & {
  url: string;
  title: string;
  identifier: string | null;
  isDraft: boolean;
};

/** A task row the periodic sync pass may derive a stage for: Spec-linked, or
 * carrying an Assigned PR (CONTEXT.md "Assigned PR" — a user's explicit PR
 * needs no Spec link to become the stage authority). */
type BoardSyncTaskRow = {
  id: string;
  projectId: string;
  workflowStage: string | null;
  specIssueNumber: number | null;
  specRepositoryUrl: string | null;
  workspaceId: string | null;
  assignedPrUrl: string | null;
};

/**
 * The repository a task's Spec issue lives in, in the same normalized shape as
 * `pull_requests.repository_url` and `project_remotes.remote_url`. Scopes PR
 * matching to that one repository — a fork syncs PRs from every remote but reads
 * issues from one (CONTEXT.md "Issue Tracker Repository"), so without it an
 * upstream PR's `#66` would answer for the fork's Spec #66. Null when the Spec
 * link carries no parseable issue URL, which `findSpecMatchingPrs` treats as
 * "unknown, stay unscoped" rather than "matches nothing".
 */
function specRepositoryUrlOf(linkedIssues: { spec?: { url?: string } } | null): string | null {
  const url = linkedIssues?.spec?.url;
  if (!url) return null;
  return parseGitHubIssueUrl(url)?.repository.repositoryUrl ?? null;
}

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
 * Every entry point honors the task's Assigned PR (CONTEXT.md "Assigned PR",
 * docs/adr/0009) as the holding fact when one is set: its own status derives
 * the stage — open → `review`, merged → `shipped`, closed-without-merge →
 * `triage` — ahead of the Spec-derived matches, and unassigning falls back to
 * the Spec-derived path unchanged.
 *
 * Link-less tasks without an assigned PR are never touched. Once a task is in
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
   * The core derivation pass: recompute PR-derived stages for every non-archived
   * task in a project that has a Spec link or an Assigned PR. A sync pass over
   * unchanged state writes nothing and emits nothing.
   */
  async syncProject(projectId: string): Promise<void> {
    const repositoryUrls = await this._repositoryUrlsForProject(projectId);
    if (repositoryUrls.length === 0) return;

    const syncEligibleTasks = await this._syncEligibleTasks(projectId);
    if (syncEligibleTasks.length === 0) return;

    const branchByWorkspace = await this._branchNamesByWorkspaceId(
      syncEligibleTasks.flatMap((t) => (t.workspaceId ? [t.workspaceId] : []))
    );
    const prFacts = await this._prFactsForRepositories(repositoryUrls);
    const assignedPrByUrl = await this._assignedPrFactsByUrls(
      syncEligibleTasks.map((t) => t.assignedPrUrl)
    );

    for (const task of syncEligibleTasks) {
      // Triage is a sink for the periodic pass: only a user/agent gesture leaves it.
      if (task.workflowStage === 'triage') continue;

      const taskBranch = task.workspaceId ? branchByWorkspace.get(task.workspaceId) : undefined;

      // An assigned PR is the holding fact when set (CONTEXT.md "Assigned PR",
      // docs/adr/0009): it wins over every Spec-derived match; unassigning
      // falls back to the derivation below. A dangling URL (the FK's
      // ON DELETE SET NULL should prevent it) reads as unassigned.
      let derived: PrDerivedStage | null = null;
      const assignedFact = task.assignedPrUrl ? assignedPrByUrl.get(task.assignedPrUrl) : undefined;
      if (assignedFact) derived = derivePrStage([assignedFact]);
      if (!derived && task.specIssueNumber != null) {
        const matches = findSpecMatchingPrs(prFacts, {
          specIssueNumber: task.specIssueNumber,
          specRepositoryUrl: task.specRepositoryUrl,
          taskBranch,
        });
        derived = derivePrStage(matches);
      }
      if (!derived) continue; // no PR fact for this task — never touched on the periodic pass

      // expectedCurrentStage: drop the write if the stage moved since the
      // snapshot above (e.g. a manual drag into `triage` mid-pass) — the
      // derivation is stale and a user gesture must win over the periodic pass.
      await writeTaskWorkflowStage(task.id, derived, {
        expectedCurrentStage: (task.workflowStage as WorkflowStage | null) ?? null,
      });
    }
  }

  /**
   * task-provisioned hook: sets `implementing` for a Spec-linked task. An open or
   * merged PR fact — the task's Assigned PR, else a Spec-matching PR — is a
   * stronger (GitHub-proven) fact and wins instead, so provisioning never
   * downgrades a task out of `review`/`shipped`. Provisioning itself is a
   * user/agent gesture, so — unlike `syncProject` — it may move a task out of
   * `triage`.
   */
  async applyProvisionedStage(taskId: string): Promise<void> {
    const [row] = await db
      .select({
        id: tasks.id,
        projectId: tasks.projectId,
        workflowStage: tasks.workflowStage,
        linkedIssues: tasks.linkedIssues,
        workspaceId: tasks.workspaceId,
        assignedPrUrl: tasks.assignedPrUrl,
      })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .limit(1);
    if (!row) return;

    const taskBranch = row.workspaceId
      ? (await this._branchNamesByWorkspaceId([row.workspaceId])).get(row.workspaceId)
      : undefined;

    // An assigned PR is the holding fact when set (CONTEXT.md "Assigned PR",
    // docs/adr/0009) — the same override `syncProject`/`getStageAuthority`
    // apply; otherwise derive from the Spec link exactly as before.
    let derived: PrDerivedStage | null = null;
    if (row.assignedPrUrl) {
      const assignedFact = await this._prFactByUrl(row.assignedPrUrl);
      if (assignedFact) derived = derivePrStage([assignedFact]);
    }
    if (!derived) {
      const specIssueNumber = parseIssueNumberFromIdentifier(row.linkedIssues?.spec?.identifier);
      if (specIssueNumber == null) return; // link-less tasks are never auto-moved

      const repositoryUrls = await this._repositoryUrlsForProject(row.projectId);
      const prFacts =
        repositoryUrls.length > 0 ? await this._prFactsForRepositories(repositoryUrls) : [];
      const matches = findSpecMatchingPrs(prFacts, {
        specIssueNumber,
        specRepositoryUrl: specRepositoryUrlOf(row.linkedIssues),
        taskBranch,
      });
      derived = derivePrStage(matches);
    }

    // A current `review`/`shipped` stage is a GitHub-proven fact; the transient
    // absence of a matching PR row (PR facts not yet synced, renamed branch)
    // must not downgrade it to `implementing` on re-provisioning.
    const currentStage = row.workflowStage as WorkflowStage | null;
    const nextStage: WorkflowStage =
      derived === 'review' || derived === 'shipped'
        ? derived
        : currentStage === 'review' || currentStage === 'shipped'
          ? currentStage
          : 'implementing';

    await writeTaskWorkflowStage(row.id, nextStage);
  }

  /**
   * Read-only stage authority fact for the Task Detail Panel (ticket #41,
   * CONTEXT.md "Workflow Stage"): the PR that proves — or would prove, once the
   * next `syncProject` pass catches up — the task's Workflow Stage — the task's
   * Assigned PR when one is set (CONTEXT.md "Assigned PR", docs/adr/0009), else
   * the Spec-derived match — and whether that fact currently governs the
   * *persisted* stage. Reuses the exact same matching and precedence rules
   * `syncProject`/`applyProvisionedStage` use, so the panel never derives a
   * second, divergeable answer.
   */
  async getStageAuthority(taskId: string): Promise<TaskStageAuthority> {
    const none: TaskStageAuthority = { holdingPr: null, isCurrentStageGithubProven: false };

    const [row] = await db
      .select({
        projectId: tasks.projectId,
        workflowStage: tasks.workflowStage,
        linkedIssues: tasks.linkedIssues,
        workspaceId: tasks.workspaceId,
        assignedPrUrl: tasks.assignedPrUrl,
      })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .limit(1);
    if (!row) return none;

    const currentStage = (row.workflowStage as WorkflowStage | null) ?? null;

    // Assigned-PR override (CONTEXT.md "Assigned PR", docs/adr/0009): the
    // user's explicit assignment is the holding fact when set — open proves
    // `review`, merged proves `shipped`, closed-without-merge proves `triage` —
    // with no Spec link required. A dangling URL (the FK's ON DELETE SET NULL
    // should prevent it) reads as unassigned and falls through to derivation.
    if (row.assignedPrUrl) {
      const assignedPr = await this._prFactByUrl(row.assignedPrUrl);
      if (assignedPr) {
        return this._stageAuthorityResult(
          deriveTaskStageAuthorityFact({
            currentStage,
            assignedPr,
            specIssueNumber: null,
            prFacts: [],
          })
        );
      }
    }

    const specIssueNumber = parseIssueNumberFromIdentifier(row.linkedIssues?.spec?.identifier);
    if (specIssueNumber == null) return none; // link-less tasks have no PR authority to prove

    const repositoryUrls = await this._repositoryUrlsForProject(row.projectId);
    if (repositoryUrls.length === 0) return none;

    const taskBranch = row.workspaceId
      ? (await this._branchNamesByWorkspaceId([row.workspaceId])).get(row.workspaceId)
      : undefined;
    const prFacts = await this._stageAuthorityPrFacts(repositoryUrls);

    return this._stageAuthorityResult(
      deriveTaskStageAuthorityFact({
        currentStage,
        specIssueNumber,
        specRepositoryUrl: specRepositoryUrlOf(row.linkedIssues),
        taskBranch,
        prFacts,
      })
    );
  }

  /** Maps a `deriveTaskStageAuthorityFact` result onto the RPC-erased shape the
   * Task Detail Panel consumes. */
  private _stageAuthorityResult({
    holdingPr,
    isCurrentStageGithubProven,
  }: TaskStageAuthorityFact<StageAuthorityPrFact>): TaskStageAuthority {
    return {
      holdingPr: holdingPr
        ? {
            url: holdingPr.url,
            title: holdingPr.title,
            identifier: holdingPr.identifier,
            status: holdingPr.status,
            isDraft: holdingPr.isDraft,
          }
        : null,
      isCurrentStageGithubProven,
    };
  }

  private async _repositoryUrlsForProject(projectId: string): Promise<string[]> {
    const rows = await db
      .select({ remoteUrl: projectRemotes.remoteUrl })
      .from(projectRemotes)
      .where(eq(projectRemotes.projectId, projectId));
    return rows.map((r) => r.remoteUrl);
  }

  /** The non-archived tasks a periodic pass may derive a stage for: Spec-linked,
   * or carrying an Assigned PR (which needs no Spec link — docs/adr/0009). */
  private async _syncEligibleTasks(projectId: string): Promise<BoardSyncTaskRow[]> {
    const rows = await db
      .select({
        id: tasks.id,
        projectId: tasks.projectId,
        workflowStage: tasks.workflowStage,
        linkedIssues: tasks.linkedIssues,
        workspaceId: tasks.workspaceId,
        assignedPrUrl: tasks.assignedPrUrl,
      })
      .from(tasks)
      .where(and(eq(tasks.projectId, projectId), isNull(tasks.archivedAt), eq(tasks.type, 'task')));

    return rows.flatMap((row) => {
      const specIssueNumber = parseIssueNumberFromIdentifier(row.linkedIssues?.spec?.identifier);
      if (specIssueNumber == null && row.assignedPrUrl == null) {
        return []; // link-less, unassigned tasks are never auto-moved
      }
      return [
        {
          id: row.id,
          projectId: row.projectId,
          workflowStage: row.workflowStage,
          specIssueNumber,
          specRepositoryUrl: specRepositoryUrlOf(row.linkedIssues),
          workspaceId: row.workspaceId,
          assignedPrUrl: row.assignedPrUrl,
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
        repositoryUrl: pullRequests.repositoryUrl,
        headRefName: pullRequests.headRefName,
        status: pullRequests.status,
        description: pullRequests.description,
      })
      .from(pullRequests)
      .where(pullRequestRepositoryScope(repositoryUrls));

    return rows.map((row) => ({
      repositoryUrl: row.repositoryUrl,
      headRefName: row.headRefName,
      status: row.status as PrWorkflowFact['status'],
      description: row.description ?? null,
    }));
  }

  /** Same rows as `_prFactsForRepositories`, extended with the display fields
   * `getStageAuthority` needs to point the panel at the holding PR. */
  private async _stageAuthorityPrFacts(repositoryUrls: string[]): Promise<StageAuthorityPrFact[]> {
    if (repositoryUrls.length === 0) return [];

    const rows = await db
      .select({
        url: pullRequests.url,
        title: pullRequests.title,
        identifier: pullRequests.identifier,
        isDraft: pullRequests.isDraft,
        repositoryUrl: pullRequests.repositoryUrl,
        headRefName: pullRequests.headRefName,
        status: pullRequests.status,
        description: pullRequests.description,
      })
      .from(pullRequests)
      .where(pullRequestRepositoryScope(repositoryUrls));

    return rows.map(toStageAuthorityPrFact);
  }

  /** The assigned-PR facts for a set of task rows — one entry per task with an
   * assigned PR, in the same display shape `_stageAuthorityPrFacts` produces. */
  private async _assignedPrFactsByUrls(
    urls: (string | null)[]
  ): Promise<Map<string, StageAuthorityPrFact>> {
    const assignedUrls = urls.filter((url): url is string => url != null);
    if (assignedUrls.length === 0) return new Map();

    const rows = await db
      .select({
        url: pullRequests.url,
        title: pullRequests.title,
        identifier: pullRequests.identifier,
        isDraft: pullRequests.isDraft,
        repositoryUrl: pullRequests.repositoryUrl,
        headRefName: pullRequests.headRefName,
        status: pullRequests.status,
        description: pullRequests.description,
      })
      .from(pullRequests)
      .where(inArray(pullRequests.url, assignedUrls));

    return new Map(rows.map((row) => [row.url, toStageAuthorityPrFact(row)]));
  }

  /** The single assigned-PR fact for one task, or `null` when the URL is
   * dangling (the FK's ON DELETE SET NULL should prevent that). */
  private async _prFactByUrl(url: string): Promise<StageAuthorityPrFact | null> {
    const facts = await this._assignedPrFactsByUrls([url]);
    return facts.get(url) ?? null;
  }
}

/** Maps a selected pull-request row (the shape `_stageAuthorityPrFacts` and
 * `_assignedPrFactsByUrls` both select) to the display fact the stage authority
 * needs. */
function toStageAuthorityPrFact(row: {
  url: string;
  title: string;
  identifier: string | null;
  isDraft: number | boolean;
  repositoryUrl: string;
  headRefName: string;
  status: string;
  description: string | null;
}): StageAuthorityPrFact {
  return {
    url: row.url,
    title: row.title,
    identifier: row.identifier ?? null,
    isDraft: Boolean(row.isDraft),
    repositoryUrl: row.repositoryUrl,
    headRefName: row.headRefName,
    status: row.status as PullRequestStatus,
    description: row.description ?? null,
  };
}

export const boardSyncService = new BoardSyncService();
