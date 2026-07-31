import crypto from 'node:crypto';
import type { Result } from '@emdash/shared';
import { eq } from 'drizzle-orm';
import { getProjectRemoteUrls } from '@main/core/pull-requests/project-remotes-service';
import { createTask } from '@main/core/tasks/operations/createTask';
import { writeTaskWorkflowStage } from '@main/core/tasks/task-fact-writes';
import { db } from '@main/db/client';
import { projects } from '@main/db/schema';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import type { GhostCard } from '@shared/core/issues/ghost-card';
import { ghostCardsUpdatedChannel } from '@shared/core/issues/issueEvents';
import { taskCreatedChannel } from '@shared/core/tasks/taskEvents';
import type { CreateTaskError, CreateTaskSuccess } from '@shared/core/tasks/tasks';
import { buildWorkspaceConfigFromPreset } from '@shared/core/workspaces/build-workspace-config-from-preset';
import {
  getCachedGhostCards,
  rejectGhostCardUrl,
  setCachedGhostCardsIfChanged,
} from './ghost-card-store';
import { parseGitHubIssueUrl } from './github-issue-url';

/** All cached Ghost Cards across every GitHub remote configured for a project. */
export async function getGhostCardsForProject(projectId: string): Promise<GhostCard[]> {
  const repositoryUrls = await getProjectRemoteUrls(projectId);
  const perRepository = await Promise.all(
    repositoryUrls.map((repositoryUrl) => getCachedGhostCards(projectId, repositoryUrl))
  );
  return perRepository.flat();
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
 * Calls the `createTask` operation directly rather than `TaskService` to
 * avoid pulling in its much heavier project/workspace dependency graph for
 * this main-process-only flow, mirroring the reasoning in
 * `task-fact-writes.ts`. `taskCreatedChannel` is emitted manually so the
 * renderer's task list still picks up the new task immediately.
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

  const result = await createTask({
    id: crypto.randomUUID(),
    projectId,
    taskConfig: { version: '1', name: ghostCard.issue.title, linkedIssue: ghostCard.issue },
    workspaceConfig,
  });
  if (!result.success) return result;

  events.emit(taskCreatedChannel, { task: result.data.task });
  await writeTaskWorkflowStage(result.data.task.id, 'idea');
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
