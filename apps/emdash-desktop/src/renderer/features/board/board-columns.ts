import { workflowStages, type Task, type WorkflowStage } from '@shared/core/tasks/tasks';

/** Column ids: every Workflow Stage, plus a leading bucket for Unstaged tasks. */
export type ColumnId = WorkflowStage | 'unstaged';

/**
 * Feature Board column labels. Names and ordering follow the glossary in
 * CONTEXT.md ("Workflow Stage", "Triage", "Unstaged").
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
 * Board columns in display/traversal order: the leading Unstaged bucket,
 * then every Workflow Stage in pipeline order (`triage` trails as the
 * out-of-flow stage). Manual chevron moves walk this same order.
 */
export const COLUMNS: ColumnId[] = ['unstaged', ...workflowStages.options];

/** The column a task currently belongs to. */
export function stageOf(task: Task): ColumnId {
  return task.workflowStage ?? 'unstaged';
}

/** The stage reached by moving one column left/right; null when already at the edge. */
export function adjacentStage(current: ColumnId, delta: -1 | 1): WorkflowStage | 'unstaged' | null {
  const index = COLUMNS.indexOf(current) + delta;
  if (index < 0 || index >= COLUMNS.length) return null;
  return COLUMNS[index];
}
