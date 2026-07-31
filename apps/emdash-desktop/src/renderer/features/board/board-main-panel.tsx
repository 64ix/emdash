import {
  closestCenter,
  DndContext,
  DragOverlay,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  type ClientRect,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { MessageSquare } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
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

  function handleDragStart(event: DragStartEvent) {
    setActiveDragId(String(event.active.id));
  }

  function handleDragCancel() {
    setActiveDragId(null);
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveDragId(null);
    const { active, over } = event;
    if (!over) return;
    const activeId = String(active.id);
    const overId = String(over.id);
    if (activeId === overId) return;

    const store = storeById.get(activeId);
    if (!store) return;

    const overColumn = parseColumnDropId(overId);
    const overCardId = overColumn ? undefined : overId;
    const destinationColumn = overColumn ?? columnByCardId.get(overId);
    if (!destinationColumn) return;

    const destinationEntries = (sortedByColumn.get(destinationColumn) ?? []).filter(
      (entry) => entry.id !== activeId
    );

    let dropIndex = destinationEntries.length;
    if (overCardId) {
      const overIndex = destinationEntries.findIndex((entry) => entry.id === overCardId);
      if (overIndex !== -1) {
        const activeRect = active.rect.current.translated ?? active.rect.current.initial;
        dropIndex = isAboveTarget(activeRect, over.rect) ? overIndex : overIndex + 1;
      }
    }

    const { stage, rank } = computeDropPosition(destinationColumn, destinationEntries, dropIndex);
    void store.updateBoardPosition(stage, rank);
  }

  const activeDragStore = activeDragId ? storeById.get(activeDragId) : undefined;

  return (
    <div className="flex h-full flex-col bg-background text-foreground">
      <div className="flex items-baseline gap-2 px-4 pt-4 pb-2">
        <h1 className="text-sm font-medium">Feature board</h1>
        <span className="text-xs text-foreground-muted">{projectName}</span>
      </div>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCenter}
        onDragStart={handleDragStart}
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
        <DragOverlay dropAnimation={null}>
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
  const cardIds = entries.map((entry) => entry.id);

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
          <Badge variant="outline">{task.status}</Badge>
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
