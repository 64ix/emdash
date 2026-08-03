import {
  closestCenter,
  DndContext,
  DragOverlay,
  MeasuringStrategy,
  PointerSensor,
  pointerWithin,
  useDroppable,
  useSensor,
  useSensors,
  type ClientRect,
  type CollisionDetection,
  type DragEndEvent,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  type AnimateLayoutChanges,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
// MessageSquare is gone with #47's removal of the old inline linked-issue badge;
// AlertTriangle/ChevronRight are #46's Triage warning and collapse toggle.
import { AlertTriangle, ArrowUpRight, ChevronRight } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useEffect, useMemo, useState } from 'react';
import {
  agentStateLabel,
  cardArtifactBadgeText,
  cardArtifactTitle,
  deriveCardArtifact,
  taskActivityInstant,
} from '@renderer/features/board/board-card-view-model';
import {
  columnEmphasis,
  isBoardDisplayable,
  PIPELINE_COLUMNS,
  STAGE_LABELS,
  type ColumnEmphasis,
} from '@renderer/features/board/board-columns';
import { BoardLinkSuggestions } from '@renderer/features/board/board-link-suggestions';
import { GhostCardView, useGhostCards } from '@renderer/features/board/ghost-cards';
import {
  TaskDetailPanel,
  type TaskDetailPanelTarget,
} from '@renderer/features/board/task-detail-panel';
import {
  getProjectStore,
  projectDisplayName,
} from '@renderer/features/projects/stores/project-selectors';
import { TaskGitDiffStats } from '@renderer/features/tasks/components/task-git-diff-stats';
import {
  getTaskGitWorktreeStore,
  getTaskManagerStore,
  taskAgentStatus,
} from '@renderer/features/tasks/stores/task-selectors';
import { registeredTaskData, type TaskStore } from '@renderer/features/tasks/stores/task-store';
import { AgentStatusIndicator } from '@renderer/lib/components/agent-status-indicator';
import { StatusIcon } from '@renderer/lib/components/pr-status-icon';
import { StackedAgentLogos } from '@renderer/lib/components/stacked-agent-logos';
import { rpc } from '@renderer/lib/ipc';
import { useNavigate, useParams } from '@renderer/lib/layout/navigation-provider';
import { Badge } from '@renderer/lib/ui/badge';
import { RelativeTime } from '@renderer/lib/ui/relative-time';
import { captureTelemetry } from '@renderer/utils/telemetryClient';
import { cn } from '@renderer/utils/utils';
import type { AgentStatus } from '@shared/core/agents/agentEvents';
import type { GhostCard } from '@shared/core/issues/ghost-card';
import {
  deriveTaskStageAuthorityFact,
  parseIssueNumberFromIdentifier,
} from '@shared/core/pull-requests/pr-workflow-derivation';
import {
  deriveStageAuthority,
  describeStageAuthorityFact,
  isStageDestinationSafe,
  type StageAuthority,
} from '@shared/core/tasks/stage-authority';
import type { Task, WorkflowStage } from '@shared/core/tasks/tasks';
import {
  COLUMNS,
  computeDropPosition,
  partitionAwaitingInput,
  sortColumn,
  stageOf,
  type ColumnId,
} from './board-ordering';

/** `ColumnId` (which includes the `unstaged` bucket) down to the `WorkflowStage | null`
 * shape `stage-authority.ts` speaks — `computeDropPosition` uses the same mapping. */
function columnToStage(column: ColumnId): WorkflowStage | null {
  return column === 'unstaged' ? null : column;
}

/**
 * A card's Workflow Stage authority (ticket #48), computed synchronously from
 * data already loaded onto the task — `task.prs` (branch-matched PRs; see
 * `getPullRequestsForTask`) and `task.linkedIssues` — so drag-time evaluation
 * never waits on a round trip. Reuses `deriveTaskStageAuthorityFact`, the
 * exact PR-fact precedence `BoardSyncService`/the Task Detail Panel's RPC
 * already use, rather than re-deriving it.
 */
function authorityForTask(
  task: Pick<Task, 'workflowStage' | 'linkedIssues' | 'prs' | 'workspaceId'>,
  branchName: string | null
): StageAuthority {
  const specIssueNumber = parseIssueNumberFromIdentifier(task.linkedIssues?.spec?.identifier);
  const currentStage = task.workflowStage ?? null;
  const prAuthority = deriveTaskStageAuthorityFact({
    currentStage,
    specIssueNumber,
    taskBranch: branchName,
    // Defensive: `task.prs` is non-optional on `Task`, but older/lighter test
    // doubles across the board test suites omit it.
    prFacts: task.prs ?? [],
  });
  return deriveStageAuthority({
    currentStage,
    linkedIssues: task.linkedIssues,
    prAuthority,
    hasWorkspace: task.workspaceId != null,
  });
}

