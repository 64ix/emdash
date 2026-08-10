import { parseRepositoryRef } from '@shared/repository-ref';
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
  /**
   * The repository the PR itself lives in (`pull_requests.repository_url`).
   * Load-bearing for matching, not just display: PRs are synced across *every*
   * remote while issues come from the Issue Tracker Repository alone (CONTEXT.md),
   * so a `#66` written in an upstream PR references upstream's issue 66 — never a
   * Spec that happens to be numbered 66 in the fork. Issue and PR numbering is
   * per-repository, so a number match is only meaningful within one repository.
   */
  repositoryUrl: string;
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

/** The normalized `owner/repo` of a repository URL (lowercased), or null. */
function nameWithOwnerOf(repositoryUrl: string): string | null {
  return parseRepositoryRef(repositoryUrl)?.nameWithOwner.toLowerCase() ?? null;
}

/**
 * A GitHub issue reference parsed out of a PR body: the repository it points
 * at (`nameWithOwner`, lowercased) when the body qualified it, else `null`
 * for a bare `#N` — which references the PR's *own* repository.
 */
type BodyIssueReference = { repository: string | null; number: number };

/** `https://host/owner/repo`, `owner/repo#N` — the repo-qualified sigils
 * GitHub itself auto-links. */
const REPO_QUALIFIED_REF = /(?:https?:\/\/[^\s/)]+\/)?([\w.-]+\/[\w.-]+)#(\d+)(?!\d)/g;
/** `https://host/owner/repo/issues/N`. */
const ISSUE_URL_REF = /(?:https?:\/\/[^\s/)]+)?\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)(?!\d)/g;

/**
 * Parses the GitHub issue references in a PR body the way GitHub itself means
 * them: bare `#N` (references the PR's own repository — `repository: null`),
 * repo-qualified `owner/repo#N`, and `/issues/N` URLs. Prose-qualified
 * references name the repository they point at; the Spec-number boundary of
 * `bodyReferencesIssueNumber` lives here, so a `dorny/test-reporter#258`
 * quoted in release notes can never answer for the Spec #258 of the PR's own
 * repository.
 */
