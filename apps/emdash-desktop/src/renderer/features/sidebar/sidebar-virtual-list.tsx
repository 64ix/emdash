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
import { useVirtualizer } from '@tanstack/react-virtual';
import { observer } from 'mobx-react-lite';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { isBoardRankCandidate } from '@renderer/features/board/board-columns';
import { sortColumn, type ColumnId } from '@renderer/features/board/board-ordering';
import {
  computeSidebarDropPosition,
  sidebarStageMoveOptions,
  taskRowVariants,
  type SidebarRow,
} from '@renderer/features/sidebar/stage-group-row-model';
import {
  getTaskGitWorktreeStore,
  getTaskManagerStore,
  getTaskStore,
} from '@renderer/features/tasks/stores/task-selectors';
import { registeredTaskData } from '@renderer/features/tasks/stores/task-store';
import { useToast } from '@renderer/lib/hooks/use-toast';
import { activeProjectIdForView } from '@renderer/lib/layout/active-project';
import { useParams, useWorkspaceSlots } from '@renderer/lib/layout/navigation-provider';
import { sidebarStore } from '@renderer/lib/stores/app-state';
import type { WorkflowStage } from '@shared/core/tasks/tasks';
import { SidebarProjectItem } from './project-item';
import { SidebarStageGroupItem } from './stage-group-item';
import { SidebarTaskItem } from './task-item';

const ROW_HEIGHT = 32;

