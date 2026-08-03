import { agentStatusNeedsAttention } from '@renderer/features/board/agent-attention';
import { stageOf, type ColumnId } from '@renderer/features/board/board-ordering';
import type { AgentStatus } from '@shared/core/agents/agentEvents';
import {
  linkedIssueDisplayIdentifier,
  linkedIssueRoleSchema,
  mostAdvancedLinkedIssue,
} from '@shared/core/linked-issue';
import type { Task } from '@shared/core/tasks/tasks';

/**
 * Presentation-only Feature Board filtering (ticket #45): every predicate
 * here reads task/agent-status facts and never writes anything — filtering
 * must never touch Board Rank or Workflow Stage (CONTEXT.md "Board Rank").
 * Persistence only ever happens through `TaskStore.updateBoardPosition`
 * (drag-and-drop, the Task Detail Panel's stage selector, and column-scoped
 * creation), none of which this module imports or calls.
 *
 * Imports its Needs Attention rule from `agent-attention.ts` rather than
 * `board-attention.ts`: `board-attention.ts` also pulls in `task-store.ts`'s
 * much heavier transitive chain (`workspace-view-model.tsx` -> conversation
 * stores -> `@emdash/chat-ui`, which touches `document` at module scope and
 * crashes outside a DOM), which would break this module's plain `node` unit
 * test. `agent-attention.ts` has no store import at all, so both this module
 * and `board-attention.ts` share the exact same implementation instead of
 * each declaring their own copy of the rule.
 */

// ── Agent state ──────────────────────────────────────────────────────────────

/**
 * Compact "agent state" filter bucket. `taskAgentStatus` (task-selectors.ts)
 * never literally returns `AgentStatus`'s own `'idle'` value at the task
 * level (that only exists per-conversation) — its `null` aggregate ("no
 * active/awaiting/unseen status") maps to the `'idle'` filter bucket so the
 * filter still offers the "idle" vocabulary the parent spec names (spec #25's
 * User Story 26).
 */
export type AgentStateFilterValue = 'working' | 'awaiting-input' | 'error' | 'completed' | 'idle';

export const AGENT_STATE_FILTER_LABELS: Record<AgentStateFilterValue, string> = {
  working: 'Working',
  'awaiting-input': 'Awaiting Input',
  error: 'Error',
  completed: 'Completed',
  idle: 'Idle',
};

export function agentStateFilterValue(status: AgentStatus | null): AgentStateFilterValue {
  return status ?? 'idle';
}

// ── Linked Issue presence ────────────────────────────────────────────────────

export type LinkedIssuePresenceFilterValue = 'linked' | 'unlinked';

export const LINKED_ISSUE_PRESENCE_FILTER_LABELS: Record<LinkedIssuePresenceFilterValue, string> = {
  linked: 'Has Linked Issue',
  unlinked: 'No Linked Issue',
};

export function linkedIssuePresenceFilterValue(task: Task): LinkedIssuePresenceFilterValue {
  return mostAdvancedLinkedIssue(task.linkedIssues) ? 'linked' : 'unlinked';
}

// ── Pull Request state ───────────────────────────────────────────────────────

/**
 * Compact "Pull Request state" filter bucket, one per task: open beats
 * merged beats closed beats none — the same open-beats-merged-beats-closed
 * precedence `derivePrStage` (`pr-workflow-derivation.ts`) uses to pick the
 * single decisive PR fact, reused here only to *display and filter by* the
 * task's most relevant PR status, never to derive or write a Workflow Stage.
 */
export type PrStateFilterValue = 'open' | 'merged' | 'closed' | 'none';

export const PR_STATE_FILTER_LABELS: Record<PrStateFilterValue, string> = {
  open: 'Open PR',
  merged: 'Merged PR',
  closed: 'Closed PR',
  none: 'No PR',
};

export function prStateFilterValue(task: Task): PrStateFilterValue {
  if (task.prs.some((pr) => pr.status === 'open')) return 'open';
  if (task.prs.some((pr) => pr.status === 'merged')) return 'merged';
  if (task.prs.some((pr) => pr.status === 'closed')) return 'closed';
  return 'none';
}

