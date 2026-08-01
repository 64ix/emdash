import type { Result } from '@emdash/shared';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import type { GhostCard } from '@shared/core/issues/ghost-card';
import { ghostCardsUpdatedChannel } from '@shared/core/issues/issueEvents';
import type { CreateTaskError, CreateTaskSuccess } from '@shared/core/tasks/tasks';
import { adoptIssueAsTask } from './adopt-issue-task';
import {
  getCachedGhostCards,
  rejectGhostCardUrl,
  setCachedGhostCardsIfChanged,
} from './ghost-card-store';
import { parseGitHubIssueUrl } from './github-issue-url';
import { getIssueTrackerRepositoryUrl } from './issue-tracker-repository';

/**
 * Cached Ghost Cards for the project's issue tracker — the single repository
 * behind its base remote, never the whole remote list (see
 * `getIssueTrackerRepositoryUrl`): a fork's upstream issues are not board
 * candidates.
 */
export async function getGhostCardsForProject(projectId: string): Promise<GhostCard[]> {
  const repositoryUrl = await getIssueTrackerRepositoryUrl(projectId);
  if (!repositoryUrl) return [];
  return getCachedGhostCards(projectId, repositoryUrl);
}

/**
 * Adopts a Ghost Card (ticket #9, CONTEXT.md "Ghost Card"): creates a real
 * task with the issue set as Origin (see `adoptIssueAsTask`), lands it in the
 * `idea` stage — a declaration, not a GitHub fact (see docs/adr/0003) — and
 * removes the card from the cache so it never resurfaces (an adopted ghost
 * becomes a linked task, which the root-issue filter already excludes going
 * forward).
 */
export async function adoptGhostCard(
  projectId: string,
  ghostCard: GhostCard
): Promise<Result<CreateTaskSuccess, CreateTaskError>> {
  const result = await adoptIssueAsTask({
    projectId,
    issue: ghostCard.issue,
    role: 'origin',
    stage: 'idea',
  });
  if (!result.success) return result;

  await _removeGhostCard(projectId, ghostCard);

  return result;
}

/**
 * Rejects a Ghost Card: persists the rejection so a future sync pass never
 * re-surfaces it — the only thing persisted for a ghost before adoption.
 */
export async function rejectGhostCard(projectId: string, ghostCard: GhostCard): Promise<void> {
  const repositoryUrl = _repositoryUrlForGhostCard(ghostCard);
  if (!repositoryUrl) return;

  await rejectGhostCardUrl(projectId, repositoryUrl, ghostCard.issue.url);
  await _removeGhostCard(projectId, ghostCard);
}

async function _removeGhostCard(projectId: string, ghostCard: GhostCard): Promise<void> {
  const repositoryUrl = _repositoryUrlForGhostCard(ghostCard);
  if (!repositoryUrl) return;

  const existing = await getCachedGhostCards(projectId, repositoryUrl);
  const next = existing.filter((c) => c.id !== ghostCard.id);
  if (next.length === existing.length) return;

  const changed = await setCachedGhostCardsIfChanged(projectId, repositoryUrl, next);
  if (changed) {
    events.emit(ghostCardsUpdatedChannel, { projectId, repositoryUrl, ghostCards: next });
  }
}

function _repositoryUrlForGhostCard(ghostCard: GhostCard): string | null {
  const parsed = parseGitHubIssueUrl(ghostCard.issue.url);
  if (!parsed) {
    log.warn('ghost-card-service: could not resolve repository for ghost card', {
      issueUrl: ghostCard.issue.url,
    });
    return null;
  }
  return parsed.repository.repositoryUrl;
}
