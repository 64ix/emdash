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

/** Not yet loaded (`undefined`) reads the same as "no authority fact" — declarative, unlocked. */
export function deriveStageSection(
  currentStage: WorkflowStage | null,
  authority: TaskStageAuthority | null | undefined
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
    stage: deriveStageSection(input.task.workflowStage ?? null, input.stageAuthority),
  };
}
