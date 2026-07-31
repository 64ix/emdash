import type { WorkflowStage } from '@shared/core/tasks/tasks';

/** The one fact this module needs about a linked Spec/Map issue: is it open? */
export type IssueStateFact = { state: 'open' | 'closed' };

export type StageDerivationInput = {
  currentStage: WorkflowStage | null | undefined;
  /** Set when the task has a Spec Linked Issue Role. */
  specIssue?: IssueStateFact;
  /** Set when the task has a Map Linked Issue Role. */
  mapIssue?: IssueStateFact;
  /** Whether a merged PR exists for this task's branch (read from `pullRequests`; see ticket #7 for the general PR-fact derivation this leaves alone). */
  hasMergedPullRequest: boolean;
};

/**
 * Pipeline order used to decide whether an issues-derived stage would
 * *advance* a task rather than regress it. `triage` is excluded — it is an
 * out-of-flow stage handled by its own guard below, not part of this order.
 */
const STAGE_ORDER: Record<Exclude<WorkflowStage, 'triage'>, number> = {
  idea: 0,
  exploring: 1,
  spec: 2,
  implementing: 3,
  review: 4,
  shipped: 5,
};

function canAdvanceTo(
  current: WorkflowStage | null | undefined,
  desired: 'exploring' | 'spec'
): boolean {
  if (!current) return true;
  if (current === 'triage') return false;
  return STAGE_ORDER[current] <= STAGE_ORDER[desired];
}

/**
 * Derives the Workflow Stage implied purely by a task's linked Spec/Map issue
 * facts (docs/adr/0003-board-stages-derived-not-declared.md): open Spec →
 * `spec`, open Map → `exploring`, Spec closed mid-flight with no merged PR →
 * `triage`. Returns null when no derivation applies, in which case the
 * caller must leave the task's current stage untouched.
 *
 * Two invariants this function upholds on its own (ticket #8's guardrails):
 *  - Never returns a change once a task is already in `triage` — only the
 *    user or an agent moves a card back out.
 *  - Never regresses a stage these issue facts can't prove (e.g. `review` /
 *    `shipped`, which are set from PR facts elsewhere) — an issues-only fact
 *    only ever *advances* `spec`/`exploring`, or raises `triage`.
 */
export function deriveWorkflowStageFromIssues(input: StageDerivationInput): WorkflowStage | null {
  const { currentStage, specIssue, mapIssue, hasMergedPullRequest } = input;

  if (currentStage === 'triage') return null;

  if (specIssue) {
    if (specIssue.state === 'open') {
      return canAdvanceTo(currentStage, 'spec') ? 'spec' : null;
    }
    // Spec closed mid-flight: only the "no merged PR" fact is ours to prove.
    // A merged PR is a stronger fact owned by PR-fact derivation (ticket #7).
    return hasMergedPullRequest ? null : 'triage';
  }

  if (mapIssue?.state === 'open') {
    return canAdvanceTo(currentStage, 'exploring') ? 'exploring' : null;
  }

  return null;
}
