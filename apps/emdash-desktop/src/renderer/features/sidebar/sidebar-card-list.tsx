import {
  CableIcon,
  ChevronRight,
  FolderClosed,
  Loader2,
  RotateCcw,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { observer } from 'mobx-react-lite';
import React, { useCallback, useEffect, useRef } from 'react';
import { taskNeedsAttention } from '@renderer/features/board/board-attention';
import { useConfirmDeleteProject } from '@renderer/features/projects/hooks/use-confirm-delete-project';
import {
  isUnmountedProject,
  isUnregisteredProject,
  type UnregisteredProject,
} from '@renderer/features/projects/stores/project';
import {
  getGitRepositoryStore,
  getProjectStore,
  projectViewKind,
} from '@renderer/features/projects/stores/project-selectors';
import { getTaskManagerStore, getTaskStore } from '@renderer/features/tasks/stores/task-selectors';
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
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { captureTelemetry } from '@renderer/utils/telemetryClient';
import { cn } from '@renderer/utils/utils';
import type { ConnectionState } from '@shared/core/ssh/ssh';
import {
  buildProjectCards,
  projectHue,
  type SidebarCardModel,
  type SidebarSignal,
} from './project-card-model';
import { SidebarItemMiniButton, SidebarMenuAction, SidebarMenuRow } from './sidebar-primitives';
import { SidebarSignalDot, taskSidebarSignal } from './sidebar-signal-dot';
import { SidebarStageGroupItem } from './stage-group-item';
import { SidebarTaskItem } from './task-item';

const UNREGISTERED_PHASE_LABEL: Record<UnregisteredProject['phase'], string> = {
  'creating-repo': 'Creating repository…',
  cloning: 'Cloning…',
  registering: 'Registering…',
  error: 'Failed',
};

/** The active card/task tint (spec #120 US15): jade, both themes, never hardcoded. */
const JADE_ACTIVE_BACKGROUND = 'color-mix(in srgb, var(--jade-9) 8%, transparent)';

/**
 * The grouped project-card list (spec #120, ticket #122): replaces the flat
 * virtualized row stream. One bordered card per project — identity chip on
 * the project hue, name, SSH dot, aggregate live signal, attention chip,
 * task count and collapse chevron on the header; the expanded card nests
 * the project's Stage Groups and task rows under a project-hued left rail.
 *
 * The card is a computed projection of the existing row stream
 * (`buildProjectCards`, ticket #121 — no new store state, ADR 0006). The
 * per-task lookups (live signal, Needs Attention) and the collapsed-project
 * task refs are wired here from the stores, exactly the seams the pure
 * module documents.
 *
 * Non-virtualized by design: card count is bounded by project count (spec
 * #120 Implementation Decisions). Task rows keep their 32px height and the
 * existing row primitives.
 */
export const SidebarCardList = observer(function SidebarCardList() {
  const rows = sidebarStore.sidebarRows;
  const { currentView } = useWorkspaceSlots();
  const { params: taskParams } = useParams('task');
  const { params: projectParams } = useParams('project');
  const { params: boardParams } = useParams('board');
  const scrollRef = useRef<HTMLDivElement>(null);

  const activeTaskProjectExpanded =
    currentView === 'task' && taskParams.projectId
      ? sidebarStore.expandedProjectIds.has(taskParams.projectId)
      : null;

  // Expand the parent project when navigating to a task (not when `rows`
  // changes — otherwise collapsing while staying on that task would
  // immediately re-expand). Same guarantee as the old flat list.
  useEffect(() => {
    if (currentView !== 'task') return;
    const targetProjectId = taskParams.projectId;
    const targetTaskId = taskParams.taskId;
    if (!targetProjectId || !targetTaskId) return;
    const activeTask = getTaskStore(targetProjectId, targetTaskId);
    if (activeTask?.data.isPinned) return;
    sidebarStore.ensureProjectExpanded(targetProjectId);
  }, [currentView, taskParams.projectId, taskParams.taskId]);

  // Same expansion guarantee for the board: opening a board keeps its parent
  // project expanded, not just active.
  useEffect(() => {
    if (currentView !== 'board') return;
    const targetProjectId = boardParams.projectId;
    if (!targetProjectId) return;
    sidebarStore.ensureProjectExpanded(targetProjectId);
  }, [currentView, boardParams.projectId]);

  // Scroll the active project card (or task row) into view only when the
  // navigation target itself changes, plus the active task's project
  // expansion state. Re-running on every `rows` change would yank the user
  // back to the active row whenever the sidebar mutates.
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  useEffect(() => {
    const targetProjectId = activeProjectIdForView(currentView, {
      task: taskParams.projectId,
      project: projectParams.projectId,
      board: boardParams.projectId,
    });
    const targetTaskId = currentView === 'task' ? (taskParams.taskId ?? null) : null;
    if (!targetProjectId) return;
    if (targetTaskId) {
      const activeTask = getTaskStore(targetProjectId, targetTaskId);
      if (activeTask?.data.isPinned) return;
    }
    const container = scrollRef.current;
    if (!container) return;
    const target = targetTaskId
      ? container.querySelector<HTMLElement>(`[data-sidebar-task-id="${targetTaskId}"]`)
      : container.querySelector<HTMLElement>(
          `[data-sidebar-project-id="${targetProjectId}"]`
        );
    target?.scrollIntoView({ block: 'nearest' });
  }, [
    currentView,
    taskParams.projectId,
    taskParams.taskId,
    projectParams.projectId,
    boardParams.projectId,
    activeTaskProjectExpanded,
  ]);

  if (sidebarStore.isEmpty) {
    return <SidebarEmptyState />;
  }

  const cards = buildProjectCards({
    rows,
    signalByTaskId: collectSignals(),
    attentionTaskIds: collectAttentionTaskIds(),
    collapsedTaskIdsByProjectId: collapsedProjectTaskRefs(),
  });

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-2 pt-1 pb-3">
      <div className="space-y-2">
        {cards.map((card) => (
          <SidebarProjectCard key={card.projectId} card={card} />
        ))}
      </div>
    </div>
  );
});