function parseBodyIssueReferences(text: string): BodyIssueReference[] {
  const references: BodyIssueReference[] = [];
  for (const match of text.matchAll(REPO_QUALIFIED_REF)) {
    references.push({ repository: match[1].toLowerCase(), number: Number.parseInt(match[2], 10) });
  }
  for (const match of text.matchAll(ISSUE_URL_REF)) {
    references.push({ repository: match[1].toLowerCase(), number: Number.parseInt(match[2], 10) });
  }
  for (const match of text.matchAll(/(?<![\w.-])#(\d+)(?!\d)/g)) {
    references.push({ repository: null, number: Number.parseInt(match[1], 10) });
  }
  return references;
}

/**
 * True when a PR body references `issueNumber` the way GitHub itself means it:
 * a bare `#N`, or a repo-qualified reference (`owner/repo#N`, `/issues/N`
 * URL) pointing at the Spec's repository — when known — or at the PR's own
 * repository. A qualified reference to a *third* repository (`dorny/
 * test-reporter#258` inside a merged PR's dependabot release notes) names
 * that repository's issue, never the Spec's, so it never matches.
 *
 * The sigil is load-bearing. Matching the bare digits with only a
 * "not adjacent to another digit" boundary made every hex commit SHA, gist id
 * and URL slug carrying those digits a reference: a merged PR whose body quoted
 * the commit `66de91d76` proved `shipped` for an open Spec #66, because `6`,`6`
 * sat between a backtick and a `d`. Prose is full of numbers that are not issue
 * references, so the reference has to be marked as one.
 */
function bodyReferencesIssueNumber(
  text: string,
  issueNumber: number,
  options: { prRepository: string | null; specRepository: string | null }
): boolean {
  const { prRepository, specRepository } = options;
  return parseBodyIssueReferences(text).some((reference) => {
    if (reference.number !== issueNumber) return false;
    if (reference.repository === null) return true;
    // A qualified reference only points at the Spec when it names the Spec's
    // repository (when known) or the PR's own repository — `64ix/ProtoRTS#258`
    // in an upstream PR still references the fork's issue, a bare `#258` in a
    // ProtoRTS PR does too, but a third-party issue never does.
    return (
      reference.repository === specRepository ||
      (prRepository != null && reference.repository === prRepository)
    );
  });
}

/**
 * True when a branch name carries `issueNumber` as a token of its own —
 * `spec/42-board-sync`, `42-fix-thing` — rather than as part of a longer number
 * (`420-unrelated`). Branch names are structured slugs rather than prose, and
 * carry no `#`, so the digits alone stay a usable signal here; a PR *body* gets
 * the stricter `bodyReferencesIssueNumber` treatment instead.
 */
function branchReferencesIssueNumber(headRefName: string, issueNumber: number): boolean {
  return new RegExp(`(?:^|[^\\d])${issueNumber}(?:[^\\d]|$)`).test(headRefName);
}

/**
 * Finds the PRs that count as "referencing the Spec" for a task.
 *
 * Candidates are first narrowed to the repository the Spec issue lives in when
 * the caller knows it (`specRepositoryUrl`) — see `PrWorkflowFact.repositoryUrl`
 * for why a cross-repository number match is meaningless. Then:
 *
 * Primary match: the PR's body references the Spec issue (`#N`, `/issues/N`), or
 * its branch carries the Spec number as a token.
 * Fallback (only when the primary match finds nothing): the PR's branch is exactly
 * the task's own provisioned branch — the existing headRefName<->task-branch match.
 */
export function findSpecMatchingPrs<T extends PrWorkflowFact>(
  prs: readonly T[],
  task: {
    specIssueNumber: number | null;
    /**
     * The repository the Spec issue lives in. When set, only PRs in that same
     * repository can match the task at all. Optional so a caller that cannot
     * resolve it keeps the previous, unscoped behaviour rather than matching
     * nothing.
     */
    specRepositoryUrl?: string | null;
    taskBranch?: string | null;
  }
): T[] {
  const candidates = task.specRepositoryUrl
    ? prs.filter((pr) => pr.repositoryUrl === task.specRepositoryUrl)
    : prs;

  if (task.specIssueNumber != null) {
    const bySpec = candidates.filter(
      (pr) =>
        (pr.description != null &&
          bodyReferencesIssueNumber(pr.description, task.specIssueNumber!, {
            prRepository: nameWithOwnerOf(pr.repositoryUrl),
            specRepository: task.specRepositoryUrl ? nameWithOwnerOf(task.specRepositoryUrl) : null,
          })) ||
        branchReferencesIssueNumber(pr.headRefName, task.specIssueNumber!)
    );
    if (bySpec.length > 0) return bySpec;
  }
  if (task.taskBranch) {
    return candidates.filter((pr) => pr.headRefName === task.taskBranch);
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
 * Derives the Workflow Stage authority fact for a task's PR: which PR (if any)
 * proves its stage, and whether that fact currently governs the *persisted*
 * stage. See CONTEXT.md ("Workflow Stage", "Assigned PR") and docs/adr/0003,
 * docs/adr/0009 for the authority model, and `BoardSyncService.syncProject` for
 * the periodic pass this fact predicts. Scope: this only covers the
 * PR-provable half of ADR 0003 (`review`, `shipped`, PR-triggered `triage`) —
 * the issue-provable half (`exploring`, `spec` from a live Map/Spec issue
 * state) needs a live GitHub call the inbound issues sync alone performs, not
 * data already at hand, so it is intentionally left alone here.
 */
export function deriveTaskStageAuthorityFact<T extends PrWorkflowFact>(input: {
  currentStage: WorkflowStage | null;
  /**
   * The task's Assigned PR fact (CONTEXT.md "Assigned PR", docs/adr/0009):
   * when set it is the holding fact — open proves `review`, merged proves
   * `shipped`, closed-without-merge proves `triage` — ahead of every
   * Spec-derived match, with the same "proven unless the persisted stage is
   * `triage`" rule. Independent of the Spec link: a link-less task with an
   * assigned PR still has an authority fact. `null`/`undefined` reads as
   * unassigned, in which case the Spec-derived authority applies unchanged.
   */
  assignedPr?: T | null;
  specIssueNumber: number | null;
  /** The repository the Spec issue lives in — see `findSpecMatchingPrs`. */
  specRepositoryUrl?: string | null;
  taskBranch?: string | null;
  prFacts: readonly T[];
}): TaskStageAuthorityFact<T> {
  if (input.assignedPr) {
    // `PullRequestStatus` is always one of open/merged/closed, so a single
    // assigned PR always derives a stage — the same mapping and the same
    // "never proven while persisted `triage`" rule as the Spec-derived path
    // below (the periodic pass never revisits a triaged task).
    return {
      holdingPr: input.assignedPr,
      isCurrentStageGithubProven: input.currentStage !== 'triage',
    };
  }

  if (input.specIssueNumber == null) {
    return { holdingPr: null, isCurrentStageGithubProven: false };
  }

  const matches = findSpecMatchingPrs(input.prFacts, {
    specIssueNumber: input.specIssueNumber,
    specRepositoryUrl: input.specRepositoryUrl,
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
