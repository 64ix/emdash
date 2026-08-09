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
  Plus,
  RotateCcw,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { computed } from 'mobx';
import { observer } from 'mobx-react-lite';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { taskNeedsAttention } from '@renderer/features/board/board-attention';
import { isBoardRankCandidate } from '@renderer/features/board/board-columns';
import { sortColumn, type ColumnId } from '@renderer/features/board/board-ordering';
import { useConfirmDeleteProject } from '@renderer/features/projects/hooks/use-confirm-delete-project';
import {
  isUnmountedProject,
  isUnregisteredProject,
  type ProjectStore,
  type UnregisteredProject,
} from '@renderer/features/projects/stores/project';
import {
  getGitRepositoryStore,
  getProjectStore,
  projectViewKind,
} from '@renderer/features/projects/stores/project-selectors';
import {
  getTaskGitWorktreeStore,
  getTaskManagerStore,
  getTaskStore,
} from '@renderer/features/tasks/stores/task-selectors';
import { registeredTaskData } from '@renderer/features/tasks/stores/task-store';
import { ConnectionStatusDot } from '@renderer/lib/components/connection-status-dot';
import { useToast } from '@renderer/lib/hooks/use-toast';
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
import type { WorkflowStage } from '@shared/core/tasks/tasks';
import {
  buildProjectCards,
  projectHue,
  type SidebarCardModel,
  type SidebarSignal,
} from './project-card-model';
import {
  SidebarItemMiniButton,
  JADE_ACTIVE_BACKGROUND,
  SidebarMenuAction,
  SidebarMenuRow,
} from './sidebar-primitives';
import { SidebarSignalDot, taskSidebarSignal } from './sidebar-signal-dot';
import { SidebarStageGroupItem } from './stage-group-item';
import { computeSidebarDropPosition, sidebarStageMoveOptions } from './stage-group-row-model';
import { SidebarTaskItem } from './task-item';

const UNREGISTERED_PHASE_LABEL: Record<UnregisteredProject['phase'], string> = {
  'creating-repo': 'Creating repository…',
  cloning: 'Cloning…',
  registering: 'Registering…',
  error: 'Failed',
};