/** dnd-kit id for a column's empty-space drop target (distinct from card ids). */
const COLUMN_DROP_PREFIX = 'column-drop::';
const columnDropId = (column: ColumnId) => `${COLUMN_DROP_PREFIX}${column}`;
const parseColumnDropId = (id: string): ColumnId | undefined =>
  id.startsWith(COLUMN_DROP_PREFIX) ? (id.slice(COLUMN_DROP_PREFIX.length) as ColumnId) : undefined;

type CardEntry = { id: string; rank: string | null };

/**
 * FLIP-animate layout changes during a drag and right after a drop. The
 * default skips the drop case (it assumes the make-room transition already
 * finished, so resetting transforms is visually a no-op) — but on a fast
 * gesture the transition is still mid-flight at drop time and cards snap the
 * remaining distance. Forcing the FLIP measures the card's real pre-reflow
 * position and animates from there; when nothing moved the delta is zero.
 */
const animateBoardLayoutChanges: AnimateLayoutChanges = (args) =>
  args.isSorting || args.wasDragging;

/** True when the dragged card's final position sits above the target's vertical center. */
function isAboveTarget(activeRect: ClientRect | null, overRect: ClientRect | null): boolean {
  if (!activeRect || !overRect) return true;
  const activeCenter = activeRect.top + activeRect.height / 2;
  const overCenter = overRect.top + overRect.height / 2;
  return activeCenter < overCenter;
}

