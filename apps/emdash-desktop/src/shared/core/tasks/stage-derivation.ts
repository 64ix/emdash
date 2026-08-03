import { workflowStages, type WorkflowStage } from '@shared/core/tasks/tasks';

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
 * Pipeline rank used to decide whether an issues-derived stage would
 * *advance* a task rather than regress it, derived from the canonical
 * `workflowStages` enum order so the two can't drift. `triage` trails the
 * enum as the out-of-flow stage and is handled by its own guards below,
 * never through this ranking. Exported for `stage-authority.ts` (ticket #48),
 * which needs the exact same rank to decide which cross-stage board
 * destinations `deriveWorkflowStageFromIssues`'s own `canAdvanceTo` rule would
 * — and would not — silently overwrite.
 */
export function stageRank(stage: WorkflowStage): number {
  return workflowStages.options.indexOf(stage);
}

/**
 * Whether an issue-derived fact proving `desired` would *advance or match*
 * `current` rather than regress it — the direction guard behind both
 * `deriveWorkflowStageFromIssues`'s open-Map/open-Spec branches. Exported for
 * `stage-authority.ts` (ticket #48): the same predicate that decides whether
 * the periodic issues sync would (re)assert `desired` also decides whether an
 * open Map/Spec issue currently governs a card sitting at `current`.
 */
export function canAdvanceTo(
  current: WorkflowStage | null | undefined,
  desired: 'exploring' | 'spec'
): boolean {
  if (!current) return true;
  if (current === 'triage') return false;
  return stageRank(current) <= stageRank(desired);
}

/**
 * True when a closed Spec issue with no matching merged PR is the fact that
 * justifies Triage — the "Spec closed mid-flight" contradiction (ADR 0003).
 * Extracted so a caller that needs to *explain* a Triage-bound placement
 * (`stage-authority.ts`, ticket #48) can ask this question directly:
 * `deriveWorkflowStageFromIssues` deliberately refuses to derive anything
 * once `currentStage` is already `triage` (see its own docstring) — that
 * guard protects the periodic sync from re-deriving a sink stage, it is not a
 * statement that the underlying fact stops existing.
 */
export function isClosedSpecTriageContradiction(
  specIssue: IssueStateFact | undefined,
  hasMergedPullRequest: boolean
): boolean {
  return specIssue?.state === 'closed' && !hasMergedPullRequest;
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
    // `review`/`shipped` are PR-proven stages issue facts can't outrank
    // (the invariant documented above): a closed Spec must never drag a task
    // whose PR is open or merged back into `triage` — e.g. the common
    // "Closes #N" auto-close racing ahead of the local PR-row sync.
    if (currentStage === 'review' || currentStage === 'shipped') return null;
    return isClosedSpecTriageContradiction(specIssue, hasMergedPullRequest) ? 'triage' : null;
  }

  if (mapIssue?.state === 'open') {
    return canAdvanceTo(currentStage, 'exploring') ? 'exploring' : null;
  }

  return null;
}