/**
 * The grouped project-card list (spec #120, ticket #122): replaces the flat
 * virtualized row stream. One bordered card per project — identity chip on
 * the project hue, name, SSH dot, aggregate live signal, attention chip,
 * hover New Task button and collapse chevron on the header; the expanded
 * card nests the project's Stage Groups and task rows under a project-hued
 * left rail, with tasks rendering inside their own group.
 *
 * The card is a computed projection of the existing row stream
 * (`buildProjectCards`, ticket #121 — no new store state, ADR 0006), derived
 * in one MobX computed so drag-state re-renders never re-derive it. The
 * per-task lookups (live signal, Needs Attention) and the collapsed-project
 * task refs are wired here from the stores, exactly the seams the pure
 * module documents. Task drag-reorder between and within Stage Groups
 * (spec #85 ticket #89) writes the board's stage/rank fields through
 * `updateBoardPosition`, gated by the board's own authority.
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
  const { toast } = useToast();

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

  // The card derivation is one MobX computed (spec #120 "no new store
  // state"): the signal/attention lookups and the collapsed-project row
  // derivation all read observables, so the computed invalidates exactly
  // when the underlying task/project/expand data changes — and NOT on
  // unrelated re-renders (drag state updates on every pointer move would
  // otherwise re-derive every project's rows per frame).
  const cardsComputed = useMemo(
    () =>
      computed(() =>
        buildProjectCards({
          rows: sidebarStore.sidebarRows,
          signalByTaskId: collectSignals(),
          attentionTaskIdsByProject: collectAttentionTaskIdsByProject(),
          headerTaskIdsByProjectId: headerTaskRefs(),
        })
      ),
    []
  );
  const cards = cardsComputed.get();

  // Sortable id list: every card header (project reorder, ticket #123) and
  // every task row (task drag-reorder between and within Stage Groups,
  // spec #85 ticket #89 — restored on the cards). Stage Group headers stay
  // fixed anchors, never sortable.
  const allDndIds = useMemo(
    () =>
      cards.flatMap((card) => [
        toProjectDndId(card.projectId),
        ...card.tasks.map((task) => toTaskDndId(task.projectId, task.taskId)),
      ]),
    [cards]
  );

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
    const activeParsed = parseDndId(String(active.id));
    const overParsed = parseDndId(String(over.id));
    if (!activeParsed || !overParsed) return;

    if (activeParsed.kind === 'project') {
      handleProjectDrop(activeParsed.projectId, overParsed.projectId, pointerY, active, over);
      return;
    }
    handleTaskDrop(activeParsed, overParsed, pointerY, active, over);
  }

  function handleProjectDrop(
    activeProjectId: string,
    overProjectId: string,
    pointerY: number | null,
    active: DragEndEvent['active'],
    over: DragEndEvent['over']
  ) {
    const overCardIdx = cards.findIndex((card) => card.projectId === overProjectId);
    if (overCardIdx === -1) return;

    // The same drop math as the old project rows (ticket #123 port): the
    // destination slot is the over card's position, above or below per the
    // pointer, and the persisted order is the store's existing
    // `setProjectOrder` — one reorder source, snapshot-persisted (ADR 0006).
    const isAbove = isCursorAbove(pointerY, active.rect.current.translated, over.rect);
    let newIdx = isAbove ? overCardIdx : overCardIdx + 1;
    const ids = sidebarStore.orderedProjects.map((p) => p.id).filter(Boolean);
    const oldIdx = ids.indexOf(activeProjectId);
    if (oldIdx === -1) return;
    if (newIdx > oldIdx) newIdx -= 1;
    if (newIdx === oldIdx) return;
    sidebarStore.setProjectOrder(arrayMove(ids, oldIdx, newIdx));
  }

  function handleTaskDrop(
    activeParsed: Extract<SidebarDndId, { kind: 'task' }>,
    overParsed: Extract<SidebarDndId, { kind: 'task' }>,
    pointerY: number | null,
    active: DragEndEvent['active'],
    over: DragEndEvent['over']
  ) {
    // Task drags (spec #85, ticket #89, restored on the cards): grouped mode
    // writes the board's stage and Board Rank fields through
    // `updateBoardPosition` — the same path the Feature Board and the "Move
    // to stage…" menu use (ADR 0006).
    if (overParsed.projectId !== activeParsed.projectId) return;
    const projectId = activeParsed.projectId;
    const card = cards.find((c) => c.projectId === projectId);
    if (!card) return;
    const task = getTaskStore(projectId, activeParsed.taskId);
    if (!task) return;
    const isAbove = isCursorAbove(pointerY, active.rect.current.translated, over.rect);

    // The destination column: the group whose header precedes the over task
    // in the card body (the row model's own layout), or `unstaged` when no
    // header precedes.
    const destinationColumn: ColumnId = taskBodyStage(card, overParsed.taskId) ?? 'unstaged';
    const destinationStage = destinationColumn === 'unstaged' ? null : destinationColumn;

    // Board authority gating (ADR 0006): only a cross-stage drop can be
    // overwritten by the next sync pass — a same-group drop never changes
    // the stage, exactly like the board's same-column reorder. A blocked
    // destination is rejected with the board's own explanation as feedback.
    const authority = taskDropAuthority(
      projectId,
      activeParsed.taskId,
      taskBodyStage(card, activeParsed.taskId),
      destinationStage
    );
    if (authority.blocked) {
      toast({
        title: 'Stage move blocked',
        description: authority.explanation ?? undefined,
        variant: 'destructive',
      });
      return;
    }

    // The destination's visible task rows in rendered (body) order, dragged
    // task excluded — the drop slot the user aimed at is decided by them.
    const destRows: { taskId: string; rank: string | null }[] = [];
    for (const entry of card.body) {
      if (entry.kind !== 'task') continue;
      if ((taskBodyStage(card, entry.taskId) ?? 'unstaged') !== destinationColumn) continue;
      if (entry.taskId === activeParsed.taskId) continue;
      const destTask = getTaskStore(projectId, entry.taskId);
      const destRegistered = destTask ? registeredTaskData(destTask) : null;
      destRows.push({ taskId: entry.taskId, rank: destRegistered?.boardRank ?? null });
    }

    // Rank math mirrors the board exactly (`computeDropPosition`): the drop
    // index is the over task's position among the destination's
    // `sortColumn`-ordered entries, above or below per the pointer. Dropping
    // below the destination's last rendered row is an unpositioned
    // end-of-group drop — stage-only, `rank: null` (spec user story 16).
    const destSorted = sortColumn(destRows);
    const overSortedIdx = destSorted.findIndex((entry) => entry.taskId === overParsed.taskId);
    if (overSortedIdx === -1) return;
    const overIsLastRendered =
      destRows.length > 0 && destRows[destRows.length - 1]!.taskId === overParsed.taskId;
    const dropIndex: number | null =
      !isAbove && overIsLastRendered ? null : overSortedIdx + (isAbove ? 0 : 1);

    // True (pre-visibility) entries for the rank math — every task holding
    // a Board Rank in the destination column, hidden or Shipped-Faded rows
    // included — so the interpolation never reproduces a card's stored rank
    // the user cannot see (the board's own `trueEntries` guard, ticket #45).
    const trueDestEntries: { id: string; rank: string | null }[] = [];
    const taskManager = getTaskManagerStore(projectId);
    if (taskManager) {
      for (const [, candidate] of taskManager.tasks) {
        const candidateData = registeredTaskData(candidate);
        if (!candidateData || candidateData.id === activeParsed.taskId) continue;
        if (!isBoardRankCandidate(candidateData)) continue;
        if ((candidateData.workflowStage ?? 'unstaged') !== destinationColumn) continue;
        trueDestEntries.push({ id: candidateData.id, rank: candidateData.boardRank ?? null });
      }
    }
    const position = computeSidebarDropPosition(
      destinationColumn,
      destSorted.map((entry) => ({ id: entry.taskId, rank: entry.rank })),
      dropIndex,
      sortColumn(trueDestEntries)
    );
    void task.updateBoardPosition(position.stage, position.rank);
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
        {activeDragId ? <CardDragOverlayContent dndId={activeDragId} /> : null}
      </DragOverlay>
      <InsertionIndicator pointerY={dragPointerY} cards={cards} />
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
 * The Needs Attention task ids per project for the card headers (spec #120
 * US6): the shared `taskNeedsAttention` predicate (board-attention.ts) — the
 * same one the board's own Needs Attention filter and the old project-row
 * badge applied — applied once per task of every project. Matches the old
 * badge's scope: every non-hidden task of the project counts, pinned and
 * automation-run tasks included, because stream membership excludes exactly
 * those and their attention would otherwise vanish from the header. Hidden
 * Tasks (ticket #87) are sidebar-only view state — they never count.
 */
