import {
  closestCenter,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MeasuringStrategy,
  PointerSensor,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
  type ClientRect,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
  type ScreenReaderInstructions,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { AlertTriangle } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  columnEmphasis,
  isBoardDisplayable,
  PIPELINE_COLUMNS,
  STAGE_LABELS,
} from '@renderer/features/board/board-columns';
import { EMPTY_BOARD_FILTERS, type BoardFilterState } from '@renderer/features/board/board-filters';
import {
  buildGlobalBoardColumns,
  computeGlobalDropPosition,
  type GlobalBoardCard,
  type GlobalBoardColumns,
  type GlobalBoardProjectInput,
} from '@renderer/features/board/board-global';
import { BoardHeader } from '@renderer/features/board/board-header';
import { authorityForTask, BoardCard } from '@renderer/features/board/board-main-panel';
import {
  TaskDetailPanel,
  type TaskDetailPanelTarget,
} from '@renderer/features/board/task-detail-panel';
import {
  getProjectStore,
  projectDisplayName,
} from '@renderer/features/projects/stores/project-selectors';
import {
  getTaskGitWorktreeStore,
  getTaskManagerStore,
  taskAgentStatus,
} from '@renderer/features/tasks/stores/task-selectors';
import { registeredTaskData, type TaskStore } from '@renderer/features/tasks/stores/task-store';
import { useNavigate } from '@renderer/lib/layout/navigation-provider';
import { appState } from '@renderer/lib/stores/app-state';
import { Badge } from '@renderer/lib/ui/badge';
import { captureTelemetry } from '@renderer/utils/telemetryClient';
import { cn } from '@renderer/utils/utils';
import type { AgentStatus } from '@shared/core/agents/agentEvents';
import {
  describeStageAuthorityFact,
  isStageDestinationSafe,
  type StageAuthority,
} from '@shared/core/tasks/stage-authority';
import type { Task, WorkflowStage } from '@shared/core/tasks/tasks';
import { COLUMNS, type ColumnId } from './board-ordering';

/** `ColumnId` (which includes the `unstaged` bucket) down to the `WorkflowStage | null`
 * shape `stage-authority.ts` speaks — the same mapping `computeDropPosition`
 * (`board-ordering.ts`) uses and the Feature Board applies. */
function columnToStage(column: ColumnId): WorkflowStage | null {
  return column === 'unstaged' ? null : column;
}

/** dnd-kit id for a column's empty-space drop target (distinct from card ids) —
 * same id namespace as the Feature Board, so `parseColumnDropId` distinguishes
 * them exactly the same way. */
const COLUMN_DROP_PREFIX = 'column-drop::';
const columnDropId = (column: ColumnId) => `${COLUMN_DROP_PREFIX}${column}`;
const parseColumnDropId = (id: string): ColumnId | undefined =>
  id.startsWith(COLUMN_DROP_PREFIX) ? (id.slice(COLUMN_DROP_PREFIX.length) as ColumnId) : undefined;

/** Keyboard drag instructions (ticket #52): the Global Board reuses the
 * Feature Board's card, so its "Move" handle works and reads identically. */
const BOARD_SCREEN_READER_INSTRUCTIONS: ScreenReaderInstructions = {
  draggable: `
    Tab to a card's Move button, then press Space or Enter to pick it up.
    While picked up, use the arrow keys to move it between cards and columns.
    Press Space or Enter again to drop it in its new position, or press Escape to cancel.
  `,
};

/** True when the dragged card's final position sits above the target's vertical center. */
function isAboveTarget(activeRect: ClientRect | null, overRect: ClientRect | null): boolean {
  if (!activeRect || !overRect) return true;
  const activeCenter = activeRect.top + activeRect.height / 2;
  const overCenter = overRect.top + overRect.height / 2;
  return activeCenter < overCenter;
}

