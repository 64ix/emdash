import crypto from 'node:crypto';
import type { Result } from '@emdash/shared';
import { eq } from 'drizzle-orm';
import { createTask } from '@main/core/tasks/operations/createTask';
import { writeTaskWorkflowStage } from '@main/core/tasks/task-fact-writes';
import { taskService } from '@main/core/tasks/task-service';
import { db } from '@main/db/client';
import { projects } from '@main/db/schema';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import type { GhostCard } from '@shared/core/issues/ghost-card';
import { ghostCardsUpdatedChannel } from '@shared/core/issues/issueEvents';
import type {
  CreateTaskError,
  CreateTaskParams,
  CreateTaskSuccess,
} from '@shared/core/tasks/tasks';
import { buildWorkspaceConfigFromPreset } from '@shared/core/workspaces/build-workspace-config-from-preset';
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
 * task through the existing `createTask` operation with the issue set as
 * Origin, reusing the project's repository workspace so no worktree gets
 * provisioned (mirrors the `repo-root` workspace preset already used
 * elsewhere for lightweight tasks — see `buildWorkspaceConfigFromPreset`).
 * Lands the task in the `idea` stage — a declaration, not a GitHub fact (see
 * docs/adr/0003) — and removes the card from the cache so it never
 * resurfaces (an adopted ghost becomes a linked task, which the root-issue
 * filter already excludes going forward).
 *
 * Calls the `createTask` operation directly rather than `TaskService.createTask`
 * to avoid pulling in its much heavier project/workspace dependency graph for
 * this main-process-only flow, mirroring the reasoning in
 * `task-fact-writes.ts`. Still routes through `taskService.notifyTaskCreated`
 * (the sanctioned hook for callers that commit a task insert outside of
 * `TaskService.createTask` — see its doc comment) so the `task:created` hook
 * fires for downstream listeners (search indexing, telemetry) exactly as it
 * would for a task created through the create-task modal, not just the IPC
 * event the renderer's task list needs.
 */
export async function adoptGhostCard(
  projectId: string,
  ghostCard: GhostCard
): Promise<Result<CreateTaskSuccess, CreateTaskError>> {
  const [projectRow] = await db
    .select({ repositoryWorkspaceId: projects.repositoryWorkspaceId })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);

  const workspaceConfig = buildWorkspaceConfigFromPreset('repo-root', {
    repositoryWorkspaceId: projectRow?.repositoryWorkspaceId ?? undefined,
  });

  const params: CreateTaskParams = {
    id: crypto.randomUUID(),
    projectId,
    taskConfig: { version: '1', name: ghostCard.issue.title, linkedIssue: ghostCard.issue },
    workspaceConfig,
  };

  const result = await createTask(params);
  if (!result.success) return result;

  // Persist the `idea` stage before announcing the task so the created event
  // already carries it — otherwise the card first renders in Unstaged and only
  // jumps to Idea when the follow-up stage event lands (or never, if that
  // event is missed).
  await writeTaskWorkflowStage(result.data.task.id, 'idea');
  taskService.notifyTaskCreated({ ...result.data.task, workflowStage: 'idea' }, params);
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