export const BoardMainPanel = observer(function BoardMainPanel() {
  const {
    params: { projectId },
  } = useParams('board');
  const { navigate } = useNavigate();
  const manager = getTaskManagerStore(projectId);
  const projectName = projectDisplayName(getProjectStore(projectId)) ?? 'Project';
  const { ghostCards, adopt: adoptGhostCard, reject: rejectGhostCard } = useGhostCards(projectId);
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  // While dragging over a foreign column, the active card is moved into that
  // column's list (display only) so its SortableContext owns it: the ghost
  // slot and make-room displacement then work across columns exactly like
  // they do within one. Persistence still derives from store data at drop.
  const [dragPreview, setDragPreview] = useState<{ column: ColumnId; index: number } | null>(null);
  // Task Detail Panel (CONTEXT.md): ephemeral board view state — which task
  // (or Ghost Card) is shown on the right. Local to this component, so it
  // never survives leaving the board (unmount resets it) and writes nothing
  // to the database. `null` means the panel is closed.
  const [panelTarget, setPanelTarget] = useState<TaskDetailPanelTarget | null>(null);
  // Collapsible empty columns (ticket #46): user-toggled per column, and only
  // ever collapsed while the column is actually empty — a column that
  // receives a card (drop, sync, or otherwise) always renders expanded
  // regardless of this set. Opt-in and defaulted to empty (nothing
  // collapsed) so the board's default layout — and every existing
  // real-layout drag geometry test, which never touches the toggle — is
  // completely unaffected by this feature.
  const [collapsedColumns, setCollapsedColumns] = useState<ReadonlySet<ColumnId>>(new Set());
  const toggleColumnCollapsed = (column: ColumnId) => {
    setCollapsedColumns((previous) => {
      const next = new Set(previous);
      if (next.has(column)) next.delete(column);
      else next.add(column);
      return next;
    });
  };
  // Stage authority (ticket #48): while a GitHub-authoritative card is being
  // dragged over a column its governing fact would not survive in, this holds
  // the blocked column and its accessible explanation, so the disabled
  // destination can be announced (aria-live region) and visually marked.
  const [blockedHover, setBlockedHover] = useState<{
    column: ColumnId;
    explanation: string;
  } | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  // Board open triggers an immediate derivation pass (PR facts + inbound issues);
  // background derivation otherwise follows the existing sync cadences
  // (see board-sync-service.ts and issues-sync-scheduler.ts). Best-effort —
  // failures are logged main-side.
  useEffect(() => {
    void rpc.tasks.syncBoardStages(projectId);
    void rpc.issues.syncIssuesNow(projectId);
  }, [projectId]);

  // Built unconditionally, ahead of the `!manager` early return below, so the
  // disappearance effect that follows always runs in the same hook order
  // regardless of whether the project's task manager is mounted yet.
  const storeById = new Map<string, TaskStore>();
  const rawByColumn = new Map<ColumnId, CardEntry[]>(COLUMNS.map((c) => [c, []]));
  if (manager) {
    for (const [, store] of manager.tasks) {
      const task = registeredTaskData(store);
      if (!task || !isBoardDisplayable(task)) continue;
      storeById.set(task.id, store);
      rawByColumn.get(stageOf(task))?.push({ id: task.id, rank: task.boardRank ?? null });
    }
  }

  // Disappearance handling (CONTEXT.md "Task Detail Panel"): a task archived
  // elsewhere, or faded out by Shipped Fade, or a Ghost Card that stopped
  // being a candidate (adopted, rejected, or dropped by a sync pass) must
  // never keep the panel open rendering stale or missing data — close it
  // instead. Adopting the very ghost the panel shows is handled separately
  // (`handleAdoptGhostCard` below switches the target before this can fire).
  const panelTargetGone =
    panelTarget !== null &&
    (panelTarget.kind === 'task'
      ? !storeById.has(panelTarget.taskId)
      : !ghostCards.some((card) => card.id === panelTarget.ghostCard.id));
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

  if (!manager) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-foreground-muted">
        Open the project first so its tasks are loaded.
      </div>
    );
  }

  // Direct navigation (CONTEXT.md "Task Detail Panel"): the hover arrow on a
  // card and the panel's "Open task" button both land here. Mirrors
  // `SidebarTaskItem`'s open gesture — provision first when the task has
  // never been provisioned and isn't already busy, then navigate straight to
  // the full task view.
  const handleOpenTask = (taskId: string) => {
    const store = storeById.get(taskId);
    if (store?.state === 'unprovisioned' && store.phase === 'idle') {
      void manager.provisionTask(taskId);
    }
    navigate('task', { projectId, taskId });
  };

  // Adopting a Ghost Card creates the real task and switches the panel to it
  // (CONTEXT.md "Task Detail Panel", "Ghost Card") so management can continue
  // immediately — the ghost-card action itself is unchanged (`useGhostCards`).
  const handleAdoptGhostCard = async (ghostCard: GhostCard) => {
    const result = await adoptGhostCard(ghostCard);
    if (result?.success) {
      setPanelTarget({ kind: 'task', taskId: result.data.task.id });
    }
  };

  const awaitingInputIds = new Set<string>();
  for (const [id, store] of storeById) {
    if (taskAgentStatus(store) === 'awaiting-input') awaitingInputIds.add(id);
  }

  // Stage authority (ticket #48): computed once per render from data already
  // on each task (no RPC round trip — see `authorityForTask`), so drag
  // handlers below can synchronously decide which destinations a
  // GitHub-authoritative card must keep disabled.
  const authorityByCardId = new Map<string, StageAuthority>();
  for (const [id, store] of storeById) {
    const task = registeredTaskData(store);
    if (!task) continue;
    const branchName = getTaskGitWorktreeStore(projectId, id)?.branchName ?? null;
    authorityByCardId.set(id, authorityForTask(task, branchName));
  }

  // Frozen (un-elevated) order while a drag is active, per column — both for
  // display (ADR 0002) and as the basis for drop-position math, since Board
  // Rank is always relative to manual order, never the awaiting-input view.
  const isDragActive = activeDragId !== null;
  const sortedByColumn = new Map<ColumnId, CardEntry[]>();
  const displayByColumn = new Map<ColumnId, CardEntry[]>();
  const columnByCardId = new Map<string, ColumnId>();
  for (const column of COLUMNS) {
    const sorted = sortColumn(rawByColumn.get(column) ?? []);
    sortedByColumn.set(column, sorted);
    displayByColumn.set(column, partitionAwaitingInput(sorted, awaitingInputIds, isDragActive));
    for (const entry of sorted) columnByCardId.set(entry.id, column);
  }

  // Apply the cross-column drag preview: pull the active card out of its
  // source column and insert it at the entry index in the hovered column.
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
    });
    displayByColumn.set(previewColumn, dest);
  }

  /** The column a card currently belongs to, accounting for the drag preview. */
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
    // to the previewed column, not the card's source column, or the preview
    // would clear and re-enter in a loop.
    const overColumn = overZone ?? effectiveColumnOf(overId);
    if (!overColumn || overColumn === sourceColumn) {
      setDragPreview(null);
      setBlockedHover(null);
      return;
    }

    // Stage authority (ticket #48): a GitHub-authoritative card stays
    // reorderable in its own column (handled above — same-column hovers
    // never reach here), but an invalid cross-stage destination never even
    // previews the move: the ghost stays put and the destination is marked
    // disabled instead of promising a drop the next sync pass would silently
    // overwrite (#56).
    const authority = authorityByCardId.get(activeId);
    if (authority?.governs && !isStageDestinationSafe(authority.fact, columnToStage(overColumn))) {
      setDragPreview(null);
      const description = describeStageAuthorityFact(authority.fact);
      setBlockedHover({
        column: overColumn,
        explanation: description
          ? `${description.fact} ${description.action}`
          : 'This destination is not available for this task right now.',
      });
      return;
    }
    setBlockedHover(null);

    const overRect = over.rect;
    // Only place the ghost when entering a different column; while inside
    // one, dnd-kit's own sortable displacement previews further movement.
    setDragPreview((previous) => {
      if (previous?.column === overColumn) return previous;
      const destEntries = sortedByColumn.get(overColumn) ?? [];
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
      // Dropping on the card's own slot. Without a cross-column preview this
      // is a no-op — but when the preview holds the card in a foreign
      // column, the "own slot" IS the ghost: persist the previewed position.
      // Stage authority (ticket #48): `previewColumn` can never be an unsafe
      // destination for a governing card — `handleDragOver` refuses to set
      // the preview there in the first place — so no extra guard is needed.
      if (previewColumn && dragPreview) {
        const entries = (sortedByColumn.get(previewColumn) ?? []).filter(
          (entry) => entry.id !== activeId
        );
        const position = computeDropPosition(previewColumn, entries, dragPreview.index);
        void store.updateBoardPosition(position.stage, position.rank);
      }
      return;
    }

    const overColumn = parseColumnDropId(overId);
    const overCardId = overColumn ? undefined : overId;
    const destinationColumn = overColumn ?? columnByCardId.get(overId);
    if (!destinationColumn) return;

    // Stage authority (ticket #48): the authoritative enforcement point — the
    // preview guard in `handleDragOver` keeps the ghost from ever entering an
    // unsafe destination, but dnd-kit's own collision detection is untouched
    // and can still resolve `over` there on a fast gesture. No move is
    // persisted for a genuinely GitHub-authoritative card's cross-stage drop
    // unless `isStageDestinationSafe` agrees (#56).
    if (destinationColumn !== sourceColumn) {
      const authority = authorityByCardId.get(activeId);
      const destinationStage = columnToStage(destinationColumn);
      if (authority?.governs && !isStageDestinationSafe(authority.fact, destinationStage)) {
        captureTelemetry('board_move_blocked', {
          from_stage: sourceColumn ? columnToStage(sourceColumn) : null,
          attempted_stage: destinationStage,
          governing_fact: authority.fact.kind,
          project_id: projectId,
        });
        return;
      }
    }

    const destinationEntries = (sortedByColumn.get(destinationColumn) ?? []).filter(
      (entry) => entry.id !== activeId
    );

    let dropIndex = destinationEntries.length;
    if (overCardId) {
      if (effectiveColumnOf(activeId) === destinationColumn) {
        // The active card already lives in this column — natively, or as the
        // cross-column drag preview ghost. dnd-kit's sortable displacement
        // has already decided the slot (arrayMove semantics): the over
        // card's index in the rendered list (ghost included) is the drop
        // index in the filtered one, in both directions. Rect math is wrong
        // here: the over card is visually displaced mid-drag and the
        // DragOverlay preview is shorter than the card, which biases any
        // centre comparison upward.
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

    const { stage, rank } = computeDropPosition(destinationColumn, destinationEntries, dropIndex);
    void store.updateBoardPosition(stage, rank);
  }

  // Column-first collision: the column under the pointer always wins, then
  // the closest card within that column (or the column zone itself when it
  // has none). Plain closestCenter compares a neighbouring column's small
  // card rect against this column's tall zone rect and picks the neighbour —
  // hovering the top of a column would stack cards into the column next door.
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
    // a foreign column, it must be a collision candidate there (hovering the
    // ghost's own slot must resolve to the active card → no displacement),
    // and must not be one in its source column anymore.
    const cards = args.droppableContainers.filter(
      (container) => effectiveColumnOf(String(container.id)) === column
    );
    // Rank cards by distance to the *pointer*, not to the DragOverlay rect:
    // the overlay preview is shorter than a card, so its centre sits above
    // the pointer and biases every above/below decision upward (the swap
    // animation triggered ~24px later dragging down than dragging up).
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

  // Shared column renderer for all three groups below (Unstaged, the
  // six-stage pipeline, Triage) so every column keeps the same wiring —
  // only grouping and emphasis differ.
  const renderColumn = (column: ColumnId) => (
    <BoardColumn
      key={column}
      column={column}
      entries={displayByColumn.get(column) ?? []}
      storeById={storeById}
      selectedTaskId={panelTarget?.kind === 'task' ? panelTarget.taskId : null}
      onSelectTask={(taskId) => setPanelTarget({ kind: 'task', taskId })}
      onOpenTask={handleOpenTask}
      // Ghost Cards (ticket #9) are not tasks and never sort/drag — they
      // only ever live in the `idea` column, after real cards.
      ghostCards={column === 'idea' ? ghostCards : undefined}
      selectedGhostCardId={panelTarget?.kind === 'ghost' ? panelTarget.ghostCard.id : null}
      onSelectGhostCard={(ghostCard) => setPanelTarget({ kind: 'ghost', ghostCard })}
      onAdoptGhostCard={handleAdoptGhostCard}
      onRejectGhostCard={rejectGhostCard}
      isCollapsed={collapsedColumns.has(column)}
      onToggleCollapsed={() => toggleColumnCollapsed(column)}
      // Collapsible empty columns (ticket #46): the column currently under
      // the cross-column drag preview must expand for the duration of the
      // drag regardless of its collapsed toggle, so a collapsed column
      // never becomes a harder-to-hit drop target mid-gesture.
      isDragHovered={previewColumn === column}
      // Stage authority (ticket #48): pass through the currently-hovered
      // blocked destination, if this is it.
      isBlockedDestination={blockedHover?.column === column}
      blockedDestinationExplanation={
        blockedHover?.column === column ? blockedHover.explanation : null
      }
    />
  );

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      <div className="flex items-baseline gap-2 px-4 pt-4 pb-2">
        <h1 className="text-sm font-medium">Feature board</h1>
        <span className="text-xs text-foreground-muted">{projectName}</span>
      </div>
      <BoardLinkSuggestions projectId={projectId} />
      {/* Task Detail Panel (CONTEXT.md): a fixed-width sibling to the right of
          the board, not an overlay — the board stays fully interactive
          (including drag-and-drop) while it is open. */}
      <div className="flex min-h-0 flex-1">
        <DndContext
          sensors={sensors}
          collisionDetection={columnAwareCollision}
          // The board always overflows horizontally (8 fixed-width columns), so
          // dnd-kit's default 20%-of-container autoscroll band covers a whole
          // visible column: hovering a drop target inside it scrolls the board
          // under the pointer and the drop lands columns to the right of the
          // one the user aimed at. 5% keeps edge-push scrolling for offscreen
          // columns while leaving visible targets stationary.
          autoScroll={{ threshold: { x: 0.05, y: 0.2 } }}
          // Collapsible empty columns (ticket #46) resize during a drag (see
          // `isDragHovered` above): dnd-kit's default measuring strategy only
          // re-measures droppable rects on scroll, so a column that expands
          // mid-hover would leave stale (narrow) cached geometry behind it.
          // `Always` keeps every droppable rect current for the columns this
          // feature can resize; it is a no-op for the fixed-width case every
          // existing drag test exercises.
          measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
          onDragStart={handleDragStart}
          onDragOver={handleDragOver}
          onDragEnd={handleDragEnd}
          onDragCancel={handleDragCancel}
        >
          <div className="flex flex-1 gap-3 overflow-x-auto px-4 pb-4">
            {renderColumn('unstaged')}
            {/* Exception groups (CONTEXT.md "Unstaged", "Triage"; ticket
                #46): Unstaged and Triage sit outside the six-stage delivery
                pipeline, separated from it by a divider plus their own
                styling (see `columnEmphasis`) — deliberately so Triage never
                reads as the stage that follows Shipped. */}
            <BoardColumnGroupDivider />
            {PIPELINE_COLUMNS.map((column) => renderColumn(column))}
            <BoardColumnGroupDivider />
            {renderColumn('triage')}
          </div>
          <DragOverlay>
            {activeDragStore ? <BoardCardPreview store={activeDragStore} /> : null}
          </DragOverlay>
        </DndContext>
        {/* Stage authority (ticket #48): announces the disabled-destination
            explanation to screen readers as a drag hovers it. Visually
            hidden — the column itself carries the same text via
            `aria-label`/`title` for pointer users and assistive tech that
            reads the hovered element directly. `data-board-status` keeps
            this region distinguishable from dnd-kit's own built-in
            drag-announcement live region, which also renders `role="status"`. */}
        <div data-board-status role="status" aria-live="polite" className="sr-only">
          {blockedHover?.explanation ?? ''}
        </div>
        {panelTarget && (
          <TaskDetailPanel
            projectId={projectId}
            target={panelTarget}
            onClose={() => setPanelTarget(null)}
            onOpenTask={handleOpenTask}
            onAdoptGhostCard={handleAdoptGhostCard}
            onRejectGhostCard={rejectGhostCard}
          />
        )}
      </div>
    </div>
  );
});

