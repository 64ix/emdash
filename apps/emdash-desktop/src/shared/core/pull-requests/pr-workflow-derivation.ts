import type { WorkflowStage } from '../tasks/tasks';
import type { PullRequestStatus } from './pull-requests';

/**
 * Pure PR-fact derivation for Workflow Stage (see CONTEXT.md "Workflow Stage" and
 * docs/adr/0003-board-stages-derived-not-declared.md). Kept dependency-free so both
 * the main-process board sync service and the renderer's Shipped Fade filter can
 * reuse the exact same matching and precedence rules.
 */

/** The subset of a synced PR row needed to match it to a task and derive a stage. */
export type PrWorkflowFact = {
  headRefName: string;
  status: PullRequestStatus;
  description: string | null;
};

/** The PR-provable stages this ticket derives. `exploring`/`spec` are derived elsewhere (issue sync). */
export type PrDerivedStage = 'review' | 'shipped' | 'triage';

/** Shipped Fade window: `shipped` cards whose PR merged longer ago than this are hidden from the board. */
export const SHIPPED_FADE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/** Parses a GitHub-style issue identifier (`"#42"`, `"42"`) into its numeric issue number. */
export function parseIssueNumberFromIdentifier(
  identifier: string | null | undefined
): number | null {
  if (!identifier) return null;
  const match = /^#?(\d+)$/.exec(identifier.trim());
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/** True when `text` mentions `issueNumber` as a standalone number (not part of a longer one). */
function referencesIssueNumber(text: string, issueNumber: number): boolean {
  return new RegExp(`(?:^|[^\\d])${issueNumber}(?:[^\\d]|$)`).test(text);
}

/**
 * Finds the PRs that count as "referencing the Spec" for a task.
 *
 * Primary match: the PR's body or branch references the Spec issue's number.
 * Fallback (only when the primary match finds nothing): the PR's branch is exactly
 * the task's own provisioned branch — the existing headRefName<->task-branch match.
 */
export function findSpecMatchingPrs<T extends PrWorkflowFact>(
  prs: readonly T[],
  task: { specIssueNumber: number | null; taskBranch?: string | null }
): T[] {
  if (task.specIssueNumber != null) {
    const bySpec = prs.filter(
      (pr) =>
        (pr.description != null && referencesIssueNumber(pr.description, task.specIssueNumber!)) ||
        referencesIssueNumber(pr.headRefName, task.specIssueNumber!)
    );
    if (bySpec.length > 0) return bySpec;
  }
  if (task.taskBranch) {
    return prs.filter((pr) => pr.headRefName === task.taskBranch);
  }
  return [];
}

/**
 * Derives the single most decisive PR-provable stage from a task's matching PRs.
 * Open beats merged beats closed — an open PR (e.g. a follow-up) is the current
 * truth even if an earlier matching PR was merged or closed. Returns `null` when
 * no matching PR proves anything (caller must leave the task's stage untouched).
 */
export function derivePrStage(prs: readonly PrWorkflowFact[]): PrDerivedStage | null {
  if (prs.some((pr) => pr.status === 'open')) return 'review';
  if (prs.some((pr) => pr.status === 'merged')) return 'shipped';
  if (prs.some((pr) => pr.status === 'closed')) return 'triage';
  return null;
}

/** True when a `shipped` card's PR merged more than the Shipped Fade window ago. */
export function isShippedFaded(
  mergedAt: string | null | undefined,
  now: number = Date.now()
): boolean {
  if (!mergedAt) return false;
  const mergedTime = new Date(mergedAt).getTime();
  if (Number.isNaN(mergedTime)) return false;
  return now - mergedTime > SHIPPED_FADE_WINDOW_MS;
}

/** The result of {@link deriveTaskStageAuthorityFact}: the PR (if any) that proves
 * a task's stage, and whether it currently governs the task's *persisted* stage. */
export type TaskStageAuthorityFact<T extends PrWorkflowFact> = {
  /** The single Spec-matching PR proving `derivePrStage`'s result — same
   * open-beats-merged-beats-closed precedence, so its `status` always matches
   * the stage it would derive. `null` when the task has no Spec link, or no PR
   * references it at all. */
  holdingPr: T | null;
  /**
   * `true` when `holdingPr` currently governs the task's Workflow Stage — i.e.
   * the next `BoardSyncService.syncProject` pass will (re)write it, so a caller
   * must treat the stage as GitHub-proven and never offer a conflicting manual
   * write. Always `false` while `currentStage` is `triage`: the periodic pass
   * never re-derives a triaged task (see `syncProject`), so nothing contests a
   * manual move out of it, even when `holdingPr` is the very fact that put it
   * there.
   */
  isCurrentStageGithubProven: boolean;
};

/**
 * Derives the Workflow Stage authority fact for a task's Spec link: which PR (if
 * any) proves its stage, and whether that fact currently governs the *persisted*
 * stage. See CONTEXT.md ("Workflow Stage") and docs/adr/0003 for the authority
 * model, and `BoardSyncService.syncProject` for the periodic pass this fact
 * predicts. Scope: this only covers the PR-provable half of ADR 0003 (`review`,
 * `shipped`, PR-triggered `triage`) — the issue-provable half (`exploring`,
 * `spec` from a live Map/Spec issue state) needs a live GitHub call the inbound
 * issues sync alone performs, not data already at hand, so it is intentionally
 * left alone here.
 */
export function deriveTaskStageAuthorityFact<T extends PrWorkflowFact>(input: {
  currentStage: WorkflowStage | null;
  specIssueNumber: number | null;
  taskBranch?: string | null;
  prFacts: readonly T[];
}): TaskStageAuthorityFact<T> {
  if (input.specIssueNumber == null) {
    return { holdingPr: null, isCurrentStageGithubProven: false };
  }

  const matches = findSpecMatchingPrs(input.prFacts, {
    specIssueNumber: input.specIssueNumber,
    taskBranch: input.taskBranch,
  });
  const derivedStage = derivePrStage(matches);
  if (!derivedStage) {
    return { holdingPr: null, isCurrentStageGithubProven: false };
  }

  const holdingStatus: PullRequestStatus =
    derivedStage === 'review' ? 'open' : derivedStage === 'shipped' ? 'merged' : 'closed';
  const holdingPr = matches.find((pr) => pr.status === holdingStatus) ?? null;

  return {
    holdingPr,
    isCurrentStageGithubProven: input.currentStage !== 'triage',
  };
}
