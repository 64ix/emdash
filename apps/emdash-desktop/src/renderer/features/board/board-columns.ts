import {
  isShippedFaded,
  SHIPPED_FADE_WINDOW_MS,
} from '@shared/core/pull-requests/pr-workflow-derivation';
import type { Task } from '@shared/core/tasks/tasks';
import { COLUMNS, type ColumnId } from './board-ordering';

/**
 * Feature Board column labels. Names and ordering follow the glossary in
 * CONTEXT.md ("Workflow Stage", "Triage", "Unstaged"); the column set and
 * traversal order themselves live in `board-ordering.ts` (`COLUMNS`).
 */
export const STAGE_LABELS: Record<ColumnId, string> = {
  unstaged: 'Unstaged',
  idea: 'Idea',
  exploring: 'Exploring',
  spec: 'Spec',
  implementing: 'Implementing',
  review: 'Review',
  shipped: 'Shipped',
  triage: 'Triage',
};

/**
 * Presentation grouping (ticket #46, CONTEXT.md "Unstaged", "Triage"):
 * Unstaged and Triage are exception groups outside the normal
 * feature-delivery sequence — Unstaged precedes it (a task has not entered
 * the pipeline yet), Triage sits outside it entirely (a contradicted task
 * pulled out of flow), and neither is a stage `idea -> ... -> shipped`
 * progresses through. `columnEmphasis` drives the board's visual grouping
 * (a divider plus distinct styling) so Triage is never rendered as if it
 * were the stage that follows Shipped. This is presentation-only: it does
 * not reorder `COLUMNS`, which remains the domain traversal/render order
 * relied on by drag-and-drop and column ordering tests.
 */
export type ColumnEmphasis = 'pipeline' | 'unstaged' | 'triage';

export function columnEmphasis(column: ColumnId): ColumnEmphasis {
  if (column === 'unstaged') return 'unstaged';
  if (column === 'triage') return 'triage';
  return 'pipeline';
}

/** The six-stage delivery pipeline, excluding the Unstaged/Triage exception groups. */
export const PIPELINE_COLUMNS: ColumnId[] = COLUMNS.filter(
  (column) => columnEmphasis(column) === 'pipeline'
);

/**
 * Shipped Fade (CONTEXT.md): `shipped` cards whose PR merged more than the fade
 * window ago are hidden from the board — a display rule, not a stage change.
 * Uses the most recently merged PR already loaded onto the task.
 */
export function isTaskShippedFaded(task: Task, now?: number): boolean {
  if (task.workflowStage !== 'shipped') return false;

  let latestMergedAt: string | null = null;
  for (const pr of task.prs) {
    if (pr.status !== 'merged' || !pr.mergedAt) continue;
    if (!latestMergedAt || pr.mergedAt > latestMergedAt) latestMergedAt = pr.mergedAt;
  }
  return isShippedFaded(latestMergedAt, now);
}

/**
 * A task counts as a Feature Board card — and, by extension, can back an open
 * Task Detail Panel (CONTEXT.md) — only while it is a real, non-archived task
 * not hidden by Shipped Fade. One predicate for both: a task the board stops
 * showing must never leave the panel rendering it on stale data.
 */
export function isBoardDisplayable(task: Task, now?: number): boolean {
  return isBoardRankCandidate(task) && !isTaskShippedFaded(task, now);
}

/**
 * Broader than `isBoardDisplayable` — used only to build the "true" (rank-math)
 * per-column membership `board-main-panel.tsx` keeps alongside its filtered
 * view (`trueRawByColumn`/`trueSortedByColumn`), so `computeDropRank`'s
 * collision guard (ticket #45) can see a card Shipped Fade currently hides,
 * not only one an explicit board filter hides. Shipped Fade (ticket #51) is a
 * *display* rule: a faded `shipped` card still holds its stored Board Rank,
 * and a drop landing between two *visible* Shipped cards can collide with
 * that hidden rank exactly the way a filter-hidden card can (`board-ordering
 * .ts`'s `computeDropRank` doc comment) — but until this helper existed, the
 * "true" set was built from `isBoardDisplayable` itself, which already
 * excludes Shipped-Faded tasks, so that specific collision was never actually
 * guarded against. `isBoardDisplayable` must stay narrower than this (it also
 * backs the Task Detail Panel's disappearance handling, which *should* close
 * on a faded task) — this helper exists only for rank arithmetic, never for
 * deciding what is on screen or what backs an open panel.
 */
export function isBoardRankCandidate(task: Task): boolean {
  return task.type === 'task' && !task.archivedAt;
}

/**
 * Column-scoped task creation (ticket #45) may only assign a stage the
 * domain model treats as *manually declared*. Per CONTEXT.md ("Workflow
 * Stage"): "Stage authority is hybrid: GitHub is authoritative for every
 * stage it can prove (`exploring` = open Map, `spec` = open Spec issue,
 * `review` = open PR referencing the Spec, `shipped` = that PR merged); the
 * agent or user declares the rest (`idea`, `implementing`)." `unstaged` (no
 * stage at all) is always a manual starting point — it is the default a task
 * lands in without any placement decision. `triage` is an out-of-flow sink a
 * contradicted GitHub fact pushes a card into, or a user/agent gesture moves
 * it out of (CONTEXT.md "Triage") — never a starting point for a new task.
 *
 * This reading is consistent with (never contradicted by)
 * `deriveWorkflowStageFromIssues` (`src/shared/core/tasks/stage-derivation.ts`
 * — ticket #48 relocated it there from `src/main/core/issues/inbound-sync/` so
 * main and renderer share one literal source), the authority this ticket was
 * pointed at: that function only ever *derives* `spec`, `exploring`, or
 * `triage` from observable issue facts — all three excluded here — and never
 * derives `idea` or `implementing`.
 *
 * This is a narrow, single-purpose answer to one question ("can a column
 * offer creation?"), not the general GitHub-authoritative-stage explanation in
 * ticket #48's `src/shared/core/tasks/stage-authority.ts` contract, which has
 * since landed. That contract can absorb this check — its own reviewer
 * confirmed the two models agree.
 */
export function columnPermitsManualCreation(column: ColumnId): boolean {
  return column === 'unstaged' || column === 'idea' || column === 'implementing';
}

/**
 * Shipped Fade's recent-delivery window, in whole days (ticket #51) — derived
 * from `SHIPPED_FADE_WINDOW_MS`, the exact value `isTaskShippedFaded` checks
 * against, so the Shipped column's disclosure can never state a duration the
 * fade logic does not actually implement.
 */
export const SHIPPED_FADE_WINDOW_DAYS = SHIPPED_FADE_WINDOW_MS / (24 * 60 * 60 * 1000);

/**
 * Disclosure text for the Shipped column (ticket #51, CONTEXT.md "Shipped
 * Fade"): surfaced on the column so older Shipped cards do not appear to
 * vanish arbitrarily once their pull request has been merged a while.
 */
export const SHIPPED_FADE_DISCLOSURE = `Shipped cards are hidden from the board ${SHIPPED_FADE_WINDOW_DAYS} days after their pull request merges. The task keeps its Shipped stage.`;
