import type { AgentStatus } from '@shared/core/agents/agentEvents';
import type { GhostCard } from '@shared/core/issues/ghost-card';
import type { LinkedIssue, LinkedIssueRole, LinkedIssueRoles } from '@shared/core/linked-issue';
import type {
  StageHoldingPr,
  Task,
  TaskStageAuthority,
  WorkflowStage,
} from '@shared/core/tasks/tasks';

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
  /** Human-readable holding-fact explanation, set only while `locked`. */
  explanation: string | null;
  explanationLink: { url: string; label: string } | null;
};

function prLabel(pr: StageHoldingPr): string {
  return pr.identifier ?? pr.title;
}

function stageAuthorityExplanation(pr: StageHoldingPr): string {
  switch (pr.status) {
    case 'open':
      return `Held in Review by an open PR referencing the Spec: ${prLabel(pr)}.`;
    case 'merged':
      return `Held in Shipped by a merged PR referencing the Spec: ${prLabel(pr)}.`;
    case 'closed':
      return `Held in Triage by a closed PR referencing the Spec: ${prLabel(pr)}.`;
  }
}

function issueLabel(issue: LinkedIssue): string {
  return issue.identifier || issue.title;
}

/**
 * Whether a linked issue is the same fact `deriveWorkflowStageFromIssues`
 * (`src/main/core/issues/inbound-sync/stage-derivation.ts`) would read as
 * `state: 'open'`. That function is fed exclusively by the GitHub inbound
 * issues sync (`issues-sync-engine.ts`), which only ever computes Map/Spec
 * facts for issues belonging to the project's connected GitHub repository —
 * a linked issue from another provider is never consulted, no matter what its
 * own status string says. `remoteIssueToLinkedIssue` (`link-suggestions.ts`)
 * stamps `status` with the raw GitHub `state` for those issues, so `provider
 * === 'github' && status === 'open'` is the literal value the derivation
 * would see; every other provider's status vocabulary (e.g. GitLab's
 * `'opened'`, Jira/Linear workflow names, Forgejo's GitHub-shaped `'open'`)
 * is not a fact this panel can treat as GitHub-proven.
 */
function isGithubProvenOpenIssue(issue: LinkedIssue): boolean {
  return issue.provider === 'github' && issue.status === 'open';
}

/** `exploring`/`spec` explanation text using the linked Map/Spec issue itself as the fact. */
function issueStageAuthorityExplanation(stage: 'exploring' | 'spec', issue: LinkedIssue): string {
  return stage === 'exploring'
    ? `Held in Exploring by its linked Map issue: ${issueLabel(issue)}.`
    : `Held in Spec by its linked Spec issue: ${issueLabel(issue)}.`;
}

/**
 * Not yet loaded (`undefined` authority) reads the same as "no PR authority fact" —
 * declarative, unlocked, *unless* `currentStage` is itself `exploring`/`spec`.
 *
 * `exploring` and `spec` are GitHub-provable stages (CONTEXT.md "Workflow Stage",
 * docs/adr/0003) the `tasks.getTaskStageAuthority` RPC doesn't speak to — it only
 * derives the PR-provable half. `DECLARATIVE_WORKFLOW_STAGES` never offers
 * `exploring`/`spec` as a manual choice, but the board's drag-and-drop *can* still
 * move a card into either column (ticket #48/#56) regardless of its linked issues,
 * so a persisted `exploring`/`spec` stage is not proof by itself that the
 * issue-derived sync pass put it there. Lock the selector only when the linked
 * Map/Spec issue is the exact fact `deriveWorkflowStageFromIssues` would read as
 * open (`isGithubProvenOpenIssue`) — a merely-present but closed, stale, or
 * non-GitHub link never gave the sync pass a reason to assert this stage, so
 * asserting an authority explanation from it here would be as false as the
 * drag-and-drop premise this replaces.
 */
export function deriveStageSection(
  currentStage: WorkflowStage | null,
  authority: TaskStageAuthority | null | undefined,
  linkedIssues?: LinkedIssueRoles | null
): TaskDetailPanelStage {
  const holdingPr = authority?.holdingPr ?? null;
  if (authority?.isCurrentStageGithubProven && holdingPr) {
    return {
      current: currentStage,
      locked: true,
      options: [],
      explanation: stageAuthorityExplanation(holdingPr),
      explanationLink: { url: holdingPr.url, label: prLabel(holdingPr) },
    };
  }

  if (currentStage === 'exploring' || currentStage === 'spec') {
    const holdingIssue = currentStage === 'exploring' ? linkedIssues?.map : linkedIssues?.spec;
    if (holdingIssue && isGithubProvenOpenIssue(holdingIssue)) {
      return {
        current: currentStage,
        locked: true,
        options: [],
        explanation: issueStageAuthorityExplanation(currentStage, holdingIssue),
        explanationLink: { url: holdingIssue.url, label: issueLabel(holdingIssue) },
      };
    }
  }

  return {
    current: currentStage,
    locked: false,
    options: DECLARATIVE_WORKFLOW_STAGES,
    explanation: null,
    explanationLink: null,
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
  links: TaskDetailPanelLink[];
  /** The Spec-derived PR (CONTEXT.md), or `null` when none references the Spec yet. */
  pr: StageHoldingPr | null;
  stage: TaskDetailPanelStage;
};

export function buildTaskDetailPanelViewModel(input: {
  task: Task;
  branchName: string | null;
  sessionCounts: Record<string, number>;
  agentStatus: AgentStatus | null;
  stageAuthority: TaskStageAuthority | null | undefined;
}): TaskDetailPanelViewModel {
  return {
    vitals: deriveTaskVitals(input.task, {
      branchName: input.branchName,
      sessionCounts: input.sessionCounts,
      agentStatus: input.agentStatus,
    }),
    links: deriveLinkedIssueSections(input.task.linkedIssues),
    pr: input.stageAuthority?.holdingPr ?? null,
    stage: deriveStageSection(
      input.task.workflowStage ?? null,
      input.stageAuthority,
      input.task.linkedIssues
    ),
  };
}
