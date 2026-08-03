import type { AgentStatus } from '@shared/core/agents/agentEvents';

/**
 * Needs Attention (spec #25, CONTEXT.md agent attention semantics): Awaiting
 * Input, Error, or an unreviewed Completed run. `taskAgentStatus`
 * (task-selectors.ts) already limits 'error' and 'completed' to the unseen
 * case (`ConversationManagerStore.taskStatus`), so this is a direct mapping —
 * 'working' and idle (`null`) never count.
 *
 * A dependency-free leaf module: no store import, so this can be imported
 * from both `board-attention.ts` (the sidebar Board row's attention count,
 * ticket #43) and `board-filters.ts` (the board's own Needs Attention
 * filter, ticket #45 — which must stay importable from a plain `node` unit
 * test with no browser globals) without either pulling in
 * `task-store.ts`'s much heavier transitive chain (`workspace-view-model.tsx`
 * -> conversation stores -> `@emdash/chat-ui`, which touches `document` at
 * module scope and crashes outside a DOM). Verified directly: making
 * `board-filters.ts` import `board-attention.ts` fails `board-filters.test.ts`
 * with "document is not defined" under the `node` vitest project.
 *
 * The exhaustive switch (rather than a boolean expression over string
 * literals) means adding a new `AgentStatus` member is a compile error here
 * until this function is updated for it — the two Needs Attention surfaces
 * share this single implementation, so they can never silently diverge for a
 * status that doesn't exist yet.
 */
export function agentStatusNeedsAttention(status: AgentStatus | null): boolean {
  if (status === null) return false;
  switch (status) {
    case 'awaiting-input':
    case 'error':
    case 'completed':
      return true;
    case 'idle':
    case 'working':
      return false;
  }
}
