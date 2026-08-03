import type { AgentStatus } from '@shared/core/agents/agentEvents';
import {
  linkedIssueDisplayIdentifier,
  linkedIssueRoleLabels,
  mostAdvancedLinkedIssue,
  type LinkedIssue,
  type LinkedIssueRole,
  type LinkedIssueRoles,
} from '@shared/core/linked-issue';
import { selectCurrentPr, type PullRequest } from '@shared/core/pull-requests/pull-requests';

/**
 * Pure view-model for the Feature Board card (ticket #47, CONTEXT.md "Task
 * Detail Panel" sibling): which single delivery artifact a card should show,
 * and the human label for each of the five agent states a card must
 * distinguish. Dependency-free (no store or RPC access) so this derivation is
 * unit-testable without mounting the board, and so `BoardCard` only ever
 * renders what this module computes — the ticket's load-bearing criterion is
 * that cards and the Task Detail Panel never disagree about a task's facts,
 * so nothing here re-derives a fact a selector or the panel's own view model
 * already owns.
 */

export type CardArtifact =
  | { kind: 'pr'; pr: PullRequest }
  | { kind: 'linked-issue'; role: LinkedIssueRole; issue: LinkedIssue };

/**
 * The single most relevant delivery artifact for a card: the task's current
 * PR (`selectCurrentPr` — the same "current PR" selector the sidebar and List
 * view already use) takes priority over a Linked Issue, since a PR is the
 * most advanced fact in the Origin -> Map -> Spec -> Pull Request chain
 * (CONTEXT.md). Falls back to the most-advanced Linked Issue Role
 * (`mostAdvancedLinkedIssue`, already used by the pre-#47 card). `null` for a
 * purely local task with neither — the degrade-gracefully case ticket #47
 * requires explicitly.
 */
export function deriveCardArtifact(task: {
  prs?: PullRequest[] | null;
  linkedIssues?: LinkedIssueRoles | null;
}): CardArtifact | null {
  const pr = selectCurrentPr(task.prs ?? []);
  if (pr) return { kind: 'pr', pr };
  const link = mostAdvancedLinkedIssue(task.linkedIssues);
  return link ? { kind: 'linked-issue', role: link.role, issue: link.issue } : null;
}

/** Compact label text for the card's artifact badge — mirrors the existing
 * Linked-Issue-only badge text's "role/kind + identifier, else fall back to
 * title" shape so a PR badge reads consistently with an issue badge. */
export function cardArtifactBadgeText(artifact: CardArtifact): string {
  if (artifact.kind === 'pr') {
    return artifact.pr.identifier ? `PR ${artifact.pr.identifier}` : artifact.pr.title;
  }
  const label = linkedIssueRoleLabels[artifact.role];
  const identifier = linkedIssueDisplayIdentifier(artifact.issue);
  return identifier ? `${label} ${identifier}` : label;
}

/** Full title text for the card's artifact badge (tooltip / `title` attribute). */
export function cardArtifactTitle(artifact: CardArtifact): string {
  return artifact.kind === 'pr' ? artifact.pr.title : artifact.issue.title;
}

/**
 * "Recent activity" instant for a card (ticket #47): the task's last
 * interaction if any, else its last update — the same last-interacted-else-
 * updated preference the sidebar already sorts and displays task recency by
 * (`getSortInstant`, `sidebar-store.ts`). Restated as a one-line expression
 * here rather than imported across features: it is a plain fallback over two
 * fields the board already has on hand, not a second definition of a fact
 * with actual branching logic (contrast the agent-state/artifact selectors
 * above, which do delegate to the shared selectors that own that logic).
 */
export function taskActivityInstant(task: {
  updatedAt: string;
  lastInteractedAt?: string;
}): string {
  return task.lastInteractedAt ?? task.updatedAt;
}

/**
 * Human label for the five agent states a card must distinguish (ticket
 * #47): Working, Awaiting Input, Error, Completed, and Idle.
 *
 * `taskAgentStatus` (task-selectors.ts) represents "no active or unseen
 * conversation activity" as `null` rather than the literal `'idle'` string —
 * the model does not actually collapse two states here, it just spells the
 * fifth one two different ways depending on call site (`null` from the real
 * selector; some test doubles hand back the literal string). Both map to the
 * same "Idle" label so a card never shows a sixth, undefined state.
 */
export function agentStateLabel(status: AgentStatus | null): string {
  switch (status) {
    case 'working':
      return 'Working';
    case 'awaiting-input':
      return 'Awaiting input';
    case 'error':
      return 'Error';
    case 'completed':
      return 'Completed';
    case 'idle':
    case null:
      return 'Idle';
  }
}
