import type { AgentProviderId } from '@emdash/plugins/agents';
import { conversationTabKind } from '@renderer/features/conversations/conversation-tab-kind';
import { formatConversationTitleForDisplay } from '@renderer/features/conversations/conversation-title-utils';
import type { AgentStatus } from '@shared/core/agents/agentEvents';
import type { ConversationType } from '@shared/core/conversations/conversations';
import type { GhostCard } from '@shared/core/issues/ghost-card';
import type { LinkedIssue, LinkedIssueRole, LinkedIssueRoles } from '@shared/core/linked-issue';
import type { PullRequest } from '@shared/core/pull-requests/pull-requests';
import { resolveTaskPr } from '@shared/core/pull-requests/task-pr';
import {
  deriveStageAuthority,
  describeStageAuthorityFact,
} from '@shared/core/tasks/stage-authority';
import type { Task, TaskStageAuthority, WorkflowStage } from '@shared/core/tasks/tasks';

/**
 * Pure view-model module for the Task Detail Panel (CONTEXT.md "Task Detail
 * Panel", ticket #41): computes everything the panel displays from store data
 * and the `tasks.getTaskStageAuthority` RPC result. Components stay thin —
 * they only render what this module hands them.
 */

// ---------------------------------------------------------------------------
// Vitals
// ---------------------------------------------------------------------------

export type TaskDetailPanelVitals = {
  name: string;
  /** `null` when the task has never been provisioned (no worktree yet). */
  branchName: string | null;
  createdAt: string;
  /** Session counts by provider id, same shape as `TaskStore.conversationStats`. */
  sessionCounts: Record<string, number>;
  totalSessionCount: number;
  agentStatus: AgentStatus | null;
};

export function deriveTaskVitals(
  task: Pick<Task, 'name' | 'createdAt'>,
  input: {
    branchName: string | null;
    sessionCounts: Record<string, number>;
    agentStatus: AgentStatus | null;
  }
): TaskDetailPanelVitals {
  return {
    name: task.name,
    branchName: input.branchName,
    createdAt: task.createdAt,
    sessionCounts: input.sessionCounts,
    totalSessionCount: Object.values(input.sessionCounts).reduce((a, b) => a + b, 0),
    agentStatus: input.agentStatus,
  };
}

// ---------------------------------------------------------------------------
// Conversations (ticket #68)
// ---------------------------------------------------------------------------

/**
 * The minimal shape the Conversations section derives a row from — the same
 * fields already sitting on a task's `ConversationManagerStore` entries (the
 * registry every task's conversations are preloaded into on project mount;
 * see `getConversationsForTask`), so the panel component only ever maps live
 * store data into this shape rather than re-deriving any of it itself.
 * `indicatorStatus` is the same computed value `ConversationStore` itself
 * already exposes (working / unseen awaiting-input / unseen error / unseen
 * completed / null) — the one place "what does this conversation's status
 * dot show" is decided; this module only sorts and formats from it.
 */
export type TaskDetailPanelConversationInput = {
  id: string;
  providerId: AgentProviderId;
  /** The conversation's own stored title — used verbatim for inline rename, never reformatted. */
  title: string;
  type?: ConversationType;
  lastInteractedAt: string | null;
  indicatorStatus: AgentStatus | null;
};

export type TaskDetailPanelConversationRow = {
  id: string;
  providerId: AgentProviderId;
  /** The conversation's own stored title, unformatted — the value inline rename edits. */
  rawTitle: string;
  /** Display title (CONTEXT.md): falls back the same way `formatConversationTitleForDisplay`
   * already does for the task view's own conversations sidebar. */
  displayTitle: string;
  /** The surface this conversation opens in — 'acp-chat' vs. 'conversation' (terminal),
   * resolved via the same `conversationTabKind` mapper `WorkspaceViewModel.openConversation`
   * (ticket #67) and the sidebar already use. Never a second mapper. */
  tabKind: 'conversation' | 'acp-chat';
  lastInteractedAt: string | null;
  indicatorStatus: AgentStatus | null;
};

function toTimestamp(value: string | null): number | null {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? null : time;
}