export const SidebarVirtualList = observer(function SidebarVirtualList() {
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

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const { toast } = useToast();

  const activeTaskProjectExpanded =
    currentView === 'task' && taskParams.projectId
      ? sidebarStore.expandedProjectIds.has(taskParams.projectId)
      : null;
  // Stage Group headers (spec #85) are fixed anchors, never sortable —
  // dnd-kit's sortable id list only ever contains project and task rows.
  const allDndIds = useMemo(() => rows.filter(isSortableRow).map(rowToDndId), [rows]);

  // Per-task render indent: `grouped` inside a Stage Group, `underProject`
  // for Unstaged loose rows (spec #85 Implementation Decisions).
  const taskVariants = useMemo(() => taskRowVariants(rows), [rows]);

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  });

  // Expand the parent project when navigating to a task (not when `rows` changes —
  // otherwise collapsing while staying on that task would immediately re-expand).
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

  // Scroll the active project/task into view only when the navigation target itself
  // changes, plus the active task's project expansion state. Re-running on every
  // `rows` change would yank the user back to the active row whenever the
  // sidebar mutates (e.g. deleting an unrelated task), but direct navigation to a
  // task in a collapsed project needs one rerun after `ensureProjectExpanded`.
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  useEffect(() => {
    // `activeProjectIdForView` also resolves `board` — opening a project's
    // board scrolls that project's row into view exactly like opening its
    // task list does.
    const targetProjectId = activeProjectIdForView(currentView, {
      task: taskParams.projectId,
      project: projectParams.projectId,
      board: boardParams.projectId,
    });
    const targetTaskId = currentView === 'task' ? (taskParams.taskId ?? null) : null;

    if (!targetProjectId) return;

    if (targetTaskId) {
      const activeTask = getTaskStore(targetProjectId, targetTaskId);
      if (activeTask?.data.isPinned) {
        return;
      }
    }

    const activeIndex = rowsRef.current.findIndex((row) => {
      if (targetTaskId) {
        return (
          row.kind === 'task' && row.taskId === targetTaskId && row.projectId === targetProjectId
        );
      }
      return row.kind === 'project' && row.projectId === targetProjectId;
    });

    if (activeIndex >= 0) {
      virtualizer.scrollToIndex(activeIndex, { align: 'auto' });
    }
  }, [
    currentView,
    taskParams.projectId,
    taskParams.taskId,
    projectParams.projectId,
    boardParams.projectId,
    activeTaskProjectExpanded,
    virtualizer,
  ]);

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
    const aParsed = parseDndId(String(active.id));
    const oParsed = parseDndId(String(over.id));
    if (!aParsed || !oParsed) return;

    const isAbove = isCursorAbove(pointerY, active.rect.current.translated, over.rect);

    if (aParsed.kind === 'project') {
      const overRowIdx = rows.findIndex(
        (r) => isSortableRow(r) && rowToDndId(r) === String(over.id)
      );
      if (overRowIdx === -1) return;
      const insertionRowIdx = isAbove ? overRowIdx : overRowIdx + 1;
      const ids = sidebarStore.orderedProjects
        .map((p) => (p.state === 'unregistered' ? p.id : (p.data?.id ?? '')))
        .filter(Boolean);
      const oldIdx = ids.indexOf(aParsed.projectId);
      if (oldIdx === -1) return;
      const projectsAbove = rows
        .slice(0, insertionRowIdx)
        .filter((r) => r.kind === 'project').length;
      let newIdx = projectsAbove;
      if (newIdx > oldIdx) newIdx -= 1;
      if (newIdx === oldIdx) return;
      sidebarStore.setProjectOrder(arrayMove(ids, oldIdx, newIdx));
    } else if (oParsed.kind === 'task' && oParsed.projectId === aParsed.projectId) {
      // Task drags (spec #85, ticket #89): grouped mode writes the board's
      // stage and Board Rank fields through `updateBoardPosition` — the same
      // path the Feature Board and the "Move to stage…" menu use (ADR 0006).
      // The stale manual task order is inert in grouped mode and never
      // written (spec: no data migration).
      const projectId = aParsed.projectId;
      const task = getTaskStore(projectId, aParsed.taskId);
      if (!task) return;
      const overRowIdx = rows.findIndex(
        (r) => isSortableRow(r) && rowToDndId(r) === String(over.id)
      );
      if (overRowIdx === -1) return;
      const overRow = rows[overRowIdx];
      if (overRow.kind !== 'task') return;
      const activeRowIdx = rows.findIndex(
        (r) => isSortableRow(r) && rowToDndId(r) === String(active.id)
      );
      if (activeRowIdx === -1) return;

      // The destination column: the group whose header precedes the over row
      // (the row model's own layout), or `unstaged` when no header precedes.
      const destinationColumn: ColumnId = taskRowStage(rows, overRowIdx) ?? 'unstaged';
      const destinationStage = destinationColumn === 'unstaged' ? null : destinationColumn;

      // Board authority gating (ADR 0006): only a cross-stage drop can be
      // overwritten by the next sync pass — a same-group drop never changes
      // the stage, exactly like the board's same-column reorder. A blocked
      // destination is rejected with the board's own explanation as feedback
      // (the same `fact + action` text the board shows for blocked drops).
      const authority = taskDropAuthority(
        projectId,
        aParsed.taskId,
        taskRowStage(rows, activeRowIdx),
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

      // The destination's visible task rows in rendered order, dragged card
      // excluded — the drop slot the user aimed at is decided by these rows.
      const destRows: { idx: number; taskId: string; rank: string | null }[] = [];
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (row.kind !== 'task' || row.projectId !== projectId) continue;
        if ((taskRowStage(rows, i) ?? 'unstaged') !== destinationColumn) continue;
        if (row.taskId === aParsed.taskId) continue;
        const destTask = getTaskStore(projectId, row.taskId);
        const destRegistered = destTask ? registeredTaskData(destTask) : null;
        destRows.push({
          idx: i,
          taskId: row.taskId,
          rank: destRegistered?.boardRank ?? null,
        });
      }

      // Rank math mirrors the board exactly (`computeDropPosition`): the
      // drop index is the over row's position among the destination's
      // `sortColumn`-ordered entries, above or below per the pointer. Dropping
      // below the destination's last rendered row is an unpositioned
      // end-of-group drop — stage-only, `rank: null`, so the task lands
      // unranked after the ranked tasks (spec user story 16).
      const destSorted = sortColumn(destRows);
      const overSortedIdx = destSorted.findIndex((entry) => entry.taskId === oParsed.taskId);
      if (overSortedIdx === -1) return;
      const dropIndex: number | null =
        !isAbove && destRows.length > 0 && destRows[destRows.length - 1]!.idx === overRowIdx
          ? null
          : overSortedIdx + (isAbove ? 0 : 1);

      // True (pre-visibility) entries for the rank math — every task holding
      // a Board Rank in the destination column, hidden or Shipped-Faded rows
      // included — so the interpolation never reproduces a card's stored rank
      // the user cannot see. The board's own `trueEntries` guard (ticket #45)
      // uses `isBoardRankCandidate` for exactly this set and passes it
      // `sortColumn`-ordered (its `trueSortedByColumn`); the sidebar's
      // visibility filter (ticket #87) hides some of the same cards.
      const trueDestEntries: { id: string; rank: string | null }[] = [];
      const taskManager = getTaskManagerStore(projectId);
      if (taskManager) {
        for (const [, candidate] of taskManager.tasks) {
          const candidateData = registeredTaskData(candidate);
          if (!candidateData || candidateData.id === aParsed.taskId) continue;
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
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={sidebarCollision}
      measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
      autoScroll={{ threshold: { x: 0, y: 0.18 }, acceleration: 8, interval: 5 }}
      onDragStart={handleDragStart}
      onDragMove={handleDragMove}
      onDragEnd={handleDragEnd}
      onDragCancel={clearDragPointerY}
    >
      <SortableContext items={allDndIds} strategy={verticalListSortingStrategy}>
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-3 pt-1 pb-3">
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((vItem) => {
              const row = rows[vItem.index];
              if (!row) return null;
              const vStyle: React.CSSProperties = {
                position: 'absolute',
                top: vItem.start,
                left: 0,
                width: '100%',
                height: `${vItem.size}px`,
              };
              if (row.kind === 'stage-group') {
                // Stage Group headers (spec #85) are fixed anchors: never
                // draggable, never part of the sortable set.
                return (
                  <div key={`stage-group:${row.projectId}:${row.stage}`} style={vStyle}>
                    <SidebarStageGroupItem
                      projectId={row.projectId}
                      stage={row.stage}
                      label={row.label}
                      count={row.count}
                    />
                  </div>
                );
              }
              const dndId = rowToDndId(row);
              if (row.kind === 'project') {
                return (
                  <SortableRow key={row.projectId} dndId={dndId} style={vStyle}>
                    <SidebarProjectItem projectId={row.projectId} />
                  </SortableRow>
                );
              }
              // Task rows inside a Stage Group render with the indented
              // `grouped` variant; Unstaged loose rows keep the under-project
              // indent (spec #85 Implementation Decisions). Derived once per
              // row set so every row of a group shares the variant, not just
              // the first one after the header.
              const rowVariant =
                taskVariants.get(`${row.projectId}:${row.taskId}`) ?? 'underProject';
              return (
                <SortableRow key={`${row.projectId}:${row.taskId}`} dndId={dndId} style={vStyle}>
                  <SidebarTaskItem
                    projectId={row.projectId}
                    taskId={row.taskId}
                    rowVariant={rowVariant}
                  />
                </SortableRow>
              );
            })}
          </div>
        </div>
      </SortableContext>
      <DragOverlay dropAnimation={null}>
        {activeDragId ? <DragOverlayContent dndId={activeDragId} /> : null}
      </DragOverlay>
      <InsertionIndicator pointerY={dragPointerY} rows={rows} />
    </DndContext>
  );
});

