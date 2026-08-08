import {
  closestCenter,
  DndContext,
  DragOverlay,
  MeasuringStrategy,
  PointerSensor,
  pointerWithin,
  useDndContext,
  useSensor,
  useSensors,
  type ClientRect,
  type CollisionDetection,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
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
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
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
  const initialPointerYRef = useRef<number | null>(null);
  const dragPointerYRef = useRef<number | null>(null);
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  const [dragPointerY, setDragPointerY] = useState<number | null>(null);

  // The project-card port of the old row drags (ticket #123): the same
  // PointerSensor distance-6 activation the project rows used, so a plain
  // click never starts a drag (header click keeps opening the board) and a
  // real drag never trips the click.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

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
      : container.querySelector<HTMLElement>(`[data-sidebar-project-id="${targetProjectId}"]`);
    target?.scrollIntoView({ block: 'nearest' });
  }, [
    currentView,
    taskParams.projectId,
    taskParams.taskId,
    projectParams.projectId,
    boardParams.projectId,
    activeTaskProjectExpanded,
  ]);

  const cards = buildProjectCards({
    rows,
    signalByTaskId: collectSignals(),
    attentionTaskIds: collectAttentionTaskIds(),
    collapsedTaskIdsByProjectId: collapsedProjectTaskRefs(),
  });

  // Only the card headers are sortable (spec #120: task rows stay
  // non-sortable — task order is Board Rank driven since spec #85) and every
  // card is a droppable node, so the sortable id list is exactly the cards.
  const allDndIds = useMemo(() => cards.map((card) => toProjectDndId(card.projectId)), [cards]);

  if (sidebarStore.isEmpty) {
    return <SidebarEmptyState />;
  }

  function setCurrentDragPointerY(pointerY: number | null) {
    dragPointerYRef.current = pointerY;
    setDragPointerY(pointerY);
  }

  function handleDragStart(event: DragStartEvent) {
    const pointerY = getEventClientY(event.activatorEvent);
    initialPointerYRef.current = pointerY;
    setActiveDragId(String(event.active.id));
    setCurrentDragPointerY(pointerY);
  }

  function handleDragMove(event: DragMoveEvent) {
    const initialPointerY = initialPointerYRef.current;
    if (initialPointerY === null) return;
    setCurrentDragPointerY(initialPointerY + event.delta.y);
  }

  function clearDragPointerY() {
    initialPointerYRef.current = null;
    setActiveDragId(null);
    setCurrentDragPointerY(null);
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    const pointerY = dragPointerYRef.current;
    clearDragPointerY();
    if (!over || active.id === over.id) return;
    const activeProjectId = parseDndId(String(active.id));
    const overProjectId = parseDndId(String(over.id));
    if (!activeProjectId || !overProjectId) return;

    const oldIdx = cards.findIndex((card) => card.projectId === activeProjectId);
    const overIdx = cards.findIndex((card) => card.projectId === overProjectId);
    if (oldIdx === -1 || overIdx === -1) return;

    // The same drop math as the old project rows (ticket #123 port): the
    // destination slot is the over card's position, above or below per the
    // pointer, and the persisted order is the store's existing
    // `setProjectOrder` — one reorder source, snapshot-persisted (ADR 0006).
    const isAbove = isCursorAbove(pointerY, active.rect.current.translated, over.rect);
    let newIdx = isAbove ? overIdx : overIdx + 1;
    if (newIdx > oldIdx) newIdx -= 1;
    if (newIdx === oldIdx) return;
    sidebarStore.setProjectOrder(arrayMove(cards.map((card) => card.projectId), oldIdx, newIdx));
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={cardCollision}
      measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
      autoScroll={{ threshold: { x: 0, y: 0.18 }, acceleration: 8, interval: 5 }}
      onDragStart={handleDragStart}
      onDragMove={handleDragMove}
      onDragEnd={handleDragEnd}
      onDragCancel={clearDragPointerY}
    >
      <SortableContext items={allDndIds} strategy={verticalListSortingStrategy}>
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-2 pt-1 pb-3">
          <div className="space-y-2">
            {cards.map((card) => (
              <SidebarProjectCard key={card.projectId} card={card} />
            ))}
          </div>
        </div>
      </SortableContext>
      <DragOverlay dropAnimation={null}>
        {activeDragId ? <CardDragOverlayContent projectId={parseDndId(activeDragId) ?? ''} /> : null}
      </DragOverlay>
      <InsertionIndicator pointerY={dragPointerY} />
    </DndContext>
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

  // The card is the sortable node; only its header carries the drag handle
  // (the pointer listeners), so a drag can only start from the header —
  // never from a nested task row or the chevron (which stops pointerdown
  // propagation itself) — while header clicks keep their click-to-board
  // navigation: the distance-6 activation never fires for a plain click.
  const { setNodeRef, transform, transition, isDragging, listeners } = useSortable({
    id: toProjectDndId(projectId),
  });

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
      ref={setNodeRef}
      className="overflow-hidden rounded-xl border border-border/60 bg-background-tertiary-1/40"
      data-sidebar-project-id={projectId}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.4 : 1,
        zIndex: isDragging ? 1 : 'auto',
      }}
    >
      <ContextMenu>
        <ContextMenuTrigger>
          <SidebarMenuRow
            {...listeners}
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
            <SidebarMenuAction aria-label={`Open project ${projectLabel}`} className="gap-1.5">
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
        <div className="mr-1.5 ml-[18px] border-l-2 pb-1.5 pl-3" style={{ borderColor: hue.rail }}>
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
              <SidebarTaskItem projectId={task.projectId} taskId={task.taskId} rowVariant="card" />
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