/**
 * The per-task live signal lookup the card model folds (ticket #121 seam):
 * `taskSidebarSignal` — the same predicate the task rows' own dots render —
 * applied once per task of every project, keyed by task id.
 */
function collectSignals(): Map<string, SidebarSignal | null> {
  const signals = new Map<string, SidebarSignal | null>();
  for (const project of sidebarStore.orderedProjects) {
    const manager = getTaskManagerStore(project.id);
    if (!manager) continue;
    for (const task of manager.tasks.values()) {
      const signal = taskSidebarSignal(task);
      if (signal !== null) signals.set(task.data.id, signal);
    }
  }
  return signals;
}

/**
 * The Needs Attention task ids for the card headers (spec #120 US6): the
 * shared `taskNeedsAttention` predicate (board-attention.ts) — the same one
 * the board's own Needs Attention filter and the old project-row badge
 * applied — applied once per task. Hidden Tasks (ticket #87) are
 * sidebar-only view state: the row stream never carries them and the
 * collapsed-project refs exclude them, so membership never matches their
 * ids; they are skipped here too so the set is exactly the sidebar's view.
 */
function collectAttentionTaskIds(): Set<string> {
  const attention = new Set<string>();
  for (const project of sidebarStore.orderedProjects) {
    const manager = getTaskManagerStore(project.id);
    if (!manager) continue;
    const hiddenIds = new Set(sidebarStore.hiddenTaskIdsByProject[project.id] ?? []);
    for (const task of manager.tasks.values()) {
      if (hiddenIds.has(task.data.id)) continue;
      if (taskNeedsAttention(task)) attention.add(task.data.id);
    }
  }
  return attention;
}

/**
 * The collapsed-project seam (spec #120 US4-6, ticket #121 review): a
 * collapsed project's stream row is only the `project` row, so the card
 * model folds these refs into the header aggregates — the same visible task
 * id list the store feeds `buildStageGroupedRows`
 * (`visibleTaskIdsForProject`), so the header of a collapsed card still
 * shows how many tasks the project contains, its aggregate live signal and
 * its attention count.
 */
function collapsedProjectTaskRefs(): Map<string, readonly string[]> {
  const refs = new Map<string, readonly string[]>();
  for (const project of sidebarStore.orderedProjects) {
    if (sidebarStore.expandedProjectIds.has(project.id)) continue;
    refs.set(project.id, sidebarStore.visibleTaskIdsForProject(project.id));
  }
  return refs;
}

function SidebarEmptyState() {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 px-4 py-8 text-center">
      <FolderClosed className="size-5 text-foreground-tertiary-passive" />
      <p className="text-xs text-foreground-tertiary-passive">
        No projects yet — use the + button to add one.
      </p>
    </div>
  );
}

/**
 * One project card (spec #120): the bordered card with the identity chip,
 * name, SSH dot, aggregate signal, attention chip, task count and collapse
 * chevron on the header, and — when expanded — the Stage Groups and task
 * rows nested under the project-hued left rail. Header click opens the
 * Feature Board (the same navigation the project row had); only the chevron
 * toggles expand/collapse, so the two never conflict (deliberate prototype
 * fix).
 */