const toProjectDndId = (id: string) => `proj::${id}`;
const toTaskDndId = (projectId: string, taskId: string) => `task::${projectId}::${taskId}`;

type SidebarDndId =
  | { kind: 'project'; projectId: string }
  | { kind: 'task'; projectId: string; taskId: string };

/** Stage Group headers (spec #85) never enter dnd-kit's sortable id list. */
function isSortableRow(row: SidebarRow): row is Exclude<SidebarRow, { kind: 'stage-group' }> {
  return row.kind !== 'stage-group';
}

function rowToDndId(row: Exclude<SidebarRow, { kind: 'stage-group' }>): string {
  if (row.kind === 'project') return toProjectDndId(row.projectId);
  return toTaskDndId(row.projectId, row.taskId);
}

function parseDndId(id: string): SidebarDndId | null {
  if (id.startsWith('proj::')) return { kind: 'project', projectId: id.slice(6) };
  if (id.startsWith('task::')) {
    const [, projectId, taskId] = id.split('::');
    if (projectId && taskId) return { kind: 'task', projectId, taskId };
  }
  return null;
}

/**
 * The Workflow Stage of the task row at `rowIndex` — derived from the row
 * model's own layout ("a task row belongs to the group whose header precedes
 * it", `taskRowVariants`): walk up to the nearest `stage-group` header;
 * hitting the project row first (or the top) means Unstaged (`null`).
 * The same walk classifies both a drag's source row and its target row.
 */