/**
 * Derives the Conversations section's rows (ticket #68), in display order:
 * unseen Awaiting Input conversations first (the same predicate
 * `partitionAwaitingInput`/ADR 0002 elevate a board card with — here, a
 * conversation whose own `indicatorStatus` is `'awaiting-input'`), then the
 * rest ordered by descending last-interaction. A missing last-interaction
 * timestamp sorts last within its partition rather than first (treated as
 * "never", not "just now"). Ties (including two conversations that have
 * never interacted) keep their input order — a stable tiebreak, not an
 * arbitrary reshuffle on equal timestamps. This is a render-time ordering
 * only: nothing here writes anything back (ADR 0002's rule, applied to
 * Conversations — see "Further Notes" in the spec).
 */
export function deriveConversationRows(
  conversations: readonly TaskDetailPanelConversationInput[]
): TaskDetailPanelConversationRow[] {
  return conversations
    .map((conversation, sortIndex) => ({
      sortIndex,
      isAwaitingInput: conversation.indicatorStatus === 'awaiting-input',
      time: toTimestamp(conversation.lastInteractedAt),
      row: {
        id: conversation.id,
        providerId: conversation.providerId,
        rawTitle: conversation.title,
        displayTitle: formatConversationTitleForDisplay(
          conversation.providerId,
          conversation.title
        ),
        tabKind: conversationTabKind(conversation.type),
        lastInteractedAt: conversation.lastInteractedAt,
        indicatorStatus: conversation.indicatorStatus,
      },
    }))
    .sort((a, b) => {
      if (a.isAwaitingInput !== b.isAwaitingInput) return a.isAwaitingInput ? -1 : 1;
      if (a.time === null && b.time === null) return a.sortIndex - b.sortIndex;
      if (a.time === null) return 1;
      if (b.time === null) return -1;
      if (a.time !== b.time) return b.time - a.time;
      return a.sortIndex - b.sortIndex;
    })
    .map((entry) => entry.row);
}

// ---------------------------------------------------------------------------
// Typed Linked Issue links (Origin / Map / Spec)
// ---------------------------------------------------------------------------

export type TaskDetailPanelLink = { role: LinkedIssueRole; issue: LinkedIssue };

/** Most-advanced-last ordering (Origin, Map, Spec — CONTEXT.md), omitting unset roles entirely. */
const LINKED_ISSUE_DISPLAY_ORDER: readonly LinkedIssueRole[] = ['origin', 'map', 'spec'];

export function deriveLinkedIssueSections(
  linkedIssues: LinkedIssueRoles | null | undefined
): TaskDetailPanelLink[] {
  if (!linkedIssues) return [];
  return LINKED_ISSUE_DISPLAY_ORDER.flatMap((role) => {
    const issue = linkedIssues[role];
    return issue ? [{ role, issue }] : [];
  });
}

// ---------------------------------------------------------------------------
// Workflow Stage authority
// ---------------------------------------------------------------------------

/**
 * The Workflow Stages the panel's selector may assign directly (CONTEXT.md
 * "Workflow Stage": "the agent or user declares the rest"), plus `triage` —
 * the out-of-flow stage CONTEXT.md documents as exited only by a user/agent
 * gesture. `exploring`, `spec`, `review` and `shipped` are GitHub-provable and
 * are never offered here: the panel must not let a manual choice masquerade
 * as a fact the sync could contradict.
 */
export const DECLARATIVE_WORKFLOW_STAGES: readonly WorkflowStage[] = [
  'idea',
  'implementing',
  'triage',
];

export type TaskDetailPanelStage = {
  current: WorkflowStage | null;
  locked: boolean;
  /** Empty while `locked`; the assignable declarative stages otherwise. */
  options: readonly WorkflowStage[];
  /**
   * Human-readable stage-authority explanation (ticket #49): set whenever
   * the shared contract has something to say about the current placement —
   * a governing GitHub fact (`locked: true`), the workspace fact behind a
   * runtime-derived `implementing` (`provisioned-implementation`), or a
   * genuinely manual placement, explicitly labelled "manual" so it reads as
   * distinguishable from a synchronized fact. `null` only when there is no
   * stage to explain at all (Unstaged, `currentStage === null`, with no
   * fact backing it either).
   */
  explanation: string | null;
  explanationLink: { url: string; label: string } | null;
};

