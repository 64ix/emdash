import { STAGE_LABELS } from '@renderer/features/board/board-columns';
import {
  COLUMNS,
  computeDropRank,
  partitionAwaitingInput,
  sortColumn,
  type ColumnId,
} from '@renderer/features/board/board-ordering';
import type { LinkedIssueRoles } from '@shared/core/linked-issue';
import {
  deriveTaskStageAuthorityFact,
  parseIssueNumberFromIdentifier,
  type PrWorkflowFact,
} from '@shared/core/pull-requests/pr-workflow-derivation';
import {
  deriveStageAuthority,
  describeStageAuthorityFact,
  isStageDestinationSafe,
} from '@shared/core/tasks/stage-authority';
import { workflowStages, type StageHoldingPr, type WorkflowStage } from '@shared/core/tasks/tasks';
import { rankBetween } from '@shared/lib/board-rank';

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
 * "Unstaged"): project row, Unstaged loose task rows (no header), then one
 * header row per non-empty stage in `COLUMNS` order, each followed by its
 * task rows. Group membership at this stage is *all* tasks of that stage;
 * ticket #87 injects Shipped Fade and Hidden Task filtering through the
 * `isVisible` input without reshaping this API.
 */
export type SidebarRow =
  | { kind: 'project'; projectId: string }
  | { kind: 'task'; projectId: string; taskId: string }
  /**
   * One collapsible Stage Group header per non-empty Workflow Stage, in
   * board column order (spec #85). Fixed anchor: never draggable, never a
   * drop target for the project/task sortable set.
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
   * True while a sidebar task drag is active: suspends the Awaiting Input
   * elevation (`partitionAwaitingInput`'s own `frozen` contract) so the
   * rendered order is pure `sortColumn` order for the whole drag — the same
   * order the drop math interpolates ranks in, and the board's own drag
   * behavior. Without it, an elevated task makes the visible slot the user
   * aims at disagree with the rank slot the drop persists.
   */
  frozen?: boolean;
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
 * so every task row after a `stage-group` header (until the next project
 * row) is `grouped`, not just the first one. Collapsed groups emit no
 * task rows, so nothing to derive there. Keyed by `projectId:taskId`.
 */
export function taskRowVariants(rows: readonly SidebarRow[]): Map<string, SidebarTaskRowVariant> {
  const variants = new Map<string, SidebarTaskRowVariant>();
  let inGroup = false;
  for (const row of rows) {
    if (row.kind === 'stage-group') {
      inGroup = true;
    } else if (row.kind === 'project') {
      inGroup = false;
    } else if (row.kind === 'task') {
      variants.set(`${row.projectId}:${row.taskId}`, inGroup ? 'grouped' : 'underProject');
    }
  }
  return variants;
}

/**
 * Builds the ordered sidebar rows for one expanded project: project row,
 * Unstaged loose task rows, then one `stage-group` header row per non-empty
 * stage in `COLUMNS` order, each followed by its task rows unless the group
 * is collapsed. Task order within a group (and within the Unstaged rows)
 * mirrors the board column: Board Rank first, unranked after in input
 * order, Awaiting Input elevated at render time. Read-only: never assigns a
 * rank or stage.
 */
