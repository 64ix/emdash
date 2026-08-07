import { parseRepositoryRef } from '@shared/repository-ref';
import {
  findSpecMatchingPrs,
  parseIssueNumberFromIdentifier,
} from './pr-workflow-derivation';
import { selectCurrentPr, type PullRequest } from './pull-requests';

/**
 * The single shared notion of "the task's PR" (CONTEXT.md "Assigned PR",
 * docs/adr/0009): the user-assigned PR when one is set, else the current
 * branch-matched PR (`selectCurrentPr`), else the Spec-referencing PR —
 * the same precedence the Workflow Stage authority uses. Both display
 * surfaces (the task titlebar's PR chip and the Task Detail Panel's PR
 * section) derive the task's PR through this helper so they can never
 * disagree.
 *
 * Kept dependency-light and pure so both the renderer and the main process
 * can use it, and so the precedence is unit-testable in isolation.
 */

export type TaskPrDerivationInput = {
  /**
   * The task's Assigned PR (`Task.assignedPr`, resolved by `getTasks` from
   * `tasks.assigned_pr_url`). Empty for every task today — the assignment
   * UI is ticket #100 — but the seam is already live.
   */
  assignedPr?: PullRequest | null;
  /**
   * The PRs to derive from: the task's synced PRs (the branch-matched set
   * `getPullRequestsForTask` loads into `Task.prs`). Callers feeding a
   * broader set (e.g. the Task Detail Panel's stage-authority PRs) must
   * scope the branch match themselves via `taskBranch`.
   */
  prs: readonly PullRequest[];
  /**
   * The task's Spec Linked Issue Role (`Task.linkedIssues.spec`), used for
   * the Spec-referencing fallback. Absent when the task has no Spec link.
   */
  spec?: { identifier: string | null | undefined; url: string | null | undefined } | null;
  /** The task's provisioned branch, when known. Scope for the branch match. */
  taskBranch?: string | null;
};

/**
 * Resolves the task's PR: `assignedPr` when set, else the current PR on the
 * task's branch (open beats most-recently-created, via `selectCurrentPr`),
 * else the most relevant PR referencing the task's Spec issue (matched with
 * the same rules the board sync uses, `findSpecMatchingPrs`). `undefined`
 * when nothing matches — the callers render no PR at all then.
 */
export function resolveTaskPr(input: TaskPrDerivationInput): PullRequest | undefined {
  if (input.assignedPr) return input.assignedPr;

  const branchPrs = input.taskBranch
    ? input.prs.filter((pr) => pr.headRefName === input.taskBranch)
    : input.prs;
  const branchCurrent = selectCurrentPr(branchPrs);
  if (branchCurrent) return branchCurrent;

  const specPrs = findSpecMatchingPrs(input.prs, {
    specIssueNumber: parseIssueNumberFromIdentifier(input.spec?.identifier),
    specRepositoryUrl: specRepositoryUrlOf(input.spec),
    taskBranch: input.taskBranch ?? null,
  });
  return selectCurrentPr(specPrs);
}

/**
 * The repository a task's Spec issue lives in, in the same normalized shape
 * as `pull_requests.repository_url` (mirrors the main-process
 * `specRepositoryUrlOf` in board-sync-service.ts, which cannot be imported
 * from the renderer). Null when the Spec link carries no parseable GitHub
 * issue URL — `findSpecMatchingPrs` treats that as "unknown, stay
 * unscoped" rather than "matches nothing".
 */
function specRepositoryUrlOf(spec?: { url?: string | null } | null): string | null {
  const url = spec?.url;
  if (!url) return null;
  return parseGitHubIssueUrl(url)?.repositoryUrl ?? null;
}

/** Parses a GitHub issue URL into its normalized repository URL, or null. */
function parseGitHubIssueUrl(url: string): { repositoryUrl: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  const segments = parsed.pathname.split('/').filter(Boolean);
  // lastIndexOf, not indexOf: an owner or repo literally named "issues"
  // would otherwise match the wrong segment (same rule as the main-process
  // parseGitHubIssueUrl).
  const issuesIndex = segments.lastIndexOf('issues');
  if (issuesIndex < 2) return null;

  const owner = segments[issuesIndex - 2];
  const repo = segments[issuesIndex - 1];
  const numberSegment = segments[issuesIndex + 1];
  const number = numberSegment ? Number.parseInt(numberSegment, 10) : NaN;
  if (!owner || !repo || !Number.isFinite(number)) return null;

  const repository = parseRepositoryRef(`${parsed.protocol}//${parsed.host}/${owner}/${repo}`);
  return repository ? { repositoryUrl: repository.repositoryUrl } : null;
}