/**
 * Delegates to the shared explanation contract (ticket #48,
 * `@shared/core/tasks/stage-authority.ts`) — the single pure function that
 * computes a task's Workflow Stage authority from the same observable facts
 * and precedence rules board synchronization uses — for both *which* fact
 * governs (`deriveStageAuthority`) and *how to describe it*
 * (`describeStageAuthorityFact`). This panel only adapts the result into its
 * own selector shape; it never re-derives an authority or a description
 * itself (ticket #48's "no second source of truth" is load-bearing here).
 *
 * Not yet loaded (`undefined` authority) reads the same as "no PR authority
 * fact" — declarative, unlocked, unless the linked Map/Spec issue itself
 * governs `currentStage` (an open, GitHub-provenanced issue the periodic
 * issues sync would read as open — see `deriveStageAuthority`'s docstring).
 *
 * `hasWorkspace` (ticket #49) is the same `task.workspaceId != null` fact
 * `board-main-panel.tsx`'s `authorityForTask` already threads through for
 * drag-time authority — passing it here lets a persisted `implementing`
 * stage surface the `provisioned-implementation` fact (naming the workspace
 * behind it) instead of always falling back to an unexplained manual
 * placement. Defaults to `false` for direct callers that don't have it yet.
 */
export function deriveStageSection(
  currentStage: WorkflowStage | null,
  authority: TaskStageAuthority | null | undefined,
  linkedIssues?: LinkedIssueRoles | null,
  hasWorkspace = false
): TaskDetailPanelStage {
  const result = deriveStageAuthority({
    currentStage,
    linkedIssues,
    prAuthority: authority,
    hasWorkspace,
  });

  const description = describeStageAuthorityFact(result.fact);
  // A `manual` fact with no current stage at all (Unstaged) has nothing to
  // label — "manual placement" only makes sense once a stage is actually
  // set. Every other fact kind (including `provisioned-implementation`,
  // which only ever accompanies a persisted `implementing`) always has an
  // actual stage to explain.
  const explanation =
    result.fact.kind === 'manual' && currentStage === null ? null : description.fact;

  return {
    current: currentStage,
    locked: result.governs,
    options: result.governs ? [] : DECLARATIVE_WORKFLOW_STAGES,
    explanation,
    explanationLink: explanation ? description.link : null,
  };
}

// ---------------------------------------------------------------------------
// Ghost mode shape (rendering itself is ticket #42's scope)
// ---------------------------------------------------------------------------

export type GhostDetailViewModel = {
  title: string;
  body: string;
  url: string;
};

export function deriveGhostDetailViewModel(ghostCard: GhostCard): GhostDetailViewModel {
  return {
    title: ghostCard.issue.title,
    body: ghostCard.issue.description ?? '',
    url: ghostCard.issue.url,
  };
}

// ---------------------------------------------------------------------------
// The assembled panel view model
// ---------------------------------------------------------------------------

export type TaskDetailPanelViewModel = {
  vitals: TaskDetailPanelVitals;
  /** Conversations section rows (ticket #68), already in display order — see
   * `deriveConversationRows`. Empty for a task with no conversations yet; the
   * section itself still renders (an explicit empty state), never hidden. */
  conversations: TaskDetailPanelConversationRow[];
  links: TaskDetailPanelLink[];
  /**
   * The task's PR (CONTEXT.md "Assigned PR", docs/adr/0009, ticket #100): the
   * user-assigned PR when one is set, else the derived PR — the current
   * branch-matched PR, else the Spec-referencing PR — via the same shared
   * `resolveTaskPr` helper the task titlebar's PR chip uses, so the panel and
   * the titlebar can never disagree. `null` when nothing matches; the
   * panel's "Pull request" section renders only when this is non-null.
   */
  pullRequest: PullRequest | null;
  stage: TaskDetailPanelStage;
};

export function buildTaskDetailPanelViewModel(input: {
  task: Task;
  branchName: string | null;
  sessionCounts: Record<string, number>;
  agentStatus: AgentStatus | null;
  stageAuthority: TaskStageAuthority | null | undefined;
  conversations?: readonly TaskDetailPanelConversationInput[];
}): TaskDetailPanelViewModel {
  return {
    vitals: deriveTaskVitals(input.task, {
      branchName: input.branchName,
      sessionCounts: input.sessionCounts,
      agentStatus: input.agentStatus,
    }),
    conversations: deriveConversationRows(input.conversations ?? []),
    links: deriveLinkedIssueSections(input.task.linkedIssues),
    pullRequest:
      resolveTaskPr({
        assignedPr: input.task.assignedPr ?? null,
        prs: input.task.prs ?? [],
        spec: input.task.linkedIssues?.spec ?? null,
        taskBranch: input.branchName,
      }) ?? null,
    stage: deriveStageSection(
      input.task.workflowStage ?? null,
      input.stageAuthority,
      input.task.linkedIssues,
      input.task.workspaceId != null
    ),
  };
}
