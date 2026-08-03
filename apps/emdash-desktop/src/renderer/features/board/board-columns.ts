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
  return task.type === 'task' && !task.archivedAt && !isTaskShippedFaded(task, now);
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