function collectAttentionTaskIdsByProject(): Map<string, Set<string>> {
  const attention = new Map<string, Set<string>>();
  for (const project of sidebarStore.orderedProjects) {
    const manager = getTaskManagerStore(project.id);
    if (!manager) continue;
    const hiddenIds = new Set(sidebarStore.hiddenTaskIdsByProject[project.id] ?? []);
    const projectAttention = new Set<string>();
    for (const task of manager.tasks.values()) {
      if (hiddenIds.has(task.data.id)) continue;
      if (taskNeedsAttention(task)) projectAttention.add(task.data.id);
    }
    if (projectAttention.size > 0) attention.set(project.id, projectAttention);
  }
  return attention;
}

/**
 * The header-fold seam (spec #120 US4-6, ticket #121 review): the task ids
 * the card model folds into the header aggregates beyond its own stream
 * rows — exactly the tasks the row stream omits per project: a collapsed
 * project's displayable tasks (its only stream row is the `project` row)
 * and an expanded project's collapsed-Stage-Group tasks. Derived by
 * `SidebarStore.headerFoldTaskIdsForProject` with the same visibility
 * rules as the stream (archived/pinned/automation/hidden/Shipped-faded
 * excluded), so the header of every card counts and signals over all of
 * the project's displayable tasks, regardless of expand state.
 */