function taskRowStage(rows: readonly SidebarRow[], rowIndex: number): WorkflowStage | null {
  for (let i = rowIndex - 1; i >= 0; i--) {
    const row = rows[i];
    if (row.kind === 'stage-group') return row.stage;
    if (row.kind === 'project') return null;
  }
  return null;
}

/**
 * The board's authority answer for a sidebar task drop (spec #85, ticket #89):
 * `blocked` only for a cross-stage destination a governing GitHub fact would
 * reassert over — the exact #88 gating (`sidebarStageMoveOptions`'s
 * `blocked` flag), never a second implementation. A same-stage drop (a
 * reorder within the group, or between Unstaged rows) never changes the
 * stage, so nothing contests it — mirroring the board's same-column
 * reorder. `explanation` is the board's `fact + action` feedback text to
 * surface when the drop is rejected.
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

// Project drags consider every visible row so dropping over a task maps to its
// owning project in onDragEnd without changing the virtualized list mid-drag.
// Task drags stay restricted to their own project's tasks.
const sidebarCollision: CollisionDetection = (args) => {
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

function DragOverlayContent({ dndId }: { dndId: string }) {
  const parsed = parseDndId(dndId);
  if (!parsed) return null;
  return (
    <div className="px-3">
      <div className="rounded-lg bg-background-tertiary-2 shadow-md">
        {parsed.kind === 'project' ? (
          <SidebarProjectItem projectId={parsed.projectId} />
        ) : (
          <SidebarTaskItem projectId={parsed.projectId} taskId={parsed.taskId} />
        )}
      </div>
    </div>
  );
}

function InsertionIndicator({
  pointerY,
  rows,
}: {
  pointerY: number | null;
  rows: readonly SidebarRow[];
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
  // Never promise a drop the board's authority would reject (ADR 0006): over
  // a destination a governing GitHub fact would overwrite, no insertion line
  // is drawn — the same "no ghost in the disabled column" rule as the board.
  if (activeParsed.kind === 'task' && overParsed.kind === 'task') {
    const activeRowIdx = rows.findIndex(
      (r) => isSortableRow(r) && rowToDndId(r) === String(active.id)
    );
    const overRowIdx = rows.findIndex((r) => isSortableRow(r) && rowToDndId(r) === String(over.id));
    if (activeRowIdx !== -1 && overRowIdx !== -1) {
      const authority = taskDropAuthority(
        activeParsed.projectId,
        activeParsed.taskId,
        taskRowStage(rows, activeRowIdx),
        taskRowStage(rows, overRowIdx)
      );
      if (authority.blocked) return null;
    }
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

interface SortableRowProps {
  dndId: string;
  style: React.CSSProperties;
  children: React.ReactNode;
}

function SortableRow({ dndId, style, children }: SortableRowProps) {
  const { setNodeRef, transform, transition, isDragging, listeners } = useSortable({
    id: dndId,
  });

  const combinedStyle: React.CSSProperties = {
    ...style,
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
    zIndex: isDragging ? 1 : 'auto',
  };

  return (
    <div ref={setNodeRef} style={combinedStyle} {...listeners}>
      {children}
    </div>
  );
}
