import { workflowStages, type Task, type WorkflowStage } from '@shared/core/tasks/tasks';
import { rankBetween } from '@shared/lib/board-rank';

/** Column ids: every Workflow Stage, plus a leading bucket for Unstaged tasks. */
export type ColumnId = WorkflowStage | 'unstaged';

export const COLUMNS: ColumnId[] = ['unstaged', ...workflowStages.options];

export function stageOf(task: Task): ColumnId {
  return task.workflowStage ?? 'unstaged';
}

/** Minimal shape needed to sort a column: a Board Rank, nullable when unranked. */
export type RankedEntry = { rank: string | null };

/**
 * Sorts a single column's cards: ranked cards first (ascending by Board Rank),
 * then unranked cards in their pre-existing (input) order. Never assigns a
 * rank — purely a read-time sort. Stable: cards that are both unranked, or
 * that share a rank, keep their relative input order.
 */
export function sortColumn<T extends RankedEntry>(entries: readonly T[]): T[] {
  const ranked: T[] = [];
  const unranked: T[] = [];
  for (const entry of entries) {
    (entry.rank === null ? unranked : ranked).push(entry);
  }
  ranked.sort((a, b) => (a.rank! < b.rank! ? -1 : a.rank! > b.rank! ? 1 : 0));
  return [...ranked, ...unranked];
}

/** Minimal shape needed to identify a card for the awaiting-input partition. */
export type IdentifiedEntry = { id: string };

/**
 * Moves awaiting-input cards to the top of an already-sorted column, keeping
 * the relative order within each partition (elevated cards keep their order
 * among themselves; the rest keep their order among themselves). Never
 * touches Board Rank — a render-time partition only (ADR 0002).
 *
 * While a drag is active (`frozen`), returns `entries` unchanged so the list
 * cannot reshuffle under the pointer mid-drag.
 */
export function partitionAwaitingInput<T extends IdentifiedEntry>(
  entries: readonly T[],
  awaitingInputIds: ReadonlySet<string>,
  frozen: boolean
): T[] {
  if (frozen) return [...entries];
  const awaiting: T[] = [];
  const rest: T[] = [];
  for (const entry of entries) {
    (awaitingInputIds.has(entry.id) ? awaiting : rest).push(entry);
  }
  return [...awaiting, ...rest];
}

/**
 * Computes the Board Rank a dropped card should receive when placed at
 * `dropIndex` among `destinationEntries` — the destination column's cards,
 * already sorted via `sortColumn`, with the dragged card itself excluded.
 *
 * Ranked cards always sort before unranked ones (see `sortColumn`), so a
 * drop always lands within, or at the end of, the ranked prefix: dropping
 * "inside" the unranked tail clamps to the end of the ranked prefix, since an
 * unranked card has no rank to slot next to. Dropping into an empty column
 * (or an all-unranked column) produces the first rank in that column.
 */
export function computeDropRank(
  destinationEntries: readonly RankedEntry[],
  dropIndex: number
): string {
  let rankedLength = destinationEntries.findIndex((entry) => entry.rank === null);
  if (rankedLength === -1) rankedLength = destinationEntries.length;

  const clampedIndex = Math.min(Math.max(dropIndex, 0), rankedLength);
  const prev = clampedIndex > 0 ? destinationEntries[clampedIndex - 1]!.rank : null;
  const next = clampedIndex < rankedLength ? destinationEntries[clampedIndex]!.rank : null;
  return rankBetween(prev, next);
}

/**
 * Resolves the (Workflow Stage, Board Rank) a card should persist after being
 * dropped at `dropIndex` inside `destinationColumn`. `destinationEntries` must
 * be that column's cards, sorted via `sortColumn`, with the dragged card
 * itself already removed. Dropping into the `unstaged` column clears the
 * Workflow Stage.
 */
export function computeDropPosition(
  destinationColumn: ColumnId,
  destinationEntries: readonly RankedEntry[],
  dropIndex: number
): { stage: WorkflowStage | null; rank: string } {
  return {
    stage: destinationColumn === 'unstaged' ? null : destinationColumn,
    rank: computeDropRank(destinationEntries, dropIndex),
  };
}