/** Decorative separator between the Unstaged/pipeline/Triage groups (ticket #46). */
function BoardColumnGroupDivider() {
  return <div aria-hidden="true" className="mx-1 w-px shrink-0 self-stretch bg-border" />;
}

/** Column emphasis (CONTEXT.md "Unstaged", "Triage"): accessible name suffix
 *  and visual treatment for the two exception groups. Triage additionally
 *  pairs the warning styling with an icon and this text so the warning
 *  never depends on colour alone. */
const EMPHASIS_ARIA_SUFFIX: Record<ColumnEmphasis, string> = {
  pipeline: '',
  unstaged: ' — exception group, outside the delivery pipeline',
  triage:
    ' — warning: exception stage for contradicted delivery facts, not part of the delivery pipeline',
};

const BoardColumn = observer(function BoardColumn({
  column,
  entries,
  storeById,
  selectedTaskId,
  onSelectTask,
  onOpenTask,
  ghostCards,
  selectedGhostCardId,
  onSelectGhostCard,
  onAdoptGhostCard,
  onRejectGhostCard,
  isCollapsed,
  onToggleCollapsed,
  isDragHovered,
  isBlockedDestination,
  blockedDestinationExplanation,
}: {
  column: ColumnId;
  entries: CardEntry[];
  storeById: Map<string, TaskStore>;
  selectedTaskId: string | null;
  onSelectTask: (taskId: string) => void;
  onOpenTask: (taskId: string) => void;
  ghostCards?: GhostCard[];
  selectedGhostCardId?: string | null;
  onSelectGhostCard: (ghostCard: GhostCard) => void;
  onAdoptGhostCard: (ghostCard: GhostCard) => void;
  onRejectGhostCard: (ghostCard: GhostCard) => void;
  isCollapsed: boolean;
  onToggleCollapsed: () => void;
  isDragHovered: boolean;
  /** Stage authority (ticket #48): true while the currently dragged card is
   * hovering this column and its governing fact forbids the drop. */
  isBlockedDestination: boolean;
  /** Accessible explanation naming the governing fact and the action
   * required to unlock the move — set only while `isBlockedDestination`. */
  blockedDestinationExplanation: string | null;
}) {
  const cardCount = entries.length + (ghostCards?.length ?? 0);
  const { setNodeRef, isOver } = useDroppable({ id: columnDropId(column) });
  // Keep the ids array referentially stable while its contents are unchanged:
  // useDroppable re-renders this column on every drag movement, and a fresh
  // array each render makes useSortable's `items !== previousItems` check
  // disable the make-room transition exactly when the displacement transform
  // lands — cards snap instead of animating.
  const cardIdsKey = entries.map((entry) => entry.id).join('\n');
  const cardIds = useMemo(() => (cardIdsKey ? cardIdsKey.split('\n') : []), [cardIdsKey]);

  const emphasis = columnEmphasis(column);
  // Collapsible empty columns (ticket #46): only ever collapsible while
  // actually empty, and forced back open for the duration of a drag that is
  // currently hovering it. Keyboard focus is handled separately below by a
  // plain CSS `focus-within` override, so it keeps working even if focus
  // lands on the collapsed drop zone itself rather than the toggle button —
  // no React state round-trip needed for that path.
  const isCollapsible = cardCount === 0;
  const effectiveCollapsed = isCollapsed && isCollapsible && !isDragHovered;

  return (
    <div
      role="group"
      aria-label={`${STAGE_LABELS[column]} column${EMPHASIS_ARIA_SUFFIX[emphasis]}`}
      className={cn(
        'flex shrink-0 flex-col rounded-lg border',
        effectiveCollapsed ? 'w-14' : 'w-56',
        // A collapsed column must expand for the duration of a keyboard
        // focus interaction too (ticket #46) — `focus-within` covers both
        // the toggle button below and the collapsed drop zone's own
        // `tabIndex`, and is a no-op once already expanded.
        isCollapsible && 'focus-within:w-56',
        emphasis === 'pipeline' && 'border-border bg-background-2/40',
        emphasis === 'unstaged' && 'border-dashed border-border bg-background-2/20',
        emphasis === 'triage' && 'border-dashed border-border-warning bg-background-warning/30'
      )}
      // Stage authority (ticket #48): `aria-disabled` and `title` name the
      // disabled destination for pointer users (native tooltip) and
      // assistive tech that reads the hovered element directly, alongside
      // the aria-live announcement rendered once at the board level.
      aria-disabled={isBlockedDestination || undefined}
      title={isBlockedDestination ? (blockedDestinationExplanation ?? undefined) : undefined}
    >
      <div className="flex items-center gap-1 px-3 py-2">
        {isCollapsible && (
          <button
            type="button"
            aria-label={`${isCollapsed ? 'Expand' : 'Collapse'} ${STAGE_LABELS[column]} column`}
            aria-expanded={!effectiveCollapsed}
            onClick={onToggleCollapsed}
            className="-ml-1 shrink-0 rounded p-0.5 text-foreground-muted hover:text-foreground"
          >
            <ChevronRight
              className={cn('size-3.5 transition-transform', !effectiveCollapsed && 'rotate-90')}
            />
          </button>
        )}
        {/* Triage's warning semantics (ticket #46) pair this icon with the
            warning-tinted label text below — never colour alone. */}
        {emphasis === 'triage' && (
          <AlertTriangle aria-hidden="true" className="size-3.5 shrink-0 text-foreground-warning" />
        )}
        <span
          className={cn(
            'truncate text-xs font-medium',
            emphasis === 'triage' ? 'text-foreground-warning' : 'text-foreground-muted'
          )}
          title={STAGE_LABELS[column]}
        >
          {STAGE_LABELS[column]}
        </span>
        <Badge variant="secondary" className="ml-auto shrink-0">
          {cardCount}
        </Badge>
      </div>
      <SortableContext items={cardIds} strategy={verticalListSortingStrategy}>
        <div
          ref={setNodeRef}
          // A collapsed column stays a focusable, labeled drop target even
          // with no cards inside to carry focus themselves (ticket #46).
          tabIndex={effectiveCollapsed ? 0 : undefined}
          aria-label={
            effectiveCollapsed
              ? `${STAGE_LABELS[column]} drop target, collapsed and empty`
              : undefined
          }
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
              />
            );
          })}
          {/* Ghost Cards are not tasks: rendered after the sortable cards, never draggable. */}
          {ghostCards?.map((ghostCard) => (
            <GhostCardView
              key={ghostCard.id}
              ghostCard={ghostCard}
              isSelected={ghostCard.id === selectedGhostCardId}
              onSelect={() => onSelectGhostCard(ghostCard)}
              onAdopt={() => onAdoptGhostCard(ghostCard)}
              onReject={() => onRejectGhostCard(ghostCard)}
            />
          ))}
        </div>
      </SortableContext>
    </div>
  );
});

