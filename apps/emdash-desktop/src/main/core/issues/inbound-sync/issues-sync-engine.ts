import { err, ok, type Result } from '@emdash/shared';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { GitHubApiAuthError } from '@main/core/github/services/github-api-auth-errors';
import type { GitHubApiAuthContext } from '@main/core/github/services/github-api-auth-service';
import { writeLinkedIssueRole, writeTaskWorkflowStage } from '@main/core/tasks/task-fact-writes';
import { db } from '@main/db/client';
import { pullRequests, tasks, workspaces } from '@main/db/schema';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import { linkSuggestionsUpdatedChannel } from '@shared/core/issues/issueEvents';
import type { WorkflowStage } from '@shared/core/tasks/tasks';
import { parseRepositoryRefResult } from '@shared/repository-ref';
import { parseGitHubIssueUrl } from './github-issue-url';
import {
  getGitHubIssuesClient,
  type GitHubIssuesClient,
  type RemoteIssue,
} from './github-issues-client';
import { parseEmdashTaskMarker } from './issue-marker';
import { classifyIssueShape } from './issue-shape';
import {
  computeLinkSuggestions,
  remoteIssueToLinkedIssue,
  type SuggestionCandidate,
} from './link-suggestions';
import { getDismissedIssueUrls, setCachedSuggestionsIfChanged } from './link-suggestions-store';
import { deriveWorkflowStageFromIssues, type IssueStateFact } from './stage-derivation';

export type IssuesSyncAuthContext = Pick<GitHubApiAuthContext, 'accountId'>;

export type IssuesSyncSummary = {
  /** Number of tasks whose Workflow Stage changed as a result of this pass. */
  stageChanges: number;
  /** Number of tasks whose Spec/Map Linked Issue Role was attached via a Task Marker. */
  roleAttachments: number;
  /** Whether the cached link-suggestions snapshot changed. */
  suggestionsChanged: boolean;
};

export type IssuesSyncEngineError =
  | { type: 'invalid_repository'; repositoryUrl: string }
  | { type: 'auth'; error: GitHubApiAuthError };

type TaskFacts = {
  currentStage: WorkflowStage | null;
  branchName: string | null;
  specFact?: IssueStateFact;
  mapFact?: IssueStateFact;
};

/**
 * Inbound GitHub issues sync (ticket #8): parses `Emdash-Task:` markers to
 * attach the Spec/Map Linked Issue Role automatically, derives Workflow Stage
 * from the resulting Spec/Map facts (docs/adr/0003), and surfaces orphan
 * Spec/Map-shaped issues as link suggestions. Mirrors `PrSyncEngine`'s
 * dependency-injected Octokit-resolution pattern so tests can supply a faked
 * `GitHubIssuesClient` — see `issues-sync-engine.db.test.ts`.
 */
export class IssuesSyncEngine {
  constructor(
    private readonly getClient: (
      host: string,
      authContext?: IssuesSyncAuthContext
    ) => Promise<Result<GitHubIssuesClient, GitHubApiAuthError>>
  ) {}

