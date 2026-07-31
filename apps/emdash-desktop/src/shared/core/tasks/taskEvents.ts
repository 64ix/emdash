import type { PullRequest } from '@shared/core/pull-requests/pull-requests';
import type { Task, WorkflowStage } from '@shared/core/tasks/tasks';
import { defineEvent } from '@shared/lib/ipc/events';

export const taskCreatedChannel = defineEvent<{ task: Task }>('task:created');

export const taskDeletedChannel = defineEvent<{
  taskId: string;
  projectId: string;
}>('task:deleted');

export const taskStatusUpdatedChannel = defineEvent<{
  taskId: string;
  projectId: string;
  status: string;
}>('task:status-updated');

/**
 * Fired whenever a task's Workflow Stage changes from a main-process actor that
 * isn't the renderer's own optimistic update (the board sync service's derivation
 * pass and the task-provisioned `implementing` hook — see board-sync-service.ts).
 * Manual chevron moves apply optimistically in the renderer and don't need this.
 */
export const taskWorkflowStageUpdatedChannel = defineEvent<{
  taskId: string;
  projectId: string;
  workflowStage: WorkflowStage | null;
}>('task:workflow-stage-updated');

export const taskPrUpdatedChannel = defineEvent<{
  taskId: string;
  projectId: string;
  workspaceId: string;
  prs: PullRequest[];
}>('task:pr-updated');

export type ProvisionStep =
  | 'resolving-worktree'
  | 'initialising-workspace'
  | 'running-provision-script'
  | 'connecting'
  | 'setting-up-workspace'
  | 'starting-sessions';

export const taskProvisionProgressChannel = defineEvent<{
  taskId: string;
  projectId: string;
  step: ProvisionStep;
  message: string;
}>('task:provision-progress');

export type LifecycleScriptType = 'setup' | 'run' | 'teardown';
export type LifecycleScriptOrigin = 'auto-setup' | 'auto-run' | 'manual' | 'workspace-destroy';

export type LifecycleScriptStatusEvent = {
  taskId: string;
  projectId: string;
  workspaceId: string;
  type: LifecycleScriptType;
  origin: LifecycleScriptOrigin;
} & (
  | { status: 'running' }
  | { status: 'succeeded'; exitCode?: number }
  | {
      status: 'failed';
      message: string;
      surfaceFailure: boolean;
      exitCode?: number;
      signal?: string | number;
    }
  | { status: 'stopped'; message?: string }
);

export const lifecycleScriptStatusChannel = defineEvent<LifecycleScriptStatusEvent>(
  'task:lifecycle-script-status'
);

export const taskProvisionedChannel = defineEvent<{
  taskId: string;
  projectId: string;
  path: string;
  workspaceId: string;
  sshConnectionId?: string;
}>('task:provisioned');
