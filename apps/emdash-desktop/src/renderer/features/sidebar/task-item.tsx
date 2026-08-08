import { observer } from 'mobx-react-lite';
import { getProjectStore } from '@renderer/features/projects/stores/project-selectors';
import { TaskSidebarTrailingSlot } from '@renderer/features/sidebar/task-sidebar-agent-status';
import { TaskContextMenu } from '@renderer/features/tasks/components/task-context-menu';
import { TaskGitDiffStats } from '@renderer/features/tasks/components/task-git-diff-stats';
import {
  getTaskGitWorktreeStore,
  getTaskManagerStore,
  getTaskStore,
  getWorkspaceForTask,
} from '@renderer/features/tasks/stores/task-selectors';
import { registeredTaskData, type TaskStore } from '@renderer/features/tasks/stores/task-store';
import {
  useNavigate,
  useParams,
  useWorkspaceSlots,
} from '@renderer/lib/layout/navigation-provider';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { sidebarStore } from '@renderer/lib/stores/app-state';
import { cn } from '@renderer/utils/utils';
import { selectCurrentPr } from '@shared/core/pull-requests/pull-requests';
import type { WorkflowStage } from '@shared/core/tasks/tasks';
import { PrBadge } from '../../lib/components/pr-badge';
import { useAppSettingsKey } from '../settings/use-app-settings-key';
import { projectHue } from './project-card-model';
import { JADE_ACTIVE_BACKGROUND, SidebarMenuAction, SidebarMenuRow } from './sidebar-primitives';
import { SidebarSignalDot, taskSidebarSignal } from './sidebar-signal-dot';
import { sidebarStageMoveOptions } from './stage-group-row-model';

interface SidebarTaskItemProps {
  taskId: string;
  projectId: string;
  /**
   * Pinned strip uses tighter padding than tasks nested under a project;
   * tasks inside a Stage Group (spec #85) are indented one level deeper
   * than Unstaged loose rows. Inside a project card (spec #120), the card's
   * left rail already provides the indent, so the row only needs a shallow
   * one.
   */
  rowVariant?: 'underProject' | 'pinned' | 'grouped' | 'card';
}

