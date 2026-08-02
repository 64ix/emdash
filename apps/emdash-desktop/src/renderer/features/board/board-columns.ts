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