// ── Search ────────────────────────────────────────────────────────────────

/** Every Linked Issue Role's display identifier ("#123" or similar) — the same string shown on the card's badge and in the Task Detail Panel. */
function linkedIssueSearchIdentifiers(task: Task): string[] {
  const roles = task.linkedIssues;
  if (!roles) return [];
  return linkedIssueRoleSchema.options.flatMap((role) => {
    const issue = roles[role];
    if (!issue) return [];
    const identifier = linkedIssueDisplayIdentifier(issue);
    return identifier ? [identifier] : [];
  });
}

/** Every Pull Request's display identifier ("#123") already shown elsewhere (e.g. `PrRow`). */
function pullRequestSearchIdentifiers(task: Task): string[] {
  return task.prs.flatMap((pr) => (pr.identifier ? [pr.identifier] : []));
}

/**
 * Search matches the task name and the display identifiers of its Linked
 * Issues and Pull Requests (spec #25's Implementation Decisions) — the exact
 * strings already shown on the card and in the Task Detail Panel, not raw
 * issue/PR titles or URLs. An empty (or all-whitespace) query matches
 * everything.
 */
export function matchesSearchQuery(task: Task, query: string): boolean {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return true;
  if (task.name.toLowerCase().includes(trimmed)) return true;
  const identifiers = [
    ...linkedIssueSearchIdentifiers(task),
    ...pullRequestSearchIdentifiers(task),
  ];
  return identifiers.some((identifier) => identifier.toLowerCase().includes(trimmed));
}

// ── Combined filter state ───────────────────────────────────────────────────

export type BoardFilterState = {
  query: string;
  needsAttentionOnly: boolean;
  stages: ReadonlySet<ColumnId>;
  agentStates: ReadonlySet<AgentStateFilterValue>;
  linkedIssuePresence: ReadonlySet<LinkedIssuePresenceFilterValue>;
  prStates: ReadonlySet<PrStateFilterValue>;
};

export const EMPTY_BOARD_FILTERS: BoardFilterState = {
  query: '',
  needsAttentionOnly: false,
  stages: new Set(),
  agentStates: new Set(),
  linkedIssuePresence: new Set(),
  prStates: new Set(),
};

/** True when any filter would hide at least one otherwise-displayable card. */
export function hasActiveBoardFilters(filters: BoardFilterState): boolean {
  return (
    filters.query.trim() !== '' ||
    filters.needsAttentionOnly ||
    filters.stages.size > 0 ||
    filters.agentStates.size > 0 ||
    filters.linkedIssuePresence.size > 0 ||
    filters.prStates.size > 0
  );
}

/** Returns a new Set with `value` toggled in or out of `set` — used by the header's checkbox handlers. */
export function toggleSetMember<T>(set: ReadonlySet<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

/**
 * The single presentation-only predicate the board applies per card:
 * combines search, Needs Attention, and every compact filter category. Every
 * empty filter category is a no-op (shows everything) — only a non-empty
 * category actually restricts the result, so filters compose as "AND"
 * across categories and "OR" within a category's selected values.
 */
export function taskPassesBoardFilters(
  task: Task,
  agentStatus: AgentStatus | null,
  filters: BoardFilterState
): boolean {
  if (filters.needsAttentionOnly && !agentStatusNeedsAttention(agentStatus)) return false;
  if (!matchesSearchQuery(task, filters.query)) return false;
  if (filters.stages.size > 0 && !filters.stages.has(stageOf(task))) return false;
  if (
    filters.agentStates.size > 0 &&
    !filters.agentStates.has(agentStateFilterValue(agentStatus))
  ) {
    return false;
  }
  if (
    filters.linkedIssuePresence.size > 0 &&
    !filters.linkedIssuePresence.has(linkedIssuePresenceFilterValue(task))
  ) {
    return false;
  }
  if (filters.prStates.size > 0 && !filters.prStates.has(prStateFilterValue(task))) return false;
  return true;
}
