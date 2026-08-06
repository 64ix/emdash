import { STAGE_LABELS } from '@renderer/features/board/board-columns';
import {
  COLUMNS,
  computeDropRank,
  partitionAwaitingInput,
  sortColumn,
  type ColumnId,
} from '@renderer/features/board/board-ordering';
import type { WorkflowStage } from '@shared/core/tasks/tasks';

/**
 * The sidebar's grouped row model (spec #85, ticket #86): the pure,
 * board-independent module that replaces an expanded project's flat task
 * list with collapsible Stage Groups. Modeled on the board's
 * `board-ordering.ts` and consuming its shared predicates and ordering
 * helpers (`stageOf` semantics, `sortColumn`, `partitionAwaitingInput`,
 * `computeDropRank`, `COLUMNS` traversal, `STAGE_LABELS`) — never
 * duplicating them (ADR 0006: the sidebar is a projection of the board's
 * stage and rank fields).
 *
 * Row layout for an expanded project (CONTEXT.md "Stage Group",
 * "Unstaged"): project row, Board row, Unstaged loose task rows (no
 * header), then one header row per non-empty stage in `COLUMNS` order,
 * each followed by its task rows. Group membership at this stage is *all*
 * tasks of that stage; ticket #87 injects Shipped Fade and Hidden Task
 * filtering through the `isVisible` input without reshaping this API.
 */
export type SidebarRow =
  | { kind: 'project'; projectId: string }
  /**
   * The project's Feature Board destination (ticket #43): rendered right
   * after its project row and before its task rows, so it reads as a
   * project-level view rather than an individual task. Never sortable —
   * unlike project and task rows it never participates in manual drag
   * reordering.
   */
  | { kind: 'board'; projectId: string }
  | { kind: 'task'; projectId: string; taskId: string }
  /**
   * One collapsible Stage Group header per non-empty Workflow Stage, in
   * board column order (spec #85). Fixed anchor like the Board row: never
   * draggable, never a drop target for the project/task sortable set.
   * Task rows of a collapsed group are omitted from the row list; the
   * header (and its count) stays.
   */
  | {
      kind: 'stage-group';
      projectId: string;
      stage: WorkflowStage;
      /** Stage display label (`STAGE_LABELS`) shown on the header. */
      label: string;
      /** Number of visible tasks in the group; collapse does not change it. */
      count: number;
    };

/**
 * Minimal task shape the row model reads. Both a registered `Task` and an
 * `UnregisteredTaskData` store payload satisfy it, so unregistered tasks
 * (which have no stage and no Board Rank) keep appearing as Unstaged loose
 * rows exactly as they did in the flat list.
 */
export type StageGroupableTask = {
  id: string;
  workflowStage?: WorkflowStage | null;
  boardRank?: string | null;
};

/**
 * Same lookup as `board-ordering.ts`'s `stageOf` — widened to the minimal
 * task shape above, since `stageOf` is typed on the full `Task`. Semantics
 * are identical: no stage is the `unstaged` column.
 */
function stageColumnOf(task: StageGroupableTask): ColumnId {
  return task.workflowStage ?? 'unstaged';
}

export type StageGroupRowsInput = {
  projectId: string;
  /**
   * The project's displayable tasks in task-manager input order — the
   * fallback order unranked tasks keep ("unranked after ranked, in their
   * existing order", CONTEXT.md "Board Rank"). Archived, pinned and
   * automation-run tasks are the caller's business; this module only
   * groups what it is given.
   */
  tasks: readonly StageGroupableTask[];
  /**
   * Persisted collapsed Stage Group ids (Workflow Stages). A collapsed
   * group's header stays, its task rows are omitted. An id for a stage
   * with no visible tasks is meaningless (empty groups are never
   * rendered) and is simply ignored here; pruning the persisted set is the
   * SidebarStore's job, so a newly non-empty group appears expanded.
   */
  collapsedStages?: ReadonlySet<WorkflowStage>;
  /**
   * Awaiting Input task ids — elevated to the top of their group (and of
   * the Unstaged rows) at render time only, never persisted (ADR 0002),
   * exactly like `partitionAwaitingInput` on the board.
   */
  awaitingInputIds?: ReadonlySet<string>;
  /**
   * Render-time visibility filter. Ticket #87 injects Shipped Fade and
   * Hidden Task filtering here; the default keeps every given task
   * visible, which is this ticket's group membership rule.
   */
  isVisible?: (task: StageGroupableTask) => boolean;
};

type ColumnEntry = { id: string; rank: string | null };

/** Render indent variant for a sidebar task row (spec #85 Implementation Decisions). */
export type SidebarTaskRowVariant = 'underProject' | 'grouped';

/**
 * The render indent variant for every task row: tasks inside a Stage Group
 * use the deeper `grouped` indent, Unstaged loose rows keep the current
 * `underProject` indent (spec #85 Implementation Decisions). Derived from the
 * row sequence — a task row belongs to the group whose header precedes it,
 * so every task row after a `stage-group` header (until the next project or
 * Board row) is `grouped`, not just the first one. Collapsed groups emit no
 * task rows, so nothing to derive there. Keyed by `projectId:taskId`.
 */
