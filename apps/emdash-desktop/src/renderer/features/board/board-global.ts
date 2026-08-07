import { isBoardDisplayable, isBoardRankCandidate } from '@renderer/features/board/board-columns';
import {
  taskPassesBoardFilters,
  type BoardFilterState,
} from '@renderer/features/board/board-filters';
import {
  COLUMNS,
  computeDropPosition,
  partitionAwaitingInput,
  sortColumn,
  stageOf,
  type ColumnId,
} from '@renderer/features/board/board-ordering';
import type { AgentStatus } from '@shared/core/agents/agentEvents';
import type { Task, WorkflowStage } from '@shared/core/tasks/tasks';

/**
 * The Global Board's pure aggregation seam (spec #104, ticket #106): given
 * each project's already-loaded task set (from that project's
 * `TaskManagerStore`), the agent statuses, the Shipped Fade evaluation
 * instant and the active filters, it produces the ordered per-stage columns —
 * Unstaged and Triage included — with all projects' cards mixed together,
 * each card carrying its project marker. It is the sibling of the Feature
 * Board's `board-ordering.ts` / `board-columns.ts` / `board-filters.ts`, not a
 * copy of them: every rule applied here (stage resolution via `stageOf`,
 * `sortColumn` ordering, `partitionAwaitingInput`, Shipped Fade via
 * `isBoardDisplayable`, `taskPassesBoardFilters`, and drop-rank math via
 * `computeDropPosition`) is imported from those shared modules, so the Global
 * Board can never drift from the Feature Board (CONTEXT.md "Global Board":
 * "Display rules match the Feature Board per column").
 *
 * Board Rank remains a single per-task fractional index shared by every
 * surface: a Global Board drop interpolates in the *shared per-stage column*
 * across projects (CONTEXT.md "Board Rank"), so no new field or migration is
 * involved and each project's own board keeps its relative order by
 * construction. The project marker is a card-level attribute — the project
 * whose task set the card came from — and columns are shared per stage across
 * projects.
 */

/**
 * A Global Board card: the same minimal sortable shape the Feature Board's
 * columns carry (`{ id, rank }` — `RankedEntry` in `board-ordering.ts`), plus
 * the project marker the Global Board's cross-project columns need.
 */
export type GlobalBoardCard = {
  id: string;
  rank: string | null;
  /** Project marker: the project whose task set this card came from. */
  projectId: string;
};

/**
 * One project's contribution to the Global Board: the tasks its
 * `TaskManagerStore` already has loaded, and the agent status per task id
 * (`taskAgentStatus`, `AgentStatus | null` where `null` means idle).
 */
export type GlobalBoardProjectInput = {
  projectId: string;
  tasks: readonly Task[];
  agentStatuses: ReadonlyMap<string, AgentStatus | null>;
};

export type GlobalBoardBuildOptions = {
  /** Shipped Fade evaluation instant (ticket #51); defaults to `Date.now()`. */
  now?: number;
  /**
   * The active project multi-select (the only persisted Global Board filter,
   * CONTEXT.md "Global Board"): projects outside the selection contribute no
   * visible cards. Empty — the persisted default — means no project is
   * omitted. Presence in the candidate set is unaffected: a deselected
   * project stays listable so the user can re-select it.
   */
  selectedProjectIds?: ReadonlySet<string>;
  /**
   * True while a drag is active: the Awaiting Input float freezes so the
   * column cannot reshuffle under the pointer mid-drag (ADR 0002), exactly as
   * the Feature Board passes `frozen` to `partitionAwaitingInput`.
   */
  frozen?: boolean;
};

/**
 * The Global Board's ordered columns. `display` is what renders: per-stage
 * columns (every `COLUMNS` id, Unstaged and Triage included) with the cards
 * that pass displayability, the active board filters and the project
 * selection, in display order — `sortColumn` order, then Awaiting Input
 * floated to the top unless `frozen`. `sorted` is the same set before the
 * Awaiting Input float and `trueSorted` is every Board Rank candidate in the
 * column (across all projects, ignoring the board filters, the project
 * selection and Shipped Fade) — the two orderings the drop mapper needs,
 * mirroring the Feature Board's `sortedByColumn` / `trueSortedByColumn`
 * (`board-main-panel.tsx`).
 */
export type GlobalBoardColumns = {
  display: ReadonlyMap<ColumnId, readonly GlobalBoardCard[]>;
  sorted: ReadonlyMap<ColumnId, readonly GlobalBoardCard[]>;
  trueSorted: ReadonlyMap<ColumnId, readonly GlobalBoardCard[]>;
  /**
   * The project-filter candidate set, in input order: every project with at
   * least one displayable card (real, non-archived, not Shipped-Faded) —
   * ignoring the ephemeral board filters and the project selection itself, so
   * neither a search query nor a deselection can make a project unreachable
   * from the filter list. Projects without a single displayable card are
   * omitted until they have one (CONTEXT.md "Global Board").
   */
  presentProjects: readonly string[];
};

const NO_PROJECT_SELECTION: ReadonlySet<string> = new Set();

