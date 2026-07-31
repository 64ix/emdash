import { eq } from 'drizzle-orm';
import { getProjectRemoteUrls } from '@main/core/pull-requests/project-remotes-service';
import { writeLinkedIssueRole, writeTaskWorkflowStage } from '@main/core/tasks/task-fact-writes';
import { db } from '@main/db/client';
import { tasks } from '@main/db/schema';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import { linkSuggestionsUpdatedChannel } from '@shared/core/issues/issueEvents';
import type { LinkSuggestion } from '@shared/core/issues/link-suggestion';
import type { WorkflowStage } from '@shared/core/tasks/tasks';
import { parseGitHubIssueUrl } from './github-issue-url';
import {
  dismissLinkSuggestionUrl,
  getCachedSuggestions,
  setCachedSuggestionsIfChanged,
} from './link-suggestions-store';
import { deriveWorkflowStageFromIssues } from './stage-derivation';

/** All cached link suggestions across every GitHub remote configured for a project. */
export async function getLinkSuggestionsForProject(projectId: string): Promise<LinkSuggestion[]> {
  const repositoryUrls = await getProjectRemoteUrls(projectId);
  const perRepository = await Promise.all(
    repositoryUrls.map((repositoryUrl) => getCachedSuggestions(projectId, repositoryUrl))
  );
  return perRepository.flat();
}

/**
 * Accepts a link suggestion: attaches its role to the chosen task (through
 * the same write-and-notify path the inbound sync itself uses) and removes
 * it from the cached suggestion list. Also nudges the task's Workflow Stage
 * immediately from the suggestion's already-known (open) issue state, rather
 * than waiting for the next sync pass to observe the same fact.
 */
export async function acceptLinkSuggestion(
  projectId: string,
  taskId: string,
  suggestion: LinkSuggestion
): Promise<void> {
  await writeLinkedIssueRole(taskId, suggestion.role, suggestion.issue);

  // Read the task's real current stage so this immediate nudge respects the
  // same "never regress a stage these facts can't prove" guard the sync
  // engine applies — it must not fast-path a task that's already advanced
  // past `spec`/`exploring` (e.g. `review`/`shipped`) back down.
  const currentStage = await _getTaskWorkflowStage(taskId);
  const desiredStage = deriveWorkflowStageFromIssues({
    currentStage,
    // Suggestions are always sourced from open issues (see `computeLinkSuggestions`).
    specIssue: suggestion.role === 'spec' ? { state: 'open' } : undefined,
    mapIssue: suggestion.role === 'map' ? { state: 'open' } : undefined,
    hasMergedPullRequest: false,
  });
  if (desiredStage) {
    await writeTaskWorkflowStage(taskId, desiredStage);
  }

  await _removeSuggestion(projectId, suggestion);
}

async function _getTaskWorkflowStage(taskId: string): Promise<WorkflowStage | null> {
  const [row] = await db
    .select({ workflowStage: tasks.workflowStage })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .limit(1);
  return (row?.workflowStage as WorkflowStage | null) ?? null;
}

/** Dismisses a link suggestion so a future sync pass never re-surfaces it. */
export async function dismissLinkSuggestion(
  projectId: string,
  suggestion: LinkSuggestion
): Promise<void> {
  const repositoryUrl = _repositoryUrlForSuggestion(suggestion);
  if (!repositoryUrl) return;

  await dismissLinkSuggestionUrl(projectId, repositoryUrl, suggestion.issue.url);
  await _removeSuggestion(projectId, suggestion);
}

async function _removeSuggestion(projectId: string, suggestion: LinkSuggestion): Promise<void> {
  const repositoryUrl = _repositoryUrlForSuggestion(suggestion);
  if (!repositoryUrl) return;

  const existing = await getCachedSuggestions(projectId, repositoryUrl);
  const next = existing.filter((s) => s.id !== suggestion.id);
  if (next.length === existing.length) return;

  const changed = await setCachedSuggestionsIfChanged(projectId, repositoryUrl, next);
  if (changed) {
    events.emit(linkSuggestionsUpdatedChannel, { projectId, repositoryUrl, suggestions: next });
  }
}

function _repositoryUrlForSuggestion(suggestion: LinkSuggestion): string | null {
  const parsed = parseGitHubIssueUrl(suggestion.issue.url);
  if (!parsed) {
    log.warn('link-suggestions-service: could not resolve repository for suggestion', {
      issueUrl: suggestion.issue.url,
    });
    return null;
  }
  return parsed.repository.repositoryUrl;
}