const PROJECT_DND_PREFIX = 'proj::';

const toProjectDndId = (projectId: string) => `${PROJECT_DND_PREFIX}${projectId}`;

/**
 * The project id behind a card dnd id, or `null` for anything else. Only
 * cards are sortable (spec #120: task rows are non-sortable), so a non-
 * project id can only be a stale event.
 */
function parseDndId(id: string): string | null {
  return id.startsWith(PROJECT_DND_PREFIX) ? id.slice(PROJECT_DND_PREFIX.length) : null;
}

/**
 * Card drags consider every card container except the active one (dnd-kit's
 * own convention: an item is never a drop target for itself). The pointer's
 * card wins when the pointer is inside one, the nearest card otherwise —
 * the old row collision shape, with nothing to filter (no task droppables
 * in the card list).
 */
const cardCollision: CollisionDetection = (args) => {
  const activeId = String(args.active.id);
  const containers = args.droppableContainers.filter((c) => String(c.id) !== activeId);
  const filteredArgs = { ...args, droppableContainers: containers };
  const pointerCollisions = pointerWithin(filteredArgs);
  return pointerCollisions.length > 0 ? pointerCollisions : closestCenter(filteredArgs);
};

function getEventClientY(event: Event): number | null {
  if ('clientY' in event && typeof event.clientY === 'number') return event.clientY;
  if (typeof TouchEvent !== 'undefined' && event instanceof TouchEvent) {
    const touch = event.touches[0] ?? event.changedTouches[0];
    return touch?.clientY ?? null;
  }
  return null;
}

function isCursorAbove(
  pointerY: number | null,
  translated: ClientRect | null,
  overRect: ClientRect
): boolean {
  if (pointerY !== null) return pointerY < overRect.top + overRect.height / 2;
  if (!translated) return true;
  const cursorY = translated.top + translated.height / 2;
  const overCenterY = overRect.top + overRect.height / 2;
  return cursorY < overCenterY;
}

/**
 * The drag overlay (ticket #123): a compact replica of the dragged card's
 * header — identity chip and name on the project hue — portaled by dnd-kit
 * to the body while the source card dims in place (opacity 0.4), exactly
 * like the old row drags. Rendered statically: the overlay must not carry
 * live handlers.
 */
function CardDragOverlayContent({ projectId }: { projectId: string }) {
  const project = getProjectStore(projectId);
  if (!project) return null;
  const projectLabel = project.name ?? 'project';
  const hue = projectHue(projectId);
  return (
    <div className="rounded-xl border border-border/60 bg-background-tertiary-1 shadow-md">
      <div className="flex h-9 items-center gap-2 px-2">
        <span
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-[11px] font-bold"
          style={{ backgroundColor: hue.chipBg, color: hue.fg }}
        >
          {(projectLabel[0] ?? '?').toUpperCase()}
        </span>
        <span className="min-w-0 truncate text-left font-semibold select-none">
          {projectLabel}
        </span>
      </div>
    </div>
  );
}

/**
 * The insertion line between cards (spec #120, ticket #123): drawn at the
 * over card's top edge when the pointer is above its midline, at its bottom
 * edge otherwise — i.e. always in the gap between cards, never over one.
 */
function InsertionIndicator({ pointerY }: { pointerY: number | null }) {
  const { active, over } = useDndContext();
  if (!active || !over || active.id === over.id) return null;
  if (parseDndId(String(active.id)) === null || parseDndId(String(over.id)) === null) return null;
  const overRect = over.rect;
  if (!overRect) return null;
  const isAbove = isCursorAbove(pointerY, active.rect.current.translated, overRect);
  const top = isAbove ? overRect.top : overRect.top + overRect.height;
  return createPortal(
    <div
      className="bg-primary"
      style={{
        position: 'fixed',
        left: overRect.left + 8,
        top: top - 1.5,
        width: Math.max(0, overRect.width - 16),
        height: 3,
        borderRadius: 2,
        pointerEvents: 'none',
        zIndex: 9999,
      }}
    />,
    document.body
  );
}
