import { isShippedFaded } from '@shared/core/pull-requests/pr-workflow-derivation';
import type { Task } from '@shared/core/tasks/tasks';
import type { ColumnId } from './board-ordering';

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
  return task.type === 'task' && !task.archivedAt && !isTaskShippedFaded(task, now);
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
 * `deriveWorkflowStageFromIssues`
 * (`src/main/core/issues/inbound-sync/stage-derivation.ts`), the authority
 * this ticket was pointed at: that function only ever *derives* `spec`,
 * `exploring`, or `triage` from observable issue facts — all three excluded
 * here — and never derives `idea` or `implementing`.
 *
 * This is a narrow, single-purpose answer to one question ("can a column
 * offer creation?"), not the general GitHub-authoritative-stage explanation
 * ticket #48's stage-authority contract is building. That contract can
 * absorb this check once it exists — see ticket #45's notes.
 */
export function columnPermitsManualCreation(column: ColumnId): boolean {
  return column === 'unstaged' || column === 'idea' || column === 'implementing';
}