function headerTaskRefs(): Map<string, readonly string[]> {
  const refs = new Map<string, readonly string[]>();
  for (const project of sidebarStore.orderedProjects) {
    const taskIds = sidebarStore.headerFoldTaskIdsForProject(project.id);
    if (taskIds.length > 0) refs.set(project.id, taskIds);
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
 * name, SSH dot, aggregate signal, attention chip, hover New Task button
 * and collapse chevron on the header, and — when expanded — the Stage
 * Groups and task rows nested under the project-hued left rail. Header
 * click opens the Feature Board (the same navigation the project row had);
 * only the chevron toggles expand/collapse, so the two never conflict
 * (deliberate prototype fix).
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
  const showCreateTaskModal = useShowModal('taskModal');
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
            className="group/row h-9 cursor-pointer justify-between gap-1.5 px-2"
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
                <Tooltip>
                  <TooltipTrigger
                    className="h-6"
                    render={
                      <SidebarItemMiniButton
                        type="button"
                        aria-label={`New task for ${projectLabel}`}
                        className="opacity-0 transition-opacity duration-150 group-hover/row:opacity-100"
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
        <div className="ml-[18px] border-l-2 pl-3" style={{ borderColor: hue.rail }}>
          <SidebarCardBody card={card} project={project} />
        </div>
      )}
    </div>
  );
});

/**
 * The card body: the row stream's interleaved order — Unstaged rows first,
 * then each Stage Group header followed by its own tasks (spec #85 grouping
 * preserved inside the card). Task rows inside a group are indented past the
 * group label, so member tasks visibly nest under their category; Unstaged
 * loose rows keep the shallow card indent.
 */
const SidebarCardBody = observer(function SidebarCardBody({
  card,
  project,
}: {
  card: SidebarCardModel;
  project: ProjectStore;
}) {
  const { projectId } = card;
  let inGroup = false;
  return (
    <>
      {card.body.map((entry) => {
        if (entry.kind === 'stage-group') {
          inGroup = true;
          return (
            <SidebarStageGroupItem
              key={`group-${entry.stage}`}
              projectId={projectId}
              stage={entry.stage}
              label={entry.label}
              count={entry.count}
              className="pl-1"
            />
          );
        }
        return (
          <SortableTaskRow key={entry.taskId} projectId={entry.projectId} taskId={entry.taskId}>
            <SidebarTaskItem
              projectId={entry.projectId}
              taskId={entry.taskId}
              rowVariant="card"
              className={inGroup ? 'pl-4' : 'pl-1'}
            />
          </SortableTaskRow>
        );
      })}
      {card.body.length === 0 && <CardEmptyBody project={project} />}
    </>
  );
});

/**
 * The empty-body caption (release fix): "No tasks yet" only when the project
 * genuinely has none — a project whose tasks are all hidden from the
 * sidebar, Shipped-faded or unloaded by a broken connection gets copy that
 * says what actually happened, never "add a task".
 */
function CardEmptyBody({ project }: { project: ProjectStore }) {
  const projectId = project.id;
  const hiddenCount = (sidebarStore.hiddenTaskIdsByProject[projectId] ?? []).length;
  const taskCount = getTaskManagerStore(projectId)?.tasks.size ?? 0;
  let message: string | null = null;
  if (isUnregisteredProject(project)) {
    message = null; // the header's phase spinner already covers this state
  } else if (isUnmountedProject(project)) {
    message = 'Project not connected — reconnect to see its tasks.';
  } else if (hiddenCount > 0) {
    message = 'All tasks are hidden from the sidebar — show them from the project view.';
  } else if (taskCount > 0) {
    message = 'No visible tasks in the sidebar.';
  } else {
    message = 'No tasks yet — add one from the project.';
  }
  if (!message) return null;
  return <p className="px-1 py-2 text-[11px] text-foreground-tertiary-passive">{message}</p>;
}

