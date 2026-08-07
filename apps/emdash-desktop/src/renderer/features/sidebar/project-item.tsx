import {
  CableIcon,
  ChevronRight,
  FolderClosed,
  FolderInput,
  Loader2,
  Plus,
  RotateCcw,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { observer } from 'mobx-react-lite';
import React, { useCallback, useEffect } from 'react';
import { taskNeedsAttention } from '@renderer/features/board/board-attention';
import { useConfirmDeleteProject } from '@renderer/features/projects/hooks/use-confirm-delete-project';
import {
  isUnmountedProject,
  isUnregisteredProject,
  type UnregisteredProject,
} from '@renderer/features/projects/stores/project';
import {
  getProjectStore,
  getGitRepositoryStore,
  projectViewKind,
} from '@renderer/features/projects/stores/project-selectors';
import { getTaskManagerStore } from '@renderer/features/tasks/stores/task-selectors';
import { ConnectionStatusDot } from '@renderer/lib/components/connection-status-dot';
import { activeProjectIdForView } from '@renderer/lib/layout/active-project';
import {
  useNavigate,
  useParams,
  useWorkspaceSlots,
} from '@renderer/lib/layout/navigation-provider';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { appState, sidebarStore } from '@renderer/lib/stores/app-state';
import { Badge } from '@renderer/lib/ui/badge';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@renderer/lib/ui/context-menu';
import { BoundShortcut } from '@renderer/lib/ui/shortcut';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { captureTelemetry } from '@renderer/utils/telemetryClient';
import { cn } from '@renderer/utils/utils';
import type { ConnectionState } from '@shared/core/ssh/ssh';
import {
  SidebarItemMiniButton,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuRow,
} from './sidebar-primitives';

const UNREGISTERED_PHASE_LABEL: Record<UnregisteredProject['phase'], string> = {
  'creating-repo': 'Creating repository…',
  cloning: 'Cloning…',
  registering: 'Registering…',
  error: 'Failed',
};

export const SidebarProjectItem = observer(function SidebarProjectItem({
  projectId,
}: {
  projectId: string;
}) {
  const { navigate } = useNavigate();
  const { currentView } = useWorkspaceSlots();
  const { params: projectParams } = useParams('project');
  const { params: taskParams } = useParams('task');
  const { params: boardParams } = useParams('board');
  const showCreateTaskModal = useShowModal('taskModal');
  const showChangeConnectionModal = useShowModal('changeProjectConnectionModal');
  const confirmDeleteProject = useConfirmDeleteProject();

  const project = getProjectStore(projectId);

  const prefetchRepository = useCallback(() => {
    const repo = getGitRepositoryStore(projectId);
    void repo?.localData.load();
    void repo?.remoteData.load();
  }, [projectId]);

  // `board` resolves here too — opening a project's board keeps its sidebar
  // project row looking active, same as opening its task list.
  const currentProjectId = activeProjectIdForView(currentView, {
    task: taskParams.projectId,
    project: projectParams.projectId,
    board: boardParams.projectId,
  });
  const currentTaskId = currentView === 'task' ? taskParams.taskId : null;

  const isProjectActive = currentProjectId === projectId && !currentTaskId;

  // Attention count: `taskNeedsAttention` (board-attention.ts) is the single
  // shared predicate the board's own Needs Attention filter also uses, so
  // this count never promises more than opening the board would actually
  // show. Hidden Tasks (ticket #87) are sidebar-only view state — a task
  // hidden from the sidebar must not inflate the badge, exactly as it no
  // longer renders a sidebar row. Surfaces on the project row — the project
  // row itself is the sidebar's canonical entry point to the board.
  const manager = getTaskManagerStore(projectId);
  const hiddenIds = new Set(sidebarStore.hiddenTaskIdsByProject[projectId] ?? []);
  let attentionCount = 0;
  if (manager) {
    for (const [taskId, task] of manager.tasks) {
      if (hiddenIds.has(taskId)) continue;
      if (taskNeedsAttention(task)) attentionCount++;
    }
  }

  useEffect(() => {
    if (isProjectActive) prefetchRepository();
  }, [isProjectActive, prefetchRepository]);

  const isExpanded = sidebarStore.expandedProjectIds.has(projectId);

  if (!project) return null;

  const sshConnectionId = project.data?.type === 'ssh' ? project.data.connectionId : null;
  const isSshProject = sshConnectionId !== null;
  const sshConnectionState = sshConnectionId
    ? appState.sshConnections.stateFor(sshConnectionId)
    : null;
  const displayedSshConnectionState: ConnectionState | null =
    isUnmountedProject(project) &&
    project.errorCode === 'ssh-disconnected' &&
    sshConnectionState !== 'connected'
      ? 'disconnected'
      : sshConnectionState;
  const canReconnect = sshConnectionState !== 'connected';
  const ProjectIcon = isSshProject ? FolderInput : FolderClosed;
  const projectLabel = project.name ?? 'project';
  // Clicking a project opens its Feature Board directly — the board no longer
  // has a dedicated sidebar row of its own.
  const openProject = () => {
    captureTelemetry('board_opened', { source: 'sidebar', project_id: projectId });
    navigate('board', { projectId });
  };

  const renderSpinnerWithTooltip = () => {
    if (!isUnregisteredProject(project)) return null;
    const label = UNREGISTERED_PHASE_LABEL[project.phase] ?? 'Loading…';
    return (
      <Tooltip>
        <TooltipTrigger>
          <SidebarItemMiniButton type="button" disabled aria-label="Loading">
            <Loader2 className="h-4 w-4 animate-spin text-foreground/60" />
          </SidebarItemMiniButton>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    );
  };

  return (
    <ContextMenu>
      <ContextMenuTrigger>
        <SidebarMenuRow
          className={cn('group/row h-8 justify-between flex px-1')}
          data-active={isProjectActive || undefined}
          isActive={isProjectActive}
          onMouseDown={(e) => e.preventDefault()}
          onClick={openProject}
        >
          <div className="flex min-w-0 flex-1 items-center gap-1">
            {project.state === 'unregistered' ? (
              renderSpinnerWithTooltip()
            ) : (
              <SidebarItemMiniButton
                type="button"
                aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${projectLabel}`}
                className="relative"
                onClick={(e) => {
                  e.stopPropagation();
                  sidebarStore.toggleProjectExpanded(projectId);
                }}
              >
                <ProjectIcon className="absolute h-4 w-4 opacity-100 transition-opacity duration-150 group-hover/row:opacity-0" />
                <ChevronRight
                  className={cn(
                    'absolute h-4 w-4 transition-all duration-150 opacity-0 group-hover/row:opacity-100',
                    isExpanded && 'rotate-90'
                  )}
                />
              </SidebarItemMiniButton>
            )}
            <SidebarMenuAction
              aria-label={`Open project ${projectLabel}`}
              className={cn(
                'truncate transition-colors select-none',
                projectViewKind(getProjectStore(projectId)) === 'bootstrapping' &&
                  'text-foreground-tertiary-passive'
              )}
            >
              {isSshProject ? (
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate">{project.name}</span>
                  <ConnectionStatusDot state={displayedSshConnectionState} />
                </span>
              ) : (
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate">{project.name}</span>
                  {projectViewKind(project) === 'path_not_found' && (
                    <Tooltip>
                      <TooltipTrigger>
                        <TriangleAlert className="h-3.5 w-3.5 shrink-0 text-foreground-destructive" />
                      </TooltipTrigger>
                      <TooltipContent>Project not found at path</TooltipContent>
                    </Tooltip>
                  )}
                </span>
              )}
            </SidebarMenuAction>
          </div>
          {attentionCount > 0 && (
            <Badge
              variant="secondary"
              className="shrink-0"
              aria-label={`${attentionCount} task${attentionCount === 1 ? '' : 's'} need attention`}
            >
              {attentionCount}
            </Badge>
          )}
          <Tooltip>
            <TooltipTrigger
              className="h-6"
              render={
                <SidebarItemMiniButton
                  type="button"
                  aria-label={`New task for ${projectLabel}`}
                  className={
                    'opacity-0 transition-opacity duration-150 group-hover/row:opacity-100'
                  }
                  onPointerEnter={() => prefetchRepository()}
                  onClick={(e) => {
                    e.stopPropagation();
                    showCreateTaskModal({ projectId });
                  }}
                  disabled={project.state === 'unregistered'}
                >
                  <Plus className="h-4 w-4" />
                </SidebarItemMiniButton>
              }
            />
            <TooltipContent>
              New Task
              <BoundShortcut settingsKey="newTask" variant="keycaps" />
            </TooltipContent>
          </Tooltip>
        </SidebarMenuRow>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {sshConnectionId && (
          <>
            <ContextMenuItem
              disabled={!canReconnect}
              onClick={() => {
                void appState.sshConnections.connect(sshConnectionId).catch(() => {});
              }}
            >
              <RotateCcw className="size-4" />
              Reconnect
            </ContextMenuItem>
            <ContextMenuItem
              onClick={() => {
                showChangeConnectionModal({
                  projectId,
                  currentConnectionId: sshConnectionId,
                });
              }}
            >
              <CableIcon className="size-4" />
              Change SSH Connection
            </ContextMenuItem>
            <ContextMenuSeparator />
          </>
        )}
        <ContextMenuItem
          variant="destructive"
          onClick={() => {
            void confirmDeleteProject({
              projectId,
              projectLabel: project.name ?? 'this project',
              onDeleted: () => {
                if (isProjectActive) navigate('home');
              },
            });
          }}
        >
          <Trash2 className="size-4" />
          Remove Project
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
});

interface BaseProjectItemProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  isActive: boolean;
}

export function BaseProjectItem({ isActive, className, ...props }: BaseProjectItemProps) {
  return (
    <SidebarMenuButton
      className={cn('justify-between flex item px-1 py-1', className)}
      isActive={isActive}
      {...props}
    />
  );
}