const SidebarProjectCard = observer(function SidebarProjectCard({
  card,
}: {
  card: SidebarCardModel;
}) {
  const { projectId } = card;
  const { navigate } = useNavigate();
  const { currentView } = useWorkspaceSlots();
  const { params: projectParams } = useParams('project');
  const { params: taskParams } = useParams('task');
  const { params: boardParams } = useParams('board');
  const showChangeConnectionModal = useShowModal('changeProjectConnectionModal');
  const confirmDeleteProject = useConfirmDeleteProject();

  const project = getProjectStore(projectId);
  const hue = projectHue(projectId);
  const isExpanded = sidebarStore.expandedProjectIds.has(projectId);

  // `board` resolves here too — opening a project's board keeps its card
  // looking active, same as opening its task list.
  const currentProjectId = activeProjectIdForView(currentView, {
    task: taskParams.projectId,
    project: projectParams.projectId,
    board: boardParams.projectId,
  });
  const isProjectActive = currentProjectId === projectId && currentView !== 'task';

  const prefetchRepository = useCallback(() => {
    const repo = getGitRepositoryStore(projectId);
    void repo?.localData.load();
    void repo?.remoteData.load();
  }, [projectId]);

  useEffect(() => {
    if (isProjectActive) prefetchRepository();
  }, [isProjectActive, prefetchRepository]);

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
  const projectLabel = project.name ?? 'project';

  // Clicking the card header opens the project's Feature Board directly —
  // the same navigation the project row had (spec #120 US7); only the
  // chevron toggles expand/collapse (US8).
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
    <div
      className="overflow-hidden rounded-xl border border-border/60 bg-background-tertiary-1/40"
      data-sidebar-project-id={projectId}
    >
      <ContextMenu>
        <ContextMenuTrigger>
          <SidebarMenuRow
            className="group/row h-9 cursor-pointer justify-between gap-2 px-2"
            isActive={isProjectActive}
            style={isProjectActive ? { backgroundColor: JADE_ACTIVE_BACKGROUND } : undefined}
            onMouseDown={(e) => e.preventDefault()}
            onClick={openProject}
          >
            <span
              className="flex size-6 shrink-0 items-center justify-center rounded-md text-[11px] font-bold"
              style={{ backgroundColor: hue.chipBg, color: hue.fg }}
            >
              {(projectLabel[0] ?? '?').toUpperCase()}
            </span>
            <SidebarMenuAction
              aria-label={`Open project ${projectLabel}`}
              className="gap-1.5"
            >
              <span
                className={cn(
                  'min-w-0 truncate text-left font-semibold transition-colors select-none',
                  isProjectActive && 'text-[var(--jade-11)]',
                  projectViewKind(project) === 'bootstrapping' &&
                    !isProjectActive &&
                    'text-foreground-tertiary-passive'
                )}
              >
                {projectLabel}
              </span>
              {isSshProject ? (
                <ConnectionStatusDot state={displayedSshConnectionState} />
              ) : (
                projectViewKind(project) === 'path_not_found' && (
                  <Tooltip>
                    <TooltipTrigger>
                      <TriangleAlert className="size-3.5 shrink-0 text-foreground-destructive" />
                    </TooltipTrigger>
                    <TooltipContent>Project not found at path</TooltipContent>
                  </Tooltip>
                )
              )}
            </SidebarMenuAction>
            {isUnregisteredProject(project) ? (
              renderSpinnerWithTooltip()
            ) : (
              <>
                <SidebarSignalDot signal={card.aggregateSignal} />
                {card.attentionCount > 0 && (
                  <Badge
                    variant="secondary"
                    className="shrink-0"
                    aria-label={`${card.attentionCount} task${
                      card.attentionCount === 1 ? '' : 's'
                    } need attention`}
                  >
                    {card.attentionCount}
                  </Badge>
                )}
                {card.visibleTaskCount > 0 && (
                  <span
                    className="shrink-0 rounded-full bg-background-tertiary-2 px-1.5 text-[10px] font-medium text-foreground-tertiary-passive tabular-nums"
                    aria-label={`${card.visibleTaskCount} task${
                      card.visibleTaskCount === 1 ? '' : 's'
                    }`}
                  >
                    {card.visibleTaskCount}
                  </span>
                )}
                <SidebarItemMiniButton
                  type="button"
                  aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${projectLabel}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    sidebarStore.toggleProjectExpanded(projectId);
                  }}
                >
                  <ChevronRight
                    className={cn(
                      'size-4 transition-transform duration-150',
                      isExpanded && 'rotate-90'
                    )}
                  />
                </SidebarItemMiniButton>
              </>
            )}
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
                projectLabel,
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
      {isExpanded && (
        <div
          className="mr-1.5 ml-[18px] border-l-2 pb-1.5 pl-3"
          style={{ borderColor: hue.rail }}
        >
          {card.stageGroups.map((group) => (
            <SidebarStageGroupItem
              key={group.stage}
              projectId={projectId}
              stage={group.stage}
              label={group.label}
              count={group.count}
              className="pl-1"
            />
          ))}
          {card.tasks.map((task) => (
            <div key={task.taskId} data-sidebar-task-id={task.taskId}>
              <SidebarTaskItem
                projectId={task.projectId}
                taskId={task.taskId}
                rowVariant="card"
              />
            </div>
          ))}
          {card.stageGroups.length === 0 && card.tasks.length === 0 && (
            <p className="px-1 py-2 text-[11px] text-foreground-tertiary-passive">
              No tasks yet — add one from the project.
            </p>
          )}
        </div>
      )}
    </div>
  );
});
