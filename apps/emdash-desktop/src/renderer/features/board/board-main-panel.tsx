import {
  closestCenter,
  DndContext,
  DragOverlay,
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
import { MessageSquare } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useMemo, useState } from 'react';
import {
  getProjectStore,
  projectDisplayName,
} from '@renderer/features/projects/stores/project-selectors';
import {
  getTaskManagerStore,
  taskAgentStatus,
} from '@renderer/features/tasks/stores/task-selectors';
import { registeredTaskData, type TaskStore } from '@renderer/features/tasks/stores/task-store';
import { AgentStatusIndicator } from '@renderer/lib/components/agent-status-indicator';
import { useNavigate, useParams } from '@renderer/lib/layout/navigation-provider';
import { Badge } from '@renderer/lib/ui/badge';
import { cn } from '@renderer/utils/utils';
import {
  COLUMNS,
  computeDropPosition,
  partitionAwaitingInput,
  sortColumn,
  stageOf,
  type ColumnId,
} from './board-ordering';

const STAGE_LABELS: Record<ColumnId, string> = {
  unstaged: 'Unstaged',
  idea: 'Idea',
  grilled: 'Grilled',
  spec: 'Spec',
  tickets: 'Tickets',
  implementing: 'Implementing',
  pr: 'PR',
  shipped: 'Shipped',
};

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
  const manager = getTaskManagerStore(projectId);
  const projectName = projectDisplayName(getProjectStore(projectId)) ?? 'Project';
  const [activeDragId, setActiveDragId] = useState<string | null>(null);
  // While dragging over a foreign column, the active card is moved into that
  // column's list (display only) so its SortableContext owns it: the ghost
  // slot and make-room displacement then work across columns exactly like
  // they do within one. Persistence still derives from store data at drop.
  const [dragPreview, setDragPreview] = useState<{ column: ColumnId; index: number } | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  if (!manager) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-foreground-muted">
        Open the project first so its tasks are loaded.
      </div>
    );
  }

  const storeById = new Map<string, TaskStore>();
  const rawByColumn = new Map<ColumnId, CardEntry[]>(COLUMNS.map((c) => [c, []]));
  for (const [, store] of manager.tasks) {
    const task = registeredTaskData(store);
    if (!task || task.archivedAt || task.type !== 'task') continue;
    storeById.set(task.id, store);
    rawByColumn.get(stageOf(task))?.push({ id: task.id, rank: task.boardRank ?? null });
  }

  const awaitingInputIds = new Set<string>();
  for (const [id, store] of storeById) {
    if (taskAgentStatus(store) === 'awaiting-input') awaitingInputIds.add(id);
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
  }

  function handleDragOver(event: DragOverEvent) {
    const { active, over } = event;
    const activeId = String(active.id);
    const sourceColumn = columnByCardId.get(activeId);
    if (!over || !sourceColumn) {
      setDragPreview(null);
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
      return;
    }
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
    const { active, over } = event;
    if (!over) return;
    const activeId = String(active.id);
    const overId = String(over.id);
    const store = storeById.get(activeId);
    if (!store) return;

    if (activeId === overId) {
      // Dropping on the card's own slot. Without a cross-column preview this
      // is a no-op — but when the preview holds the card in a foreign
      // column, the "own slot" IS the ghost: persist the previewed position.
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

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      <div className="flex items-baseline gap-2 px-4 pt-4 pb-2">
        <h1 className="text-sm font-medium">Feature board</h1>
        <span className="text-xs text-foreground-muted">{projectName}</span>
      </div>
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
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
        onDragCancel={handleDragCancel}
      >
        <div className="flex flex-1 gap-3 overflow-x-auto px-4 pb-4">
          {COLUMNS.map((column) => (
            <BoardColumn
              key={column}
              column={column}
              entries={displayByColumn.get(column) ?? []}
              storeById={storeById}
              projectId={projectId}
            />
          ))}
        </div>
        <DragOverlay>
          {activeDragStore ? <BoardCardPreview store={activeDragStore} /> : null}
        </DragOverlay>
      </DndContext>
    </div>
  );
});

const BoardColumn = observer(function BoardColumn({
  column,
  entries,
  storeById,
  projectId,
}: {
  column: ColumnId;
  entries: CardEntry[];
  storeById: Map<string, TaskStore>;
  projectId: string;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: columnDropId(column) });
  // Keep the ids array referentially stable while its contents are unchanged:
  // useDroppable re-renders this column on every drag movement, and a fresh
  // array each render makes useSortable's `items !== previousItems` check
  // disable the make-room transition exactly when the displacement transform
  // lands — cards snap instead of animating.
  const cardIdsKey = entries.map((entry) => entry.id).join('\n');
  const cardIds = useMemo(() => (cardIdsKey ? cardIdsKey.split('\n') : []), [cardIdsKey]);

  return (
    <div className="flex w-56 shrink-0 flex-col rounded-lg border border-border bg-background-2/40">
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-xs font-medium text-foreground-muted">{STAGE_LABELS[column]}</span>
        <Badge variant="secondary">{entries.length}</Badge>
      </div>
      <SortableContext items={cardIds} strategy={verticalListSortingStrategy}>
        <div
          ref={setNodeRef}
          className={cn(
            'flex flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2',
            isOver && 'bg-foreground/5'
          )}
        >
          {entries.map((entry) => {
            const store = storeById.get(entry.id);
            if (!store) return null;
            return <BoardCard key={entry.id} store={store} projectId={projectId} />;
          })}
        </div>
      </SortableContext>
    </div>
  );
});

const BoardCard = observer(function BoardCard({
  store,
  projectId,
}: {
  store: TaskStore;
  projectId: string;
}) {
  const { navigate } = useNavigate();
  const { setNodeRef, attributes, listeners, transform, transition, isDragging } = useSortable({
    id: store.data.id,
    animateLayoutChanges: animateBoardLayoutChanges,
  });
  const task = registeredTaskData(store);
  if (!task) return null;

  const sessionCount = Object.values(store.conversationStats).reduce((a, b) => a + b, 0);
  const agentStatus = taskAgentStatus(store);

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className="cursor-grab touch-none rounded-md border border-border bg-background p-2 shadow-sm active:cursor-grabbing"
    >
      <button
        className="w-full text-left text-xs font-medium hover:underline"
        onClick={() => navigate('task', { projectId, taskId: task.id })}
      >
        {task.name}
      </button>
      <div className="mt-1.5 flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          {sessionCount > 0 && (
            <span className="flex items-center gap-0.5 text-[10px] text-foreground-muted">
              <MessageSquare className="size-3" />
              {sessionCount}
            </span>
          )}
        </div>
        {agentStatus === 'awaiting-input' && <AgentStatusIndicator status={agentStatus} />}
      </div>
    </div>
  );
});

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
