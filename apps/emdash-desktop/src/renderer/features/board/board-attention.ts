import { isBoardDisplayable } from '@renderer/features/board/board-columns';
import { taskAgentStatus } from '@renderer/features/tasks/stores/task-selectors';
import { registeredTaskData, type TaskStore } from '@renderer/features/tasks/stores/task-store';
import type { AgentStatus } from '@shared/core/agents/agentEvents';

/**
 * Needs Attention (spec #25): Awaiting Input, Error, or an unreviewed
 * Completed run. `taskAgentStatus` (task-selectors.ts) already limits
 * 'error' and 'completed' to the unseen case
 * (`ConversationManagerStore.taskStatus`), so this is a direct mapping —
 * 'working' and 'idle' (`null`) never count.
 *
 * Shared by the sidebar Board row's attention count (ticket #43) and the
 * board's own Needs Attention filter (ticket #45) so the two never diverge
 * into separate declarations of the same fact.
 */
export function agentStatusNeedsAttention(status: AgentStatus | null): boolean {
  return status === 'awaiting-input' || status === 'error' || status === 'completed';
}

/**
 * A single task store's Needs Attention membership: it must first be a real,
 * displayable Feature Board card (`isBoardDisplayable`) — an archived task or
 * one hidden by Shipped Fade never counts, even if its last known agent
 * status would otherwise qualify — and then satisfy `agentStatusNeedsAttention`.
 * The single predicate both the sidebar Board row's attention count and the
 * board's own Needs Attention filter apply, so neither can promise more (or
 * less) than the other actually shows.
 */
export function taskNeedsAttention(store: TaskStore): boolean {
  const task = registeredTaskData(store);
  return !!task && isBoardDisplayable(task) && agentStatusNeedsAttention(taskAgentStatus(store));
}

/**
 * Counts Needs Attention tasks across a project's task stores — the sidebar
 * Board row's attention badge (ticket #43). Takes the manager's `tasks` map
 * directly (not the manager itself) so this stays decoupled from
 * `TaskManagerStore`'s full shape.
 */
export function countTasksNeedingAttention(tasks: ReadonlyMap<string, TaskStore>): number {
  let count = 0;
  for (const store of tasks.values()) {
    if (taskNeedsAttention(store)) count++;
  }
  return count;
}
