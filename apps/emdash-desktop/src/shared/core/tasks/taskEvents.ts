import type { LinkedIssue, LinkedIssueRole } from '@shared/core/linked-issue';
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
 * Emitted whenever a task's Workflow Stage changes from a main-process write
 * path — the board sync service's PR-facts derivation pass, the
 * task-provisioned `implementing` hook (see board-sync-service.ts), and the
 * inbound issues sync deriving a stage from GitHub facts (see
 * task-fact-writes.ts). Renderer-initiated manual moves (board drag-and-drop)
 * apply optimistically in the originating window; this lets every window
 * observe main-process-derived changes too.
 */
export const taskWorkflowStageUpdatedChannel = defineEvent<{
  taskId: string;
  projectId: string;
  stage: WorkflowStage | null;
}>('task:workflow-stage-updated');

/**
 * Emitted whenever a task's Map or Spec Linked Issue Role changes from a
 * main-process-initiated write (the inbound issues sync attaching a Task
 * Marker match — see ticket #8). Renderer-initiated role changes already
 * apply optimistically in the originating window; this lets every window
 * (and any main-process listener) observe the change too.
 */
export const taskLinkedIssueRoleUpdatedChannel = defineEvent<{
  taskId: string;
  projectId: string;
  role: LinkedIssueRole;
  issue: LinkedIssue | null;
}>('task:linked-issue-role-updated');

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
