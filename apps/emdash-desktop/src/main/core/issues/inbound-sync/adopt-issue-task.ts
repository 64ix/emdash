import crypto from 'node:crypto';
import type { Result } from '@emdash/shared';
import { eq } from 'drizzle-orm';
import { createTask } from '@main/core/tasks/operations/createTask';
import { writeLinkedIssueRole, writeTaskWorkflowStage } from '@main/core/tasks/task-fact-writes';
import { taskService } from '@main/core/tasks/task-service';
import { db } from '@main/db/client';
import { projects } from '@main/db/schema';
import type { LinkedIssue, LinkedIssueRole } from '@shared/core/linked-issue';
import type {
  CreateTaskError,
  CreateTaskParams,
  CreateTaskSuccess,
  WorkflowStage,
} from '@shared/core/tasks/tasks';
import { buildWorkspaceConfigFromPreset } from '@shared/core/workspaces/build-workspace-config-from-preset';

/**
 * Creates the real task behind an adopted inbound GitHub issue — the shared
 * half of Ghost Card adoption (issue as Origin, ticket #9) and link-suggestion
 * adoption (issue as Spec/Map, for an orphan issue that describes work no
 * existing task covers). Reuses the project's repository workspace so no
 * worktree gets provisioned (the `repo-root` preset already used elsewhere for
 * lightweight tasks — see `buildWorkspaceConfigFromPreset`).
 *
 * Calls the `createTask` operation directly rather than `TaskService.createTask`
 * to avoid pulling in its much heavier project/workspace dependency graph for
 * this main-process-only flow, mirroring the reasoning in `task-fact-writes.ts`.
 * Still routes through `taskService.notifyTaskCreated` (the sanctioned hook for
 * callers that commit a task insert outside of `TaskService.createTask` — see
 * its doc comment) so the `task:created` hook fires for downstream listeners
 * (search indexing, telemetry) exactly as it would for a task created through
 * the create-task modal, not just the IPC event the renderer's task list needs.
 */
export async function adoptIssueAsTask(args: {
  projectId: string;
  issue: LinkedIssue;
  role: LinkedIssueRole;
  /**
   * Where the adopted card lands; the caller decides whether that is a
   * declaration or a fact derived from the issue. `null` leaves the task
   * Unstaged.
   */
  stage: WorkflowStage | null;
  /** Task name; defaults to the issue title. */
  name?: string;
}): Promise<Result<CreateTaskSuccess, CreateTaskError>> {
  const { projectId, issue, role, stage } = args;

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
    taskConfig: {
      version: '1',
      name: args.name ?? issue.title,
      // `createTask` only knows how to store a link in the Origin role; the
      // other roles are written just below, before the task is announced.
      ...(role === 'origin' ? { linkedIssue: issue } : {}),
    },
    workspaceConfig,
  };

  const result = await createTask(params);
  if (!result.success) return result;

  let task = result.data.task;
  if (role !== 'origin') {
    task = (await writeLinkedIssueRole(task.id, role, issue)) ?? task;
  }

  // Persist the stage and the role before announcing the task so the created
  // event already carries them — otherwise the card first renders in Unstaged
  // and only jumps to its stage when the follow-up stage event lands (or
  // never, if that event is missed).
  await writeTaskWorkflowStage(task.id, stage);
  taskService.notifyTaskCreated({ ...task, workflowStage: stage ?? undefined }, params);

  return result;
}
