import { useCallback } from 'react';
import { getTaskManagerStore } from '@renderer/features/tasks/stores/task-selectors';
import type { InitialConversationState } from '@renderer/features/tasks/task-config/initial-conversation-section';
import type { NavigateFnTyped } from '@renderer/lib/layout/navigation-provider';
import { log } from '@renderer/utils/logger';
import type { WorkflowStage } from '@shared/core/tasks/tasks';
import { buildInitialConversation, deriveInitialStatus } from './build-create-task-params';
import { placeCreatedTaskInColumn } from './place-created-task-in-column';
import type { CreateTaskState } from './use-create-task-state';

interface UseCreateTaskCallbackParams {
  selectedProjectId: string | undefined;
  state: CreateTaskState;
  initialConversation: InitialConversationState;
  navigate: NavigateFnTyped;
  onClose: () => void;
  /** Set when the modal was opened from an eligible Feature Board column (ticket #45) —
   * the new task's initial manual Workflow Stage placement, applied after creation via
   * the existing board-position write, not a parallel creation path. */
  initialWorkflowStage?: WorkflowStage;
}

export function useCreateTaskCallback({
  selectedProjectId,
  state,
  initialConversation,
  navigate,
  onClose,
  initialWorkflowStage,
}: UseCreateTaskCallbackParams): { handleCreateTask: () => void; canCreate: boolean } {
  const canCreate = !!selectedProjectId && state.isValid;

  const handleCreateTask = useCallback(() => {
    if (!selectedProjectId) return;
    const taskManager = getTaskManagerStore(selectedProjectId);
    if (!taskManager) return;

    const id = crypto.randomUUID();
    void taskManager
      .createTask({
        id,
        projectId: selectedProjectId,
        taskConfig: {
          version: '1',
          name: state.taskName.effectiveTaskName,
          linkedIssue: state.linkedType === 'issue' ? (state.linkedIssue ?? undefined) : undefined,
          initialStatus: deriveInitialStatus(state.linkedType, state.linkedPR),
          initialConversation: buildInitialConversation(initialConversation),
        },
        workspaceConfig: state.workspaceConfig.resolvedConfig,
      })
      .catch((e) => log.error('create task failed', e));

    if (initialWorkflowStage) {
      placeCreatedTaskInColumn(taskManager, id, initialWorkflowStage);
    }

    navigate('task', { projectId: selectedProjectId, taskId: id });
    onClose();
  }, [selectedProjectId, state, initialConversation, navigate, onClose, initialWorkflowStage]);

  return { handleCreateTask, canCreate };
}