  async sync(
    projectId: string,
    repositoryUrl: string,
    authContext: IssuesSyncAuthContext = {}
  ): Promise<Result<IssuesSyncSummary, IssuesSyncEngineError>> {
    const repository = parseRepositoryRefResult(repositoryUrl);
    if (!repository.success) return err({ type: 'invalid_repository', repositoryUrl });

    const client = await this.getClient(repository.data.host, authContext);
    if (!client.success) return err({ type: 'auth', error: client.error });

    const summary: IssuesSyncSummary = {
      stageChanges: 0,
      roleAttachments: 0,
      suggestionsChanged: false,
    };

    const rows = await db
      .select({
        id: tasks.id,
        workflowStage: tasks.workflowStage,
        linkedIssues: tasks.linkedIssues,
        workspaceId: tasks.workspaceId,
      })
      .from(tasks)
      .where(and(eq(tasks.projectId, projectId), isNull(tasks.archivedAt)));

    const workspaceIds = rows.flatMap((r) => (r.workspaceId ? [r.workspaceId] : []));
    const branchByWorkspaceId = new Map<string, string | null>();
    if (workspaceIds.length > 0) {
      const wsRows = await db
        .select({ id: workspaces.id, branchName: workspaces.branchName })
        .from(workspaces)
        .where(inArray(workspaces.id, workspaceIds));
      for (const w of wsRows) branchByWorkspaceId.set(w.id, w.branchName);
    }

    const tasksById = new Map<string, (typeof rows)[number]>();
    const taskFacts = new Map<string, TaskFacts>();
    const linkedIssueUrls = new Set<string>();

    for (const row of rows) {
      tasksById.set(row.id, row);
      taskFacts.set(row.id, {
        currentStage: (row.workflowStage as WorkflowStage | null) ?? null,
        branchName: row.workspaceId ? (branchByWorkspaceId.get(row.workspaceId) ?? null) : null,
      });

      const specUrl = row.linkedIssues?.spec?.url;
      const mapUrl = row.linkedIssues?.map?.url;
      if (specUrl) linkedIssueUrls.add(specUrl);
      if (mapUrl) linkedIssueUrls.add(mapUrl);
    }

    // Refresh already-linked Spec/Map issues (for this repository) so stage
    // derivation reflects their current state even if they've fallen out of
    // the shape-candidate search below (e.g. an edited title).
    for (const row of rows) {
      const facts = taskFacts.get(row.id)!;
      const specUrl = row.linkedIssues?.spec?.url;
      const mapUrl = row.linkedIssues?.map?.url;

      if (specUrl) {
        const remote = await this._refreshLinkedIssue(client.data, repository.data, specUrl);
        if (remote) facts.specFact = { state: remote.state };
      }
      if (mapUrl) {
        const remote = await this._refreshLinkedIssue(client.data, repository.data, mapUrl);
        if (remote) facts.mapFact = { state: remote.state };
      }
    }

    // Discover Spec/Map-shaped candidates for Task Marker attachment and
    // suggestion sourcing.
    const [mapIssues, specIssues] = await Promise.all([
      client.data.listMapIssues(repository.data),
      client.data.listSpecIssues(repository.data),
    ]);
    const candidatesByUrl = new Map<string, RemoteIssue>();
    for (const issue of [...mapIssues, ...specIssues]) candidatesByUrl.set(issue.url, issue);

    const suggestionCandidates: SuggestionCandidate[] = [];

    for (const issue of candidatesByUrl.values()) {
      const role = classifyIssueShape({ title: issue.title, labels: issue.labels });
      if (!role) continue;

      const markerTaskId = parseEmdashTaskMarker(issue.body);
      if (markerTaskId) {
        const targetRow = tasksById.get(markerTaskId);
        if (targetRow) {
          const alreadyAttached =
            (role === 'spec'
              ? targetRow.linkedIssues?.spec?.url
              : targetRow.linkedIssues?.map?.url) === issue.url;
          if (!alreadyAttached) {
            await writeLinkedIssueRole(markerTaskId, role, remoteIssueToLinkedIssue(issue));
            summary.roleAttachments += 1;
            linkedIssueUrls.add(issue.url);
          }
          const facts = taskFacts.get(markerTaskId)!;
          const fact: IssueStateFact = { state: issue.state };
          if (role === 'spec') facts.specFact = fact;
          else facts.mapFact = fact;
        } else {
          log.debug('IssuesSyncEngine: Task Marker points at an unknown task, ignoring', {
            projectId,
            issueUrl: issue.url,
            markerTaskId,
          });
        }
      }

      suggestionCandidates.push({ issue, role, hasMarker: markerTaskId !== null });
    }

    // Derive Workflow Stage for every task we can prove something about.
    for (const [taskId, facts] of taskFacts) {
      if (!facts.specFact && !facts.mapFact) continue;

      const hasMergedPullRequest =
        facts.specFact?.state === 'closed' && facts.branchName
          ? await this._hasMergedPullRequestForBranch(
              repository.data.repositoryUrl,
              facts.branchName
            )
          : false;

      const desired = deriveWorkflowStageFromIssues({
        currentStage: facts.currentStage,
        specIssue: facts.specFact,
        mapIssue: facts.mapFact,
        hasMergedPullRequest,
      });

      if (desired && desired !== facts.currentStage) {
        await writeTaskWorkflowStage(taskId, desired);
        summary.stageChanges += 1;
      }
    }

    // Compute + cache link suggestions.
    const dismissedIssueUrls = await getDismissedIssueUrls(
      projectId,
      repository.data.repositoryUrl
    );
    const suggestions = computeLinkSuggestions({
      candidates: suggestionCandidates,
      linkedIssueUrls,
      dismissedIssueUrls,
    });
    const suggestionsChanged = await setCachedSuggestionsIfChanged(
      projectId,
      repository.data.repositoryUrl,
      suggestions
    );
    summary.suggestionsChanged = suggestionsChanged;
    if (suggestionsChanged) {
      events.emit(linkSuggestionsUpdatedChannel, {
        projectId,
        repositoryUrl: repository.data.repositoryUrl,
        suggestions,
      });
    }

    return ok(summary);
  }

  private async _refreshLinkedIssue(
    client: GitHubIssuesClient,
    repository: Parameters<GitHubIssuesClient['getIssue']>[0],
    issueUrl: string
  ): Promise<RemoteIssue | null> {
    const parsed = parseGitHubIssueUrl(issueUrl);
    if (!parsed || parsed.repository.repositoryUrl !== repository.repositoryUrl) return null;
    return client.getIssue(repository, parsed.number);
  }

  private async _hasMergedPullRequestForBranch(
    repositoryUrl: string,
    branchName: string
  ): Promise<boolean> {
    const rows = await db
      .select({ url: pullRequests.url })
      .from(pullRequests)
      .where(
        and(
          eq(pullRequests.repositoryUrl, repositoryUrl),
          eq(pullRequests.headRefName, branchName),
          eq(pullRequests.status, 'merged')
        )
      )
      .limit(1);
    return rows.length > 0;
  }
}

export const issuesSyncEngine = new IssuesSyncEngine(getGitHubIssuesClient);