const BoardCard = observer(function BoardCard({
  store,
  isSelected,
  onSelect,
  onOpenTask,
}: {
  store: TaskStore;
  isSelected: boolean;
  onSelect: (taskId: string) => void;
  onOpenTask: (taskId: string) => void;
}) {
  const { setNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({
    id: store.data.id,
    animateLayoutChanges: animateBoardLayoutChanges,
  });
  const task = registeredTaskData(store);
  if (!task) return null;

  // Card information hierarchy (ticket #47): every fact below comes from an
  // existing task selector or presentation primitive — the same ones the
  // Task Detail Panel, the sidebar and the project List view already read —
  // so a card can never disagree with them about a task's agent state, PR,
  // Linked Issue, or diff totals (the ticket's load-bearing "no duplicate
  // state pipeline" criterion).
  const agentStatus = taskAgentStatus(store);
  const artifact = deriveCardArtifact(task);
  const hasProviders = Object.keys(store.conversationStats).length > 0;
  const activityInstant = taskActivityInstant(task);

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  // Re-clicking the already-shown card is a no-op (no toggle): this always
  // (re-)selects `task.id`, never clears it.
  const handleSelect = () => onSelect(task.id);

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      onClick={handleSelect}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          handleSelect();
        }
      }}
      className={cn(
        'group relative flex cursor-grab touch-none flex-col gap-1 rounded-md border border-border bg-background p-2 shadow-sm active:cursor-grabbing',
        // The card backing the open Task Detail Panel (CONTEXT.md) is highlighted.
        isSelected && 'border-primary ring-1 ring-primary/50'
      )}
    >
      {/* Direct navigation (CONTEXT.md "Task Detail Panel"): hover-revealed,
          navigates straight to the full task view instead of the panel.
          `onPointerDown` stops here so dnd-kit's drag activation (attached to
          this card via `listeners`) never sees the press, and the click
          itself stops here too so it never also opens/switches the panel.
          `onKeyDown` stops here for the same reason on the keyboard path: a
          keydown still bubbles to the card's own onKeyDown (Enter/Space ->
          handleSelect) even though a click does not. */}
      <button
        type="button"
        aria-label={`Open ${task.name}`}
        title="Open task"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          onOpenTask(task.id);
        }}
        onKeyDown={(event) => event.stopPropagation()}
        className="absolute top-1 right-1 rounded p-0.5 text-foreground-muted opacity-0 transition-opacity group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100"
      >
        <ArrowUpRight className="size-3.5" />
      </button>

      {/* Title (ticket #47): wraps to a small, bounded number of lines — a
          long name never grows the card past two lines. `title` keeps the
          full name reachable on hover; card fields stay fixed, not
          user-configurable. */}
      <span
        className="line-clamp-2 block w-full pr-4 text-left text-xs font-medium"
        title={task.name}
      >
        {task.name}
      </span>

      {/* Actionable agent state: the fact the card leads with, since it
          answers "what needs my attention?" (CONTEXT.md). Always carries a
          visible text label — never colour or a bare dot alone — because two
          of the four non-idle states already share the same dot colour. */}
      <BoardCardAgentState status={agentStatus} />

      {/* Most relevant delivery artifact + code-change statistics. Both
          degrade gracefully for a purely local task: `artifact` is `null`
          with no Linked Issue or PR, and `TaskGitDiffStats` already hides
          itself when there is nothing to show. */}
      <div className="flex flex-wrap items-center gap-1.5 empty:hidden">
        {artifact && (
          <Badge variant="outline" title={cardArtifactTitle(artifact)} className="gap-1">
            {artifact.kind === 'pr' && (
              <StatusIcon pr={artifact.pr} className="size-3" disableTooltip />
            )}
            {cardArtifactBadgeText(artifact)}
          </Badge>
        )}
        <TaskGitDiffStats task={store} />
      </div>

      {/* Compact provider/session context + recent activity. */}
      {(hasProviders || activityInstant) && (
        <div className="flex items-center gap-1.5">
          {hasProviders && <StackedAgentLogos stats={store.conversationStats} />}
          {activityInstant && (
            <RelativeTime
              value={activityInstant}
              compact
              className="ml-auto shrink-0 text-[10px] text-foreground-passive"
            />
          )}
        </div>
      )}
    </div>
  );
});