/**
 * One sortable task row (spec #85 ticket #89 drag-reorder, restored on the
 * cards): the dnd-kit node for a task — same listeners pattern as the card
 * headers, so task rows start their own drags while their click-to-task and
 * context menu keep working (the PointerSensor distance-6 activation never
 * fires for a plain click).
 */
function SortableTaskRow({
  projectId,
  taskId,
  children,
}: {
  projectId: string;
  taskId: string;
  children: React.ReactNode;
}) {
  const { setNodeRef, transform, transition, isDragging, listeners } = useSortable({
    id: toTaskDndId(projectId, taskId),
  });
  return (
    <div
      ref={setNodeRef}
      data-sidebar-task-id={taskId}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.4 : 1,
      }}
      {...listeners}
    >
      {children}
    </div>
  );
}

const PROJECT_DND_PREFIX = 'proj::';
const TASK_DND_PREFIX = 'task::';

const toProjectDndId = (projectId: string) => `${PROJECT_DND_PREFIX}${projectId}`;
const toTaskDndId = (projectId: string, taskId: string) =>
  `${TASK_DND_PREFIX}${projectId}::${taskId}`;

type SidebarDndId =
  | { kind: 'project'; projectId: string }
  | { kind: 'task'; projectId: string; taskId: string };

/** The entity behind a card-list dnd id, or `null` for anything else. */
function parseDndId(id: string): SidebarDndId | null {
  if (id.startsWith(PROJECT_DND_PREFIX)) {
    return { kind: 'project', projectId: id.slice(PROJECT_DND_PREFIX.length) };
  }
  if (id.startsWith(TASK_DND_PREFIX)) {
    const [, projectId, taskId] = id.split('::');
    if (projectId && taskId) return { kind: 'task', projectId, taskId };
  }
  return null;
}

/**
 * The Workflow Stage of a task row inside one card — derived from the card
 * body's own layout ("a task belongs to the group whose header precedes
 * it"): walk the body back from the task to the nearest `stage-group`
 * entry; hitting the top means Unstaged (`null`). Classifies both a drag's
 * source and target.
 */
function taskBodyStage(card: SidebarCardModel, taskId: string): WorkflowStage | null {
  const idx = card.body.findIndex((entry) => entry.kind === 'task' && entry.taskId === taskId);
  if (idx === -1) return null;
  for (let i = idx - 1; i >= 0; i--) {
    const entry = card.body[i]!;
    if (entry.kind === 'stage-group') return entry.stage;
  }
  return null;
}

/**
 * The board's authority answer for a sidebar task drop (spec #85, ticket
 * #89): `blocked` only for a cross-stage destination a governing GitHub
 * fact would reassert over — the exact #88 gating
 * (`sidebarStageMoveOptions`'s `blocked` flag), never a second
 * implementation. A same-stage drop (a reorder within the group, or between
 * Unstaged rows) never changes the stage, so nothing contests it — mirroring
 * the board's same-column reorder. `explanation` is the board's `fact +
 * action` feedback text surfaced when the drop is rejected.
 */
function taskDropAuthority(
  projectId: string,
  taskId: string,
  sourceStage: WorkflowStage | null,
  destinationStage: WorkflowStage | null
): { blocked: boolean; explanation: string | null } {
  if (sourceStage === destinationStage) return { blocked: false, explanation: null };
  const task = getTaskStore(projectId, taskId);
  const registered = task ? registeredTaskData(task) : null;
  if (!registered) return { blocked: false, explanation: null };
  const branchName = getTaskGitWorktreeStore(projectId, taskId)?.branchName ?? null;
  const move = sidebarStageMoveOptions(registered, branchName);
  const option = move.options.find((candidate) => candidate.stage === destinationStage);
  if (!option?.blocked) return { blocked: false, explanation: null };
  return { blocked: true, explanation: move.explanation };
}

