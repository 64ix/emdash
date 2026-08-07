import { agentStatusNeedsAttention } from '@renderer/features/board/agent-attention';
import { isBoardDisplayable } from '@renderer/features/board/board-columns';
import { taskAgentStatus } from '@renderer/features/tasks/stores/task-selectors';
import { registeredTaskData, type TaskStore } from '@renderer/features/tasks/stores/task-store';

/**
 * A single task store's Needs Attention membership: it must first be a real,
 * displayable Feature Board card (`isBoardDisplayable`) — an archived task or
 * one hidden by Shipped Fade never counts, even if its last known agent
 * status would otherwise qualify — and then satisfy `agentStatusNeedsAttention`.
 * The single predicate both the sidebar project row's attention count and the
 * board's own Needs Attention filter apply, so neither can promise more (or
 * less) than the other actually shows.
 */
export function taskNeedsAttention(store: TaskStore): boolean {
  const task = registeredTaskData(store);
  return !!task && isBoardDisplayable(task) && agentStatusNeedsAttention(taskAgentStatus(store));
}
