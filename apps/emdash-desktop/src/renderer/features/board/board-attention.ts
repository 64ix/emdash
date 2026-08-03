import type { AgentStatus } from '@shared/core/agents/agentEvents';

/**
 * Needs Attention (spec #25): Awaiting Input, Error, or an unreviewed
 * Completed run. `taskAgentStatus` (task-selectors.ts) already limits
 * 'error' and 'completed' to the unseen case
 * (`ConversationManagerStore.taskStatus`), so this is a direct mapping —
 * 'working' and 'idle' (`null`) never count.
 *
 * Shared by the sidebar Board row's attention count (ticket #43) and, later,
 * the board's own Needs Attention filter (ticket #46) so the two never
 * diverge into separate declarations of the same fact.
 */
export function agentStatusNeedsAttention(status: AgentStatus | null): boolean {
  return status === 'awaiting-input' || status === 'error' || status === 'completed';
}