export function taskRowVariants(rows: readonly SidebarRow[]): Map<string, SidebarTaskRowVariant> {
  const variants = new Map<string, SidebarTaskRowVariant>();
  let inGroup = false;
  for (const row of rows) {
    if (row.kind === 'stage-group') {
      inGroup = true;
    } else if (row.kind === 'project' || row.kind === 'board') {
      inGroup = false;
    } else if (row.kind === 'task') {
      variants.set(`${row.projectId}:${row.taskId}`, inGroup ? 'grouped' : 'underProject');
    }
  }
  return variants;
}

/**
 * Builds the ordered sidebar rows for one expanded project: project row,
 * Board row, Unstaged loose task rows, then one `stage-group` header row
 * per non-empty stage in `COLUMNS` order, each followed by its task rows
 * unless the group is collapsed. Task order within a group (and within the
 * Unstaged rows) mirrors the board column: Board Rank first, unranked
 * after in input order, Awaiting Input elevated at render time. Read-only:
 * never assigns a rank or stage.
 */
export function buildStageGroupedRows(input: StageGroupRowsInput): SidebarRow[] {
  const { projectId, tasks, collapsedStages, awaitingInputIds } = input;
  const isVisible = input.isVisible ?? (() => true);
  const awaiting = awaitingInputIds ?? new Set<string>();

  // Partition tasks by column in task-manager input order — the order
  // `sortColumn` preserves for unranked entries.
  const entriesByColumn = new Map<ColumnId, ColumnEntry[]>();
  for (const task of tasks) {
    if (!isVisible(task)) continue;
    const column = stageColumnOf(task);
    let entries = entriesByColumn.get(column);
    if (!entries) {
      entries = [];
      entriesByColumn.set(column, entries);
    }
    entries.push({ id: task.id, rank: task.boardRank ?? null });
  }

  const rows: SidebarRow[] = [
    { kind: 'project', projectId },
    { kind: 'board', projectId },
  ];

  for (const column of COLUMNS) {
    const entries = entriesByColumn.get(column);
    if (!entries) continue;
    // Same order the board shows the column in: `sortColumn` (Board Rank
    // first, unranked after), then the render-time awaiting-input
    // partition (`partitionAwaitingInput`'s `frozen` flag stays false —
    // there is no drag to freeze for, and the ordering is read-only).
    const sorted = partitionAwaitingInput(sortColumn(entries), awaiting, false);

    if (column === 'unstaged') {
      // Loose rows directly under the Board row — no "Unstaged" header.
      for (const entry of sorted) {
        rows.push({ kind: 'task', projectId, taskId: entry.id });
      }
      continue;
    }

    const stage = column;
    rows.push({
      kind: 'stage-group',
      projectId,
      stage,
      label: STAGE_LABELS[column],
      count: sorted.length,
    });
    if (collapsedStages?.has(stage)) continue;
    for (const entry of sorted) {
      rows.push({ kind: 'task', projectId, taskId: entry.id });
    }
  }

  return rows;
}

/**
 * Minimal entry shape the drop-position mapper reads — the same
 * `{ id, rank }` pair the board sorts (`CardEntry`).
 */
export type SidebarDropEntry = { id: string; rank: string | null };

/**
 * The (Workflow Stage, Board Rank) a sidebar drop should persist
 * (spec #85): the stage side maps `unstaged` to `null` (clearing the
 * stage) exactly like the board's `computeDropPosition`; the rank side is
 * `null` — "unranked after the ranked tasks" — when the drop carries no
 * position.
 */
export type SidebarDropPosition = { stage: WorkflowStage | null; rank: string | null };

/**
 * Maps a sidebar drop onto `{ stage, rank }`, mirroring the board's
 * `computeDropPosition`/`computeDropRank` semantics (board-ordering.ts).
 *
 * - `dropIndex` in `[0, rankedPrefixLength]`: a positioned drop between
 *   two visible neighbours of `destinationEntries` (the destination's
 *   visible tasks, `sortColumn`-ordered, dragged card excluded) —
 *   interpolated Board Rank, clamped into the ranked prefix exactly like a
 *   board drop (spec user stories 15/17).
 * - `dropIndex: null`: an unpositioned drop — onto a group header/body
 *   end or an empty group — carrying no slot: stage-only, `rank: null`,
 *   so the task lands unranked after the ranked tasks (user story 16).
 * - `destinationColumn: 'unstaged'`: the drop clears the Workflow Stage
 *   (`stage: null`), ranked or not per `dropIndex` (user stories 17/18).
 *
 * Pure and unwired: ticket #89 maps drop targets to `destinationColumn`
 * and `dropIndex`; this function only does the rank/stage math.
 */
export function computeSidebarDropPosition(
  destinationColumn: ColumnId,
  destinationEntries: readonly SidebarDropEntry[],
  dropIndex: number | null,
  trueEntries?: readonly SidebarDropEntry[]
): SidebarDropPosition {
  return {
    stage: destinationColumn === 'unstaged' ? null : destinationColumn,
    rank: dropIndex === null ? null : computeDropRank(destinationEntries, dropIndex, trueEntries),
  };
}