/**
 * Card drags consider every card container except the active one (dnd-kit's
 * own convention: an item is never a drop target for itself). Task drags
 * stay restricted to their own project's task rows. The pointer's target
 * wins when the pointer is inside one, the nearest otherwise — the old row
 * collision shape.
 */
const cardCollision: CollisionDetection = (args) => {
  const activeId = String(args.active.id);
  const parsed = parseDndId(activeId);
  if (!parsed) return [];
  const containers = args.droppableContainers.filter((c) => {
    const id = String(c.id);
    if (id === activeId) return false;
    if (parsed.kind === 'task') {
      const cParsed = parseDndId(id);
      return cParsed?.kind === 'task' && cParsed.projectId === parsed.projectId;
    }
    return true;
  });
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
 * The drag overlay (ticket #123 + restored task drags): a compact replica
 * of the dragged entity — the card header (identity chip and name on the
 * project hue) or a task row (signal dot and name) — portaled by dnd-kit to
 * the body while the source dims in place (opacity 0.4). Rendered
 * statically: the overlay must not carry live handlers.
 */
function CardDragOverlayContent({ dndId }: { dndId: string }) {
  const parsed = parseDndId(dndId);
  if (!parsed) return null;
  if (parsed.kind === 'task') {
    return <TaskDragOverlayContent projectId={parsed.projectId} taskId={parsed.taskId} />;
  }
  const project = getProjectStore(parsed.projectId);
  if (!project) return null;
  const projectLabel = project.name ?? 'project';
  const hue = projectHue(parsed.projectId);
  return (
    <div className="rounded-xl border border-border/60 bg-background-tertiary-1 shadow-md">
      <div className="flex h-9 items-center gap-2 px-2">
        <span
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-[11px] font-bold"
          style={{ backgroundColor: hue.chipBg, color: hue.fg }}
        >
          {(projectLabel[0] ?? '?').toUpperCase()}
        </span>
        <span className="min-w-0 truncate text-left font-semibold select-none">{projectLabel}</span>
      </div>
    </div>
  );
}

/** The task-row overlay replica: a fixed signal slot + the task name. */
function TaskDragOverlayContent({ projectId, taskId }: { projectId: string; taskId: string }) {
  const name = getTaskStore(projectId, taskId)?.data.name ?? taskId;
  return (
    <div className="rounded-xl border border-border/60 bg-background-tertiary-1 shadow-md">
      <div className="flex h-8 items-center gap-2 px-3">
        <span className="flex size-3.5 shrink-0 items-center justify-center">
          <span className="size-2 shrink-0 rounded-full bg-foreground-tertiary-passive" />
        </span>
        <span className="min-w-0 truncate text-left text-sm select-none">{name}</span>
      </div>
    </div>
  );
}

/**
 * The insertion line (ticket #123 + restored task drags): drawn at the over
 * target's top edge when the pointer is above its midline, at its bottom
 * edge otherwise — always in the gap between rows, never over one. Never
 * drawn for a drop the board's authority would reject ("no ghost in the
 * disabled column"), and never between a card and its own tasks (dropping a
 * project onto its own rows is a no-op).
 */
function InsertionIndicator({
  pointerY,
  cards,
}: {
  pointerY: number | null;
  cards: SidebarCardModel[];
}) {
  const { active, over } = useDndContext();
  if (!active || !over || active.id === over.id) return null;
  const activeParsed = parseDndId(String(active.id));
  const overParsed = parseDndId(String(over.id));
  if (!activeParsed || !overParsed) return null;
  if (
    activeParsed.kind === 'project' &&
    overParsed.kind === 'task' &&
    overParsed.projectId === activeParsed.projectId
  ) {
    return null;
  }
  if (activeParsed.kind === 'task' && overParsed.kind === 'task') {
    const card = cards.find((c) => c.projectId === activeParsed.projectId);
    if (!card) return null;
    const authority = taskDropAuthority(
      activeParsed.projectId,
      activeParsed.taskId,
      taskBodyStage(card, activeParsed.taskId),
      taskBodyStage(card, overParsed.taskId)
    );
    if (authority.blocked) return null;
  }
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