export function buildStageGroupedRows(input: StageGroupRowsInput): SidebarRow[] {
  const { projectId, tasks, collapsedStages, awaitingInputIds } = input;
  const isVisible = input.isVisible ?? (() => true);
  const awaiting = awaitingInputIds ?? new Set<string>();
  const frozen = input.frozen ?? false;

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

  const rows: SidebarRow[] = [{ kind: 'project', projectId }];

  for (const column of COLUMNS) {
    const entries = entriesByColumn.get(column);
    if (!entries) continue;
    // Same order the board shows the column in: `sortColumn` (Board Rank
    // first, unranked after), then the render-time awaiting-input
    // partition — suspended (`frozen`) while a task drag is active, so the
    // order under the pointer is the order the drop math ranks against.
    const sorted = partitionAwaitingInput(sortColumn(entries), awaiting, frozen);

    if (column === 'unstaged') {
      // Loose rows directly under the project row — no "Unstaged" header.
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

/**
 * A sidebar drop resolved into every write it takes to land the task at the
 * aimed slot: the dragged task's own `{ stage, rank }` plus the `backfills` —
 * Board Ranks to persist on destination tasks that had none.
 */
export type SidebarTaskDropPlan = SidebarDropPosition & {
  /**
   * Ranks to persist (same stage, `updateBoardPosition`) on the destination
   * column's previously-unranked tasks, in order. Empty whenever the aimed
   * slot is already expressible against ranked neighbours.
   */
  backfills: { id: string; rank: string }[];
};

/**
 * Plans a sidebar task drop, fixing `computeSidebarDropPosition`'s blind spot
 * for unranked destinations. `computeDropRank` clamps every drop into the
 * ranked prefix ("an unranked card has no rank to slot next to"), and
 * `rank: null` floats a task back to its task-manager input order — so in a
 * group whose tasks were never dragged on the board (the common case: tasks
 * are created unranked), a positioned drop always landed at the *top* of the
 * group and an end-of-group drop landed wherever creation order put it,
 * never where the user aimed.
 *
 * When the aimed slot touches the unranked tail, the tail is first
 * *materialized*: every unranked entry of `trueEntries` (the column's full
 * rank-candidate set, hidden tasks included, dragged task excluded) gets a
 * rank appended after the last ranked entry, in its current order. That
 * changes no rendered order anywhere — `sortColumn` renders ranked-then-
 * unranked-in-input-order, and the backfilled ranks encode exactly that
 * sequence — it only makes the slot expressible. The dragged task then ranks
 * between its now-ranked visible neighbours (`computeDropRank`, collision
 * guard included); an unpositioned drop (`dropIndex: null` — a group-header
 * drop or a below-the-last-row drop) keeps the spec's stage-only
 * `rank: null` write, which now deterministically renders at the group's
 * end because everything else holds a rank (spec #85 user story 16).
 */
export function planSidebarTaskDrop(
  destinationColumn: ColumnId,
  destinationEntries: readonly SidebarDropEntry[],
  dropIndex: number | null,
  trueEntries: readonly SidebarDropEntry[]
): SidebarTaskDropPlan {
  const stage = destinationColumn === 'unstaged' ? null : destinationColumn;

  let rankedLength = destinationEntries.findIndex((entry) => entry.rank === null);
  if (rankedLength === -1) rankedLength = destinationEntries.length;
  const needsBackfill =
    trueEntries.some((entry) => entry.rank === null) &&
    (dropIndex === null || dropIndex > rankedLength);

  if (!needsBackfill) {
    return {
      stage,
      rank: dropIndex === null ? null : computeDropRank(destinationEntries, dropIndex, trueEntries),
      backfills: [],
    };
  }

  const backfills: { id: string; rank: string }[] = [];
  const backfilledRankById = new Map<string, string>();
  let previousRank: string | null = null;
  for (let i = trueEntries.length - 1; i >= 0; i--) {
    const rank = trueEntries[i]!.rank;
    if (rank !== null) {
      previousRank = rank;
      break;
    }
  }
  for (const entry of trueEntries) {
    if (entry.rank !== null) continue;
    const rank = rankBetween(previousRank, null);
    backfills.push({ id: entry.id, rank });
    backfilledRankById.set(entry.id, rank);
    previousRank = rank;
  }
  const withBackfills = (entries: readonly SidebarDropEntry[]) =>
    entries.map((entry) => ({
      ...entry,
      rank: entry.rank ?? backfilledRankById.get(entry.id) ?? null,
    }));
  return {
    stage,
    rank:
      dropIndex === null
        ? null
        : computeDropRank(withBackfills(destinationEntries), dropIndex, withBackfills(trueEntries)),
    backfills,
  };
}

/**
 * One "Move to stage…" entry (spec #85, ticket #88): a Workflow Stage or
 * Unstaged (`stage: null`), labelled through the board's `STAGE_LABELS`
 * (never a second label set), and `blocked` when a governing GitHub fact
 * would overwrite the move — the board's own `isStageDestinationSafe`
 * answer, so the sidebar never accepts a move the next sync pass would
 * silently revert (ADR 0006).
 */
export type SidebarStageMoveOption = {
  stage: WorkflowStage | null;
  label: string;
  blocked: boolean;
};

/**
 * The "Move to stage…" submenu contents for one task (ticket #88): every
 * Workflow Stage plus Unstaged, each gated through the board's authority
 * contract, plus the governing-fact explanation to surface as feedback when
 * anything is blocked — the same `fact + action` composition as the board's
 * blocked-drop explanation, so the block never reads as arbitrary.
 */
export type SidebarStageMoveOptions = {
  options: readonly SidebarStageMoveOption[];
  explanation: string | null;
};

/**
 * Minimal task shape the stage-move decision reads — the fields the board's
 * own `authorityForTask` (`board-main-panel.tsx`) reads, widened so the pure
 * seam accepts light fixtures. A real `Task` satisfies it (`prs` are
 * `PullRequest`s, which carry every `PrWorkflowFact` and `StageHoldingPr`
 * field); `prs` is optional here only because the board guards older test
 * doubles the same way.
 */
export type SidebarStageMoveTask = {
  workflowStage?: WorkflowStage | null;
  linkedIssues?: LinkedIssueRoles | null;
  prs?: readonly (PrWorkflowFact & StageHoldingPr)[] | null;
  workspaceId?: string | null;
};

/**
 * Computes the "Move to stage…" options for a task, reusing the board's
 * exact authority computation (`board-main-panel.tsx`'s `authorityForTask`:
 * `deriveTaskStageAuthorityFact` for the Spec-referencing PR half,
 * `deriveStageAuthority` for the whole fact) and gating every destination
 * through the shared `isStageDestinationSafe` — never a second gating
 * implementation (ticket #88, ADR 0006). A destination is blocked when the
 * governing fact would be reasserted over it by the next sync pass;
 * `explanation` names that fact and what must change, composed exactly like
 * the board's blocked-drop feedback. Pure: never writes, never reads the
 * store.
 */
export function sidebarStageMoveOptions(
  task: SidebarStageMoveTask,
  branchName: string | null
): SidebarStageMoveOptions {
  const currentStage = task.workflowStage ?? null;
  const specIssueNumber = parseIssueNumberFromIdentifier(task.linkedIssues?.spec?.identifier);
  const authority = deriveStageAuthority({
    currentStage,
    linkedIssues: task.linkedIssues,
    prAuthority: deriveTaskStageAuthorityFact({
      currentStage,
      specIssueNumber,
      taskBranch: branchName,
      // Defensive: `task.prs` is non-optional on `Task`, but lighter test
      // doubles across the board test suites omit it — same guard as the
      // board's own `authorityForTask`.
      prFacts: task.prs ?? [],
    }),
    hasWorkspace: task.workspaceId != null,
  });

  const options: SidebarStageMoveOption[] = [
    ...workflowStages.options.map((stage) => ({
      stage,
      label: STAGE_LABELS[stage],
      blocked: authority.governs && !isStageDestinationSafe(authority.fact, stage),
    })),
    {
      stage: null,
      label: STAGE_LABELS.unstaged,
      blocked: authority.governs && !isStageDestinationSafe(authority.fact, null),
    },
  ];

  // Feedback: only a governing fact ever blocks anything, and every
  // governing fact blocks at least one destination, so `some(blocked)` is
  // exactly "the submenu has disabled entries to explain".
  let explanation: string | null = null;
  if (options.some((option) => option.blocked)) {
    const description = describeStageAuthorityFact(authority.fact);
    explanation = `${description.fact} ${description.action}`;
  }

  return { options, explanation };
}