/**
 * The project-filter predicate: whether a project's cards may appear on the
 * Global Board. A project is omitted when it has no displayable card at all
 * (absent from `presentProjectIds` — the candidate set the column builder
 * derives), or when the active multi-select explicitly excludes it. An empty
 * selection means "all projects" — the persisted default.
 */
export function projectPassesGlobalBoardFilter(
  projectId: string,
  presentProjectIds: ReadonlySet<string>,
  selectedProjectIds: ReadonlySet<string>
): boolean {
  if (!presentProjectIds.has(projectId)) return false;
  if (selectedProjectIds.size > 0 && !selectedProjectIds.has(projectId)) return false;
  return true;
}

/**
 * Builds the Global Board's ordered columns from each project's loaded task
 * set. Per task, exactly the Feature Board's pipeline runs — displayability
 * (`isBoardDisplayable` — real task, not archived, not Shipped-Faded),
 * the board filters (`taskPassesBoardFilters`), then per column
 * `sortColumn` plus the Awaiting Input float (`partitionAwaitingInput`) —
 * with one additional axis: the project selection, applied to `display` and
 * `sorted` (never to `trueSorted`, which must keep every card that still
 * holds a stored rank in the shared column so drop interpolation never
 * collides with a hidden one).
 */
export function buildGlobalBoardColumns(
  projects: readonly GlobalBoardProjectInput[],
  filters: BoardFilterState,
  options: GlobalBoardBuildOptions = {}
): GlobalBoardColumns {
  const { now = Date.now(), selectedProjectIds = NO_PROJECT_SELECTION, frozen = false } = options;

  const presentProjectIds = new Set<string>();
  const awaitingInputIds = new Set<string>();
  const rawByColumn = new Map<ColumnId, GlobalBoardCard[]>(COLUMNS.map((c) => [c, []]));
  const trueRawByColumn = new Map<ColumnId, GlobalBoardCard[]>(COLUMNS.map((c) => [c, []]));

  for (const project of projects) {
    for (const task of project.tasks) {
      if (isBoardRankCandidate(task)) {
        trueRawByColumn
          .get(stageOf(task))
          ?.push({ id: task.id, rank: task.boardRank ?? null, projectId: project.projectId });
      }
      if (!isBoardDisplayable(task, now)) continue;
      const agentStatus = project.agentStatuses.get(task.id) ?? null;
      if (agentStatus === 'awaiting-input') awaitingInputIds.add(task.id);
      presentProjectIds.add(project.projectId);
      if (!taskPassesBoardFilters(task, agentStatus, filters)) continue;
      rawByColumn
        .get(stageOf(task))
        ?.push({ id: task.id, rank: task.boardRank ?? null, projectId: project.projectId });
    }
  }

  const sortedByColumn = new Map<ColumnId, GlobalBoardCard[]>();
  const displayByColumn = new Map<ColumnId, GlobalBoardCard[]>();
  for (const column of COLUMNS) {
    const raw = (rawByColumn.get(column) ?? []).filter((card) =>
      projectPassesGlobalBoardFilter(card.projectId, presentProjectIds, selectedProjectIds)
    );
    const sorted = sortColumn(raw);
    sortedByColumn.set(column, sorted);
    displayByColumn.set(column, partitionAwaitingInput(sorted, awaitingInputIds, frozen));
  }

  const trueSortedByColumn = new Map<ColumnId, GlobalBoardCard[]>();
  for (const column of COLUMNS) {
    trueSortedByColumn.set(column, sortColumn(trueRawByColumn.get(column) ?? []));
  }

  return {
    display: displayByColumn,
    sorted: sortedByColumn,
    trueSorted: trueSortedByColumn,
    presentProjects: [...presentProjectIds],
  };
}

/**
 * The Global Board's drop mapper: the `{ stage, rank }` a dropped card should
 * persist, computed in the *shared per-column rank space* — `computeDropPosition`
 * (`board-ordering.ts`) run over the aggregated column, where the destination
 * entries are every project's visible cards in that stage and the true
 * entries are every project's rank candidates, so inter-project interpolation
 * can never collide with a hidden card's stored rank. Dropping into `unstaged`
 * clears the Workflow Stage; the stage of any other column is kept.
 *
 * `columns` is the builder's output for the current render; `draggedCardId` is
 * excluded from both entry sets, exactly like the Feature Board's drop path
 * (`board-main-panel.tsx` `handleDragEnd`). `dropIndex` is the slot the view
 * resolved against the rendered (floated) column.
 */
export function computeGlobalDropPosition(
  columns: GlobalBoardColumns,
  destinationColumn: ColumnId,
  draggedCardId: string,
  dropIndex: number
): { stage: WorkflowStage | null; rank: string } {
  const destinationEntries = (columns.sorted.get(destinationColumn) ?? []).filter(
    (card) => card.id !== draggedCardId
  );
  const trueEntries = (columns.trueSorted.get(destinationColumn) ?? []).filter(
    (card) => card.id !== draggedCardId
  );
  return computeDropPosition(destinationColumn, destinationEntries, dropIndex, trueEntries);
}