/**
 * Global Board main panel (spec #104, ticket #107): the cross-project sibling
 * of the Feature Board. Composes each project's already-loaded
 * `TaskManagerStore` state into `buildGlobalBoardColumns` (the pure module of
 * ticket #106) and renders the same stage columns — Unstaged and Triage
 * included — with every card marked by its project.
 *
 * Interactions mirror `BoardMainPanel` exactly: the same dnd-kit mechanics,
 * the same stage-authority blocking (`authorityForTask`, shared with the
 * Feature Board), the same task-scoped write path
 * (`TaskStore.updateBoardPosition` → `rpc.tasks.updateTaskBoardPosition` —
 * drops interpolate in the *shared per-stage column* across projects via
 * `computeGlobalDropPosition`), and the same Task Detail Panel on card click.
 * Deliberately absent, per CONTEXT.md "Global Board": ghost cards, link
 * suggestions, column-scoped creation, the focused-task round trip, and any
 * SSH health gate — unreachable projects still render from their loaded task
 * sets, and a failing action rolls back exactly like the Feature Board's.
 */
export const GlobalBoardMainPanel = observer(function GlobalBoardMainPanel() {
  const { navigate } = useNavigate();
  // Guard so the Escape/panel-disappearance effects below can read the latest
  // maps (rebuilt every render) without re-subscribing on every render.
  const boardContainerRef = useRef<HTMLDivElement>(null);
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  // Cross-column drag preview (same semantics as the Feature Board's).
  const [dragPreview, setDragPreview] = useState<{ column: ColumnId; index: number } | null>(null);
  // Task Detail Panel (CONTEXT.md): ephemeral view state, local to this
  // component — never survives leaving the board, writes nothing to the DB.
  const [panelTarget, setPanelTarget] = useState<TaskDetailPanelTarget | null>(null);
  // Stage authority (ticket #48): the currently-hovered blocked destination.
  const [blockedHover, setBlockedHover] = useState<{
    column: ColumnId;
    explanation: string;
  } | null>(null);
  // The Board Header's ephemeral filters (search, Needs Attention, compact
  // categories) — presentation-only, exactly like the Feature Board's. The
  // project multi-select is the exception: it lives in the sidebar store and
  // persists per workspace.
  const [filters, setFilters] = useState<BoardFilterState>(EMPTY_BOARD_FILTERS);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  // The persisted project multi-select (wave 1): undefined = all projects.
  const selectedProjectIds = new Set(appState.sidebar.globalBoardProjectFilter ?? []);

  // One Shipped-Fade evaluation instant per render, shared by the module's
  // displayability pass and this panel's own disappearance/authority passes
  // so they can never disagree about a card.
  const now = Date.now();

  // Compose the per-project task sets from the already-loaded
  // TaskManagerStores (no RPC here — the best-effort global `tasks.getTasks()`
  // refresh is ticket #108). `storeById`/`projectIdByCardId` deliberately stay
  // unfiltered by the board's own filters and the project selection: the Task
  // Detail Panel's disappearance handling keys off them, and a filter must
  // never silently close an already-open panel (same rule as the Feature
  // Board). They are gated on `isBoardDisplayable`, so a card Shipped Fade
  // hides closes its panel rather than rendering stale data.
  const projects: GlobalBoardProjectInput[] = [];
  const storeById = new Map<string, TaskStore>();
  const projectIdByCardId = new Map<string, string>();
  for (const [projectId, project] of appState.projects.projects) {
    const mounted = project.mountedProject;
    if (!mounted) continue;
    const tasks: Task[] = [];
    const agentStatuses = new Map<string, AgentStatus | null>();
    for (const [, store] of mounted.taskManager.tasks) {
      const task = registeredTaskData(store);
      if (!task) continue;
      tasks.push(task);
      agentStatuses.set(task.id, taskAgentStatus(store));
      if (isBoardDisplayable(task, now)) {
        storeById.set(task.id, store);
        projectIdByCardId.set(task.id, projectId);
      }
    }
    projects.push({ projectId, tasks, agentStatuses });
  }

  const isDragActive = activeDragId !== null;
  const columns: GlobalBoardColumns = buildGlobalBoardColumns(projects, filters, {
    now,
    selectedProjectIds,
    frozen: isDragActive,
  });
  const presentProjectIds = columns.presentProjects;

  // The column a card currently belongs to, accounting for the drag preview.
  const columnByCardId = new Map<string, ColumnId>();
  for (const column of COLUMNS) {
    for (const entry of columns.sorted.get(column) ?? []) columnByCardId.set(entry.id, column);
  }

  // Stage authority (ticket #48): computed once per render from data already
  // on each task, so drag handlers decide synchronously — the exact same
  // facts and precedence the Feature Board uses (`authorityForTask`).
  const authorityByCardId = new Map<string, StageAuthority>();
  for (const [id, store] of storeById) {
    const task = registeredTaskData(store);
    if (!task) continue;
    const projectId = projectIdByCardId.get(id);
    const branchName =
      projectId !== undefined ? (getTaskGitWorktreeStore(projectId, id)?.branchName ?? null) : null;
    authorityByCardId.set(id, authorityForTask(task, branchName));
  }

  // Apply the cross-column drag preview to the display columns: pull the
  // active card out of its source column and insert it at the previewed index
  // in the hovered column, exactly like the Feature Board.
  const displayByColumn = new Map<ColumnId, GlobalBoardCard[]>();
  for (const column of COLUMNS) {
    displayByColumn.set(column, [...(columns.display.get(column) ?? [])]);
  }
  const activeSourceColumn = activeDragId ? columnByCardId.get(activeDragId) : undefined;
  const previewColumn =
    activeDragId && dragPreview && activeSourceColumn && dragPreview.column !== activeSourceColumn
      ? dragPreview.column
      : undefined;
  if (activeDragId && previewColumn && activeSourceColumn) {
    displayByColumn.set(
      activeSourceColumn,
      (displayByColumn.get(activeSourceColumn) ?? []).filter((entry) => entry.id !== activeDragId)
    );
    const dest = [...(displayByColumn.get(previewColumn) ?? [])];
    dest.splice(Math.min(Math.max(dragPreview!.index, 0), dest.length), 0, {
      id: activeDragId,
      rank: null,
      projectId: projectIdByCardId.get(activeDragId) ?? '',
    });
    displayByColumn.set(previewColumn, dest);
  }

  const effectiveColumnOf = (id: string): ColumnId | undefined =>
    id === activeDragId && previewColumn ? previewColumn : columnByCardId.get(id);

  function handleDragStart(event: DragStartEvent) {
    setActiveDragId(String(event.active.id));
    setDragPreview(null);
  }

  function handleDragCancel() {
    setActiveDragId(null);
    setDragPreview(null);
    setBlockedHover(null);
  }

  function handleDragOver(event: DragOverEvent) {
    const { active, over } = event;
    const activeId = String(active.id);
    const sourceColumn = columnByCardId.get(activeId);
    if (!over || !sourceColumn) {
      setDragPreview(null);
      setBlockedHover(null);
      return;
    }
    const overId = String(over.id);
    const overZone = parseColumnDropId(overId);
    // Effective attribution: hovering the preview ghost itself must resolve
    // to the previewed column, not the card's source column.
    const overColumn = overZone ?? effectiveColumnOf(overId);
    if (!overColumn || overColumn === sourceColumn) {
      setDragPreview(null);
      setBlockedHover(null);
      return;
    }

    // Stage authority (ticket #48): an unsafe cross-stage destination never
    // even previews the move — the ghost stays put and the destination is
    // marked disabled, exactly like the Feature Board.
    const authority = authorityByCardId.get(activeId);
    if (authority?.governs && !isStageDestinationSafe(authority.fact, columnToStage(overColumn))) {
      setDragPreview(null);
      const description = describeStageAuthorityFact(authority.fact);
      setBlockedHover({
        column: overColumn,
        explanation: `${description.fact} ${description.action}`,
      });
      return;
    }
    setBlockedHover(null);

    const overRect = over.rect;
    setDragPreview((previous) => {
      if (previous?.column === overColumn) return previous;
      const destEntries = columns.sorted.get(overColumn) ?? [];
      let index = destEntries.length;
      if (!overZone && overId !== activeId) {
        const overIndex = destEntries.findIndex((entry) => entry.id === overId);
        if (overIndex !== -1) {
          const activeRect = active.rect.current.translated ?? active.rect.current.initial;
          index = isAboveTarget(activeRect, overRect) ? overIndex : overIndex + 1;
        }
      }
      return { column: overColumn, index };
    });
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveDragId(null);
    setDragPreview(null);
    setBlockedHover(null);
    const { active, over } = event;
    if (!over) return;
    const activeId = String(active.id);
    const overId = String(over.id);
    const store = storeById.get(activeId);
    if (!store) return;
    const sourceColumn = columnByCardId.get(activeId);

    if (activeId === overId) {
      // Dropping on the card's own slot: without a cross-column preview this
      // is a no-op — but when the preview holds the card in a foreign column,
      // the "own slot" IS the ghost: persist the previewed position. The
      // preview can never sit on an unsafe destination (handleDragOver
      // refuses to set it there), so no extra authority guard is needed.
      if (previewColumn && dragPreview) {
        const { stage, rank } = computeGlobalDropPosition(
          columns,
          previewColumn,
          activeId,
          dragPreview.index
        );
        void store.updateBoardPosition(stage, rank);
      }
      return;
    }

    const overColumn = parseColumnDropId(overId);
    const overCardId = overColumn ? undefined : overId;
    const destinationColumn = overColumn ?? columnByCardId.get(overId);
    if (!destinationColumn) return;

    // Stage authority (ticket #48): the authoritative enforcement point —
    // dnd-kit's own collision detection is untouched and can still resolve
    // `over` on an unsafe destination during a fast gesture. No move is
    // persisted for a genuinely GitHub-authoritative card's cross-stage drop
    // unless `isStageDestinationSafe` agrees.
    if (destinationColumn !== sourceColumn) {
      const authority = authorityByCardId.get(activeId);
      const destinationStage = columnToStage(destinationColumn);
      if (authority?.governs && !isStageDestinationSafe(authority.fact, destinationStage)) {
        captureTelemetry('board_move_blocked', {
          from_stage: sourceColumn ? columnToStage(sourceColumn) : null,
          attempted_stage: destinationStage,
          governing_fact: authority.fact.kind,
          project_id: projectIdByCardId.get(activeId) ?? null,
        });
        return;
      }
    }

    const destinationEntries = (columns.sorted.get(destinationColumn) ?? []).filter(
      (entry) => entry.id !== activeId
    );

    let dropIndex = destinationEntries.length;
    if (overCardId) {
      if (effectiveColumnOf(activeId) === destinationColumn) {
        // The active card already lives in this column — natively, or as the
        // cross-column drag preview ghost. dnd-kit's sortable displacement
        // has already decided the slot: the over card's index in the rendered
        // list (ghost included) is the drop index, in both directions.
        const overIndexInColumn = (displayByColumn.get(destinationColumn) ?? []).findIndex(
          (entry) => entry.id === overCardId
        );
        if (overIndexInColumn !== -1) dropIndex = overIndexInColumn;
      } else {
        // Drop onto a card in a column the preview never entered (fast
        // flick): its cards are undisplaced, the midpoint heuristic is sound.
        const overIndex = destinationEntries.findIndex((entry) => entry.id === overCardId);
        if (overIndex !== -1) {
          const activeRect = active.rect.current.translated ?? active.rect.current.initial;
          dropIndex = isAboveTarget(activeRect, over.rect) ? overIndex : overIndex + 1;
        }
      }
    } else if (previewColumn === destinationColumn && dragPreview) {
      // Zone drop in the previewed column: land where the ghost sits.
      dropIndex = dragPreview.index;
    }

    // Rank math in the shared per-stage column across projects
    // (`computeGlobalDropPosition` — ticket #106). The write is the same
    // task-scoped RPC the Feature Board uses; an unreachable project's
    // failure rolls back optimistically inside `updateBoardPosition` and is
    // logged, with no SSH gate involved.
    const { stage, rank } = computeGlobalDropPosition(
      columns,
      destinationColumn,
      activeId,
      dropIndex
    );
    void store.updateBoardPosition(stage, rank);
  }

  // Column-first collision: the column under the pointer always wins, then
  // the closest card within that column — the same algorithm the Feature
  // Board uses (plain closestCenter compares a neighbouring column's small
  // card rect against this column's tall zone rect and picks the neighbour).
  const columnAwareCollision: CollisionDetection = (args) => {
    const zones = args.droppableContainers.filter((container) =>
      String(container.id).startsWith(COLUMN_DROP_PREFIX)
    );
    const withinZones = pointerWithin({ ...args, droppableContainers: zones });
    const zoneHits = withinZones.length
      ? withinZones
      : closestCenter({ ...args, droppableContainers: zones });
    const zoneId = zoneHits[0]?.id;
    if (zoneId === undefined) return [];
    const column = parseColumnDropId(String(zoneId));
    // Effective attribution: while the drag preview holds the active card in
    // a foreign column, it must be a collision candidate there and not in its
    // source column anymore.
    const cards = args.droppableContainers.filter(
      (container) => effectiveColumnOf(String(container.id)) === column
    );
    // Rank cards by distance to the *pointer*, not to the DragOverlay rect:
    // the overlay preview is shorter than a card, so its centre sits above
    // the pointer and biases every above/below decision upward.
    const { pointerCoordinates } = args;
    if (pointerCoordinates) {
      const cardHits = cards
        .flatMap((container) => {
          const rect = container.rect.current;
          if (!rect) return [];
          const dx = pointerCoordinates.x - (rect.left + rect.width / 2);
          const dy = pointerCoordinates.y - (rect.top + rect.height / 2);
          return [
            {
              id: container.id,
              data: { droppableContainer: container, value: Math.hypot(dx, dy) },
            },
          ];
        })
        .sort((a, b) => a.data.value - b.data.value);
      if (cardHits.length) return cardHits;
    }
    const cardHits = closestCenter({ ...args, droppableContainers: cards });
    return cardHits.length ? cardHits : zoneHits;
  };

  const activeDragStore = activeDragId ? storeById.get(activeDragId) : undefined;

  // Screen-reader drag announcements (ticket #52): same friendly
  // task-name/Workflow-Stage narration as the Feature Board.
  const describeDragCard = (id: string): string => {
    const store = storeById.get(id);
    const task = store ? registeredTaskData(store) : undefined;
    return task?.name ?? 'the card';
  };
  const describeDropTarget = (id: string): string => {
    const column = parseColumnDropId(id) ?? effectiveColumnOf(id);
    return column ? `the ${STAGE_LABELS[column]} column` : 'the board';
  };
  const boardAnnouncements: Announcements = {
    onDragStart: ({ active }) => `Picked up ${describeDragCard(String(active.id))}.`,
    onDragOver: ({ active, over }) =>
      over
        ? `${describeDragCard(String(active.id))} is over ${describeDropTarget(String(over.id))}.`
        : `${describeDragCard(String(active.id))} is no longer over a column.`,
    onDragEnd: ({ active, over }) =>
      over
        ? `${describeDragCard(String(active.id))} was dropped in ${describeDropTarget(String(over.id))}.`
        : `${describeDragCard(String(active.id))} was dropped.`,
    onDragCancel: ({ active }) => `Moving ${describeDragCard(String(active.id))} was cancelled.`,
  };

  // Card selection (ticket #49): opens/switches the inspector — a read-only
  // view-state change, never a write. Only fires `board_inspector_opened`
  // when the shown target actually changes; the project_id envelope carries
  // the card's own project (the Global Board has no single project scope).
  const handleSelectTask = (taskId: string) => {
    const alreadyShown = panelTarget?.kind === 'task' && panelTarget.taskId === taskId;
    if (!alreadyShown) {
      captureTelemetry('board_inspector_opened', {
        target_kind: 'task',
        project_id: projectIdByCardId.get(taskId) ?? null,
      });
    }
    setPanelTarget({ kind: 'task', taskId });
  };

  // Direct navigation (CONTEXT.md "Task Detail Panel"): the hover arrow and
  // the panel's "Open task" button both land here — provision first when the
  // task has never been provisioned and isn't already busy, then navigate to
  // the full task view, carrying the card's own project. Mirrors the Feature
  // Board's one provision-then-navigate implementation.
  const openTaskView = (taskId: string, focusConversationId?: string) => {
    const projectId = projectIdByCardId.get(taskId);
    const store = storeById.get(taskId);
    if (!projectId) return;
    if (store?.state === 'unprovisioned' && store.phase === 'idle') {
      const manager = getTaskManagerStore(projectId);
      if (manager) void manager.provisionTask(taskId);
    }
    navigate('task', { projectId, taskId, focusConversationId });
  };
  const handleOpenTask = (taskId: string) => openTaskView(taskId);
  const handleOpenConversation = (taskId: string, conversationId: string) =>
    openTaskView(taskId, conversationId);

  // Disappearance handling (CONTEXT.md "Task Detail Panel"): a task archived
  // elsewhere, or faded out by Shipped Fade, must never keep the panel open
  // rendering stale or missing data — close it instead. Deliberately keyed
  // off `storeById` (unfiltered by the board's filters and the project
  // selection), never off the rendered columns.
  const panelTargetGone =
    panelTarget !== null &&
    (panelTarget.kind === 'task' ? !storeById.has(panelTarget.taskId) : true);
  useEffect(() => {
    if (panelTargetGone) setPanelTarget(null);
  }, [panelTargetGone]);

  // Escape closes the panel (alongside the close button rendered in it).
  useEffect(() => {
    if (panelTarget === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setPanelTarget(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [panelTarget]);

  const projectLabelOf = (projectId: string): string =>
    projectDisplayName(getProjectStore(projectId)) ?? projectId;

  // Header context: the muted subtitle reads as a project count, so the
  // Global Board's scope is legible without a single-project name. A
  // restricted selection reports the visible subset ("2 of 4 projects").
  const projectSelectionActive = selectedProjectIds.size > 0;
  const visibleProjectCount = projectSelectionActive
    ? presentProjectIds.filter((id) => selectedProjectIds.has(id)).length
    : presentProjectIds.length;
  const headerContext = projectSelectionActive
    ? `${visibleProjectCount} of ${presentProjectIds.length} projects`
    : `${presentProjectIds.length} projects`;

  // Shared column renderer (Unstaged, the six-stage pipeline, Triage) —
  // same grouping and emphasis as the Feature Board, minus ghost cards and
  // column-scoped creation, which have no meaning without a project scope.
  const renderColumn = (column: ColumnId) => (
    <GlobalBoardColumn
      key={column}
      column={column}
      entries={displayByColumn.get(column) ?? []}
      storeById={storeById}
      projectLabelOf={projectLabelOf}
      selectedTaskId={panelTarget?.kind === 'task' ? panelTarget.taskId : null}
      onSelectTask={handleSelectTask}
      onOpenTask={handleOpenTask}
      // Stage authority (ticket #48): pass through the currently-hovered
      // blocked destination, if this is it.
      isBlockedDestination={blockedHover?.column === column}
      blockedDestinationExplanation={
        blockedHover?.column === column ? blockedHover.explanation : null
      }
    />
  );

  return (
    <div ref={boardContainerRef} className="flex h-full flex-col bg-background text-foreground">
      <BoardHeader
        title="Global board"
        projectName={headerContext}
        filters={filters}
        onFiltersChange={setFilters}
        projectFilter={{
          presentProjectIds,
          selectedProjectIds,
          onSelectionChange: (projectIds) =>
            appState.sidebar.setGlobalBoardProjectFilter(projectIds),
          projectDisplayNameOf: projectLabelOf,
        }}
      />
      {/* Task Detail Panel (CONTEXT.md): a fixed-width sibling to the right of
          the board, not an overlay — the board stays fully interactive
          (including drag-and-drop) while it is open. Ephemeral, exactly like
          the Feature Board's. */}
      <div className="flex min-h-0 flex-1">
        {presentProjectIds.length === 0 ? (
          <div className="flex h-full flex-1 items-center justify-center text-sm text-foreground-muted">
            No projects with displayable tasks yet — open projects so their tasks are loaded.
          </div>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={columnAwareCollision}
            accessibility={{
              announcements: boardAnnouncements,
              screenReaderInstructions: BOARD_SCREEN_READER_INSTRUCTIONS,
            }}
            autoScroll={{ threshold: { x: 0.05, y: 0.2 } }}
            measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
            onDragStart={handleDragStart}
            onDragOver={handleDragOver}
            onDragEnd={handleDragEnd}
            onDragCancel={handleDragCancel}
          >
            <div className="flex flex-1 gap-3 overflow-x-auto px-4 pb-4">
              {renderColumn('unstaged')}
              {/* Exception groups (CONTEXT.md "Unstaged", "Triage"): same
                  divider separation as the Feature Board. */}
              <BoardColumnGroupDivider />
              {PIPELINE_COLUMNS.map((column) => renderColumn(column))}
              <BoardColumnGroupDivider />
              {renderColumn('triage')}
            </div>
            <DragOverlay>
              {activeDragStore ? (
                <GlobalBoardCardPreview
                  store={activeDragStore}
                  projectLabel={projectLabelOf(
                    projectIdByCardId.get(activeDragStore.data.id) ?? ''
                  )}
                />
              ) : null}
            </DragOverlay>
          </DndContext>
        )}
        {/* Stage authority (ticket #48): announces the disabled-destination
            explanation to screen readers as a drag hovers it. Visually hidden
            — the column itself carries the same text via `aria-label`/`title`
            for pointer users and assistive tech that reads the hovered
            element directly. `data-board-status` keeps this region
            distinguishable from dnd-kit's own built-in drag-announcement
            live region, which also renders `role="status"`. */}
        <div data-board-status role="status" aria-live="polite" className="sr-only">
          {blockedHover?.explanation ?? ''}
        </div>
        {panelTarget?.kind === 'task' && projectIdByCardId.has(panelTarget.taskId) && (
          <TaskDetailPanel
            projectId={projectIdByCardId.get(panelTarget.taskId)!}
            target={panelTarget}
            onClose={() => setPanelTarget(null)}
            onOpenTask={handleOpenTask}
            onOpenConversation={handleOpenConversation}
            onAdoptGhostCard={() => {
              // The Global Board never shows ghost cards (CONTEXT.md "Global
              // Board") — this target kind is unreachable.
            }}
            onRejectGhostCard={() => {
              // Unreachable, same as `onAdoptGhostCard`.
            }}
          />
        )}
      </div>
    </div>
  );
});

/** Decorative separator between the Unstaged/pipeline/Triage groups (ticket
 * #46) — same as the Feature Board's. */
function BoardColumnGroupDivider() {
  return <div aria-hidden="true" className="mx-1 w-px shrink-0 self-stretch bg-border" />;
}

/** Column emphasis aria suffix — identical to the Feature Board's, so the two
 * boards read the same to assistive tech. */
const EMPHASIS_ARIA_SUFFIX: Record<'pipeline' | 'unstaged' | 'triage', string> = {
  pipeline: '',
  unstaged: ' — exception group, outside the delivery pipeline',
  triage:
    ' — warning: exception stage for contradicted delivery facts, not part of the delivery pipeline',
};

/**
 * One Global Board column: the Feature Board's column minus ghost cards,
 * the collapse toggle and column-scoped creation — all three are
 * project-scoped features the Global Board deliberately lacks (CONTEXT.md
 * "Global Board"). Stage-authority blocked destinations render disabled with
 * an accessible explanation, exactly like the Feature Board.
 */
const GlobalBoardColumn = observer(function GlobalBoardColumn({
  column,
  entries,
  storeById,
  projectLabelOf,
  selectedTaskId,
  onSelectTask,
  onOpenTask,
  isBlockedDestination,
  blockedDestinationExplanation,
}: {
  column: ColumnId;
  entries: readonly GlobalBoardCard[];
  storeById: Map<string, TaskStore>;
  projectLabelOf: (projectId: string) => string;
  selectedTaskId: string | null;
  onSelectTask: (taskId: string) => void;
  onOpenTask: (taskId: string) => void;
  isBlockedDestination: boolean;
  blockedDestinationExplanation: string | null;
}) {
  const cardCount = entries.length;
  const { setNodeRef, isOver } = useDroppable({ id: columnDropId(column) });
  // Keep the ids array referentially stable while its contents are unchanged:
  // useDroppable re-renders this column on every drag movement, and a fresh
  // array each render makes useSortable's `items !== previousItems` check
  // disable the make-room transition exactly when the displacement transform
  // lands — cards snap instead of animating.
  const cardIdsKey = entries.map((entry) => entry.id).join('\n');
  const cardIds = useMemo(() => (cardIdsKey ? cardIdsKey.split('\n') : []), [cardIdsKey]);

  const emphasis = columnEmphasis(column);
  const stageLabel = STAGE_LABELS[column];

  return (
    <div
      role="group"
      aria-label={`${stageLabel} column${EMPHASIS_ARIA_SUFFIX[emphasis]}`}
      className={cn(
        'flex w-56 shrink-0 flex-col rounded-lg border',
        emphasis === 'pipeline' && 'border-border bg-background-2/40',
        emphasis === 'unstaged' && 'border-dashed border-border bg-background-2/20',
        emphasis === 'triage' && 'border-dashed border-border-warning bg-background-warning/30'
      )}
      // Stage authority (ticket #48): `aria-disabled` and `title` name the
      // disabled destination for pointer users (native tooltip) and
      // assistive tech that reads the hovered element directly.
      aria-disabled={isBlockedDestination || undefined}
      title={isBlockedDestination ? (blockedDestinationExplanation ?? undefined) : undefined}
    >
      <div className="flex items-center gap-1 px-3 py-2">
        {emphasis === 'triage' && (
          <AlertTriangle aria-hidden="true" className="size-3.5 shrink-0 text-foreground-warning" />
        )}
        <span
          className={cn(
            'truncate text-xs font-medium',
            emphasis === 'triage' ? 'text-foreground-warning' : 'text-foreground-muted'
          )}
          title={stageLabel}
        >
          {stageLabel}
        </span>
        <Badge variant="secondary" className="ml-auto shrink-0">
          {cardCount}
        </Badge>
      </div>
      <SortableContext items={cardIds} strategy={verticalListSortingStrategy}>
        <div
          ref={setNodeRef}
          className={cn(
            'flex flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2',
            isOver && 'bg-foreground/5',
            isBlockedDestination && 'cursor-not-allowed opacity-50'
          )}
        >
          {entries.map((entry) => {
            const store = storeById.get(entry.id);
            if (!store) return null;
            return (
              <BoardCard
                key={entry.id}
                store={store}
                isSelected={entry.id === selectedTaskId}
                onSelect={onSelectTask}
                onOpenTask={onOpenTask}
                projectLabel={projectLabelOf(entry.projectId)}
              />
            );
          })}
        </div>
      </SortableContext>
    </div>
  );
});

/** Lightweight drag-preview rendered in the `DragOverlay` — no dnd-kit
 * listeners attached; carries the card's project marker like the card does. */
function GlobalBoardCardPreview({
  store,
  projectLabel,
}: {
  store: TaskStore;
  projectLabel: string;
}) {
  const task = registeredTaskData(store);
  if (!task) return null;
  return (
    <div className="w-56 cursor-grabbing rounded-md border border-border bg-background p-2 shadow-lg">
      <span className="text-xs font-medium">{task.name}</span>
      <div className="mt-1">
        <Badge variant="outline" className="gap-1 text-[10px]">
          {projectLabel}
        </Badge>
      </div>
    </div>
  );
}