/**
 * Card-local agent-state chip (ticket #47): a compact, always-visible label
 * for the five states `taskAgentStatus` distinguishes (Working, Awaiting
 * Input, Error, Completed, Idle). Reuses `AgentStatusIndicator` — the same
 * icon `AgentStatus` already renders elsewhere (sidebar, Task Detail Panel) —
 * for the four non-idle states, so the glyph itself is never redefined; the
 * always-visible text label is what the ticket actually requires, since two
 * of those four states (`awaiting-input`, `completed`) already share the
 * same dot colour and would otherwise be indistinguishable without it.
 * `role="status"` plus `aria-label` gives the whole chip one queryable
 * accessible name for assistive tech, on top of the plain visible text.
 */
function BoardCardAgentState({ status }: { status: AgentStatus | null }) {
  const label = agentStateLabel(status);
  const toneClass =
    status === 'error'
      ? 'text-foreground-error'
      : status === 'awaiting-input' || status === 'completed'
        ? 'text-foreground-info'
        : status === 'working'
          ? 'text-foreground-muted'
          : 'text-foreground-passive';

  return (
    <span
      role="status"
      aria-label={`Agent status: ${label}`}
      className={cn('flex items-center gap-1 text-[10px] font-medium', toneClass)}
    >
      {status && status !== 'idle' && <AgentStatusIndicator status={status} disableTooltip />}
      <span>{label}</span>
    </span>
  );
}

/** Lightweight drag-preview rendered in the `DragOverlay` — no dnd-kit listeners attached. */
function BoardCardPreview({ store }: { store: TaskStore }) {
  const task = registeredTaskData(store);
  if (!task) return null;
  return (
    <div className="w-56 cursor-grabbing rounded-md border border-border bg-background p-2 shadow-lg">
      <span className="text-xs font-medium">{task.name}</span>
    </div>
  );
}