export const SidebarTaskItem = observer(function SidebarTaskItem({
  taskId,
  projectId,
  rowVariant = 'underProject',
}: SidebarTaskItemProps) {
  const { navigate } = useNavigate();
  const showRename = useShowModal('renameTaskModal');
  const showDeleteTask = useShowModal('deleteTaskModal');

  const { currentView } = useWorkspaceSlots();
  const { params } = useParams('task');
  const { value: interfaceSettings } = useAppSettingsKey('interface');
  const isActive =
    currentView === 'task' && params.taskId === taskId && params.projectId === projectId;

  const task = getTaskStore(projectId, taskId)!;
  const taskManager = getTaskManagerStore(projectId);

  const taskName = task.data.name;
  const signal = taskSidebarSignal(task);

  const handleProvision = () => {
    if (task.state !== 'unprovisioned' || task.phase !== 'idle') return;
    void taskManager?.provisionTask(taskId);
  };

  const openTask = () => {
    handleProvision();
    navigate('task', { projectId, taskId });
  };

  const handleArchive = () => {
    if (isActive) navigate('project', { projectId });
    void taskManager?.archiveTask(taskId);
  };

  const handleRename = () => showRename({ projectId, taskId, currentName: taskName });

  const handleDelete = () =>
    showDeleteTask({
      projectId,
      tasks: [{ taskId, taskName }],
      onSuccess: ({ deleteWorktree, deleteBranch }) => {
        void taskManager?.deleteTasks([taskId], { deleteWorktree, deleteBranch });
        if (isActive) navigate('project', { projectId });
      },
    });

  const canPin = task.state !== 'unregistered';

  const workspaceStore = getWorkspaceForTask(projectId, taskId);
  const git = getTaskGitWorktreeStore(projectId, taskId);
  const showLineChanges = interfaceSettings?.showLeftSidebarLineChanges ?? true;
  const showPrStatus = interfaceSettings?.showLeftSidebarPrStatus ?? true;
  const showTimestamps = interfaceSettings?.showLeftSidebarTimestamps ?? true;
  const branchName = git?.branchName ?? undefined;
  const handleReconnect =
    workspaceStore?.connectionState != null ? () => workspaceStore.reconnect() : undefined;

  // Pinned strip (spec #120 US13): the task keeps its project identity — hue
  // dot and project name — so pinned tasks stay attributable across projects.
  const pinnedProjectName =
    rowVariant === 'pinned' ? (getProjectStore(projectId)?.name ?? 'project') : null;

  // "Move to stage…" (spec #85, ticket #88): the same authority gating the
  // board applies to cross-stage drops, computed synchronously from data
  // already on the task. Unregistered tasks have no stage fields — no
  // submenu. The write itself goes through the store's `updateBoardPosition`
  // (the exact stage/rank path the board uses, optimistic update with
  // rollback); `rank: null` is the Task Detail Panel's stage-selector
  // gesture — a stage move carries no position, so the task lands unranked
  // in its new group.
  const registered = registeredTaskData(task);
  const stageMove = registered ? sidebarStageMoveOptions(registered, branchName ?? null) : null;

  const handleMoveToStage = (stage: WorkflowStage | null) => {
    void task.updateBoardPosition(stage, null);
  };

  return (
    <TaskContextMenu
      isPinned={task.data.isPinned}
      canPin={canPin}
      isArchived={false}
      branchName={branchName}
      onPin={() => void task.setPinned(true)}
      onUnpin={() => void task.setPinned(false)}
      onRename={handleRename}
      onArchive={handleArchive}
      onReconnect={handleReconnect}
      onConvertAutomation={undefined}
      onDelete={handleDelete}
      // Hidden Task (spec #85, ticket #87): the sidebar only ever renders
      // visible tasks, so the menu here only ever offers "Hide from
      // sidebar"; the row is a no-op for the pinned strip, which is
      // unchanged (spec user story 29).
      isHiddenFromSidebar={false}
      onHideFromSidebar={() => sidebarStore.hideTaskFromSidebar(projectId, taskId)}
      stageMoveOptions={stageMove?.options}
      stageMoveExplanation={stageMove?.explanation}
      onMoveToStage={stageMove ? handleMoveToStage : undefined}
    >
      <SidebarMenuRow
        className={cn(
          'group/row flex items-center justify-between px-1 py-1.5 h-8 gap-1',
          rowVariant === 'pinned'
            ? 'pl-2'
            : rowVariant === 'card'
              ? 'pl-1'
              : rowVariant === 'grouped'
                ? 'pl-12'
                : 'pl-8'
        )}
        isActive={isActive}
        style={isActive ? { backgroundColor: JADE_ACTIVE_BACKGROUND } : undefined}
        onMouseDown={(e) => e.preventDefault()}
        onClick={openTask}
      >
        <SidebarMenuAction
          aria-label={`Open task ${taskName || 'task'}`}
          className="gap-1 overflow-hidden"
        >
          {rowVariant === 'pinned' && (
            <span
              className="size-2 shrink-0 rounded-full"
              style={{ backgroundColor: projectHue(projectId).dot }}
            />
          )}
          <SidebarSignalDot signal={signal} />
          <span
            className={cn(
              'min-w-0 truncate text-left transition-colors',
              task.isBootstrapping && 'text-foreground/40',
              isActive && 'font-medium text-[var(--jade-11)]'
            )}
          >
            {taskName}
          </span>
        </SidebarMenuAction>
        {pinnedProjectName && (
          <span className="max-w-24 shrink-0 truncate text-[11px] text-foreground-tertiary-passive">
            {pinnedProjectName}
          </span>
        )}
        <div className="ml-2 flex shrink-0 items-center justify-end gap-1.5">
          {showLineChanges && <TaskGitDiffStats task={task} />}
          {showPrStatus && <RenderPrBadge task={task} />}
          <TaskSidebarTrailingSlot task={task} showTimestamp={showTimestamps} />
        </div>
      </SidebarMenuRow>
    </TaskContextMenu>
  );
});

const RenderPrBadge = observer(function RenderPrBadge({ task }: { task: TaskStore }) {
  if (!('prs' in task.data)) return null;
  const pr = selectCurrentPr(task.data.prs);
  return pr ? (
    <span onMouseDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
      <PrBadge variant="compact" pr={pr} hoverDelay={100} />
    </span>
  ) : null;
});
