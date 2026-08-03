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
 *
 * `destinationEntries` may be a *filtered* (Board filters, ticket #45) view —
 * it decides the drop *slot*, i.e. which two visible cards the user actually
 * aimed between. Interpolating a rank strictly between those two visible
 * neighbours' own stored ranks is correct in the common case, but it can
 * exactly reproduce a *hidden* card's own rank when one genuinely sits
 * between them (e.g. visible '4' and '6' with a filtered-out '5' in between:
 * `rankBetween('4', '6') === '5'`, the hidden card's own rank — a real
 * duplicate Board Rank, and a later drop next to it would then violate
 * `rankBetween`'s own ordering guard). The optional `trueEntries` — the same
 * column's *unfiltered* cards, sorted the same way, with the dragged card
 * excluded — lets this be detected: only when the naive candidate collides
 * with a true (possibly hidden) entry does this fall back to interpolating
 * against the true immediate neighbour of whichever visible anchor bounds the
 * slot instead. Two truly-adjacent stored entries can never have a third rank
 * between them, so that fallback can never collide with anything already on
 * the board. This leaves the common case — no hidden card in the gap, or a
 * hidden card whose rank the naive midpoint simply doesn't land on — exactly
 * as before. Omitting `trueEntries` also keeps the old (filtered-only)
 * behavior, for callers that have no unfiltered view.
 */
export function computeDropRank<T extends RankedEntry>(
  destinationEntries: readonly T[],
  dropIndex: number,
  trueEntries?: readonly (T & { id: string })[]
): string {
  let rankedLength = destinationEntries.findIndex((entry) => entry.rank === null);
  if (rankedLength === -1) rankedLength = destinationEntries.length;

  const clampedIndex = Math.min(Math.max(dropIndex, 0), rankedLength);
  const leftAnchor = clampedIndex > 0 ? destinationEntries[clampedIndex - 1]! : null;
  const rightAnchor = clampedIndex < rankedLength ? destinationEntries[clampedIndex]! : null;
  const candidate = rankBetween(leftAnchor?.rank ?? null, rightAnchor?.rank ?? null);

  if (!trueEntries) return candidate;

  let trueRankedLength = trueEntries.findIndex((entry) => entry.rank === null);
  if (trueRankedLength === -1) trueRankedLength = trueEntries.length;
  const trueRanked = trueEntries.slice(0, trueRankedLength);

  // No true entry — hidden or otherwise — already holds `candidate`'s rank:
  // the naive, visible-only interpolation above is safe as is. (A match here
  // is only possible for an entry strictly between the two visible anchors,
  // since `candidate` itself always sorts strictly between them.)
  if (!trueRanked.some((entry) => entry.rank === candidate)) return candidate;

  if (leftAnchor) {
    // `leftAnchor` is drawn from `destinationEntries`, which — whenever
    // `trueEntries` is supplied — is itself an id-bearing subset of
    // `trueEntries` (see the board-main-panel.tsx call site); the cast just
    // recovers the `id` TypeScript otherwise erases via the plain `T` bound.
    const anchor = leftAnchor as T & { id: string };
    const trueIndex = trueRanked.findIndex((entry) => entry.id === anchor.id);
    const upper =
      trueIndex !== -1 && trueIndex + 1 < trueRanked.length
        ? trueRanked[trueIndex + 1]!.rank
        : (rightAnchor?.rank ?? null);
    return rankBetween(anchor.rank, upper);
  }
  if (rightAnchor) {
    const anchor = rightAnchor as T & { id: string };
    const trueIndex = trueRanked.findIndex((entry) => entry.id === anchor.id);
    const lower = trueIndex > 0 ? trueRanked[trueIndex - 1]!.rank : null;
    return rankBetween(lower, anchor.rank);
  }
  // Nothing visible in this column (it may still hold hidden cards) — append
  // after the true order's last ranked entry, if any.
  const lower = trueRanked.length > 0 ? trueRanked[trueRanked.length - 1]!.rank : null;
  return rankBetween(lower, null);
}

/**
 * Resolves the (Workflow Stage, Board Rank) a card should persist after being
 * dropped at `dropIndex` inside `destinationColumn`. `destinationEntries` must
 * be that column's cards, sorted via `sortColumn`, with the dragged card
 * itself already removed. Dropping into the `unstaged` column clears the
 * Workflow Stage. See `computeDropRank` for `trueEntries` (the same column's
 * unfiltered cards, same sort, dragged card excluded).
 */
export function computeDropPosition<T extends RankedEntry>(
  destinationColumn: ColumnId,
  destinationEntries: readonly T[],
  dropIndex: number,
  trueEntries?: readonly (T & { id: string })[]
): { stage: WorkflowStage | null; rank: string } {
  return {
    stage: destinationColumn === 'unstaged' ? null : destinationColumn,
    rank: computeDropRank(destinationEntries, dropIndex, trueEntries),
  };
}
