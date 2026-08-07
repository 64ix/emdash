import { describe, expect, it } from 'vitest';
import {
  derivePrStage,
  deriveTaskStageAuthorityFact,
  findSpecMatchingPrs,
  isShippedFaded,
  parseIssueNumberFromIdentifier,
  SHIPPED_FADE_WINDOW_MS,
  type PrWorkflowFact,
} from './pr-workflow-derivation';

/** The repository a Spec issue lives in, and a second one whose PRs are synced alongside it. */
const SPEC_REPO = 'https://github.com/acme/app';
const OTHER_REPO = 'https://github.com/upstream/app';

function pr(overrides: Partial<PrWorkflowFact> = {}): PrWorkflowFact {
  return {
    repositoryUrl: SPEC_REPO,
    headRefName: 'feature/default',
    status: 'open',
    description: null,
    ...overrides,
  };
}

describe('parseIssueNumberFromIdentifier', () => {
  it('parses a github-style identifier with a leading hash', () => {
    expect(parseIssueNumberFromIdentifier('#42')).toBe(42);
  });

  it('parses a bare numeric identifier', () => {
    expect(parseIssueNumberFromIdentifier('42')).toBe(42);
  });

  it('returns null for missing or non-numeric identifiers', () => {
    expect(parseIssueNumberFromIdentifier(null)).toBeNull();
    expect(parseIssueNumberFromIdentifier(undefined)).toBeNull();
    expect(parseIssueNumberFromIdentifier('')).toBeNull();
    expect(parseIssueNumberFromIdentifier('SUP-42')).toBeNull();
  });
});

describe('findSpecMatchingPrs', () => {
  it('matches a PR whose body references the spec issue number', () => {
    const prs = [pr({ headRefName: 'jan/some-branch', description: 'Closes #42.' })];
    expect(findSpecMatchingPrs(prs, { specIssueNumber: 42 })).toEqual(prs);
  });

  it('matches a PR whose branch references the spec issue number', () => {
    const prs = [pr({ headRefName: 'spec/42-board-sync', description: null })];
    expect(findSpecMatchingPrs(prs, { specIssueNumber: 42 })).toEqual(prs);
  });

  it('does not match a longer number containing the spec issue number as a substring', () => {
    const prs = [pr({ headRefName: 'feature/420-unrelated', description: 'Part of #420' })];
    expect(findSpecMatchingPrs(prs, { specIssueNumber: 42 })).toEqual([]);
  });

  it('falls back to the task branch match when no PR references the spec number', () => {
    const matching = pr({ headRefName: 'task/my-branch', description: null });
    const other = pr({ headRefName: 'task/other-branch', description: null });
    expect(
      findSpecMatchingPrs([other, matching], { specIssueNumber: 42, taskBranch: 'task/my-branch' })
    ).toEqual([matching]);
  });

  it('prefers the primary spec match over the branch fallback when both exist', () => {
    const bySpec = pr({ headRefName: 'other-branch', description: 'Closes #42' });
    const byBranchOnly = pr({ headRefName: 'task/my-branch', description: null, status: 'closed' });
    expect(
      findSpecMatchingPrs([byBranchOnly, bySpec], {
        specIssueNumber: 42,
        taskBranch: 'task/my-branch',
      })
    ).toEqual([bySpec]);
  });

  it('returns no matches when there is neither a spec number nor a task branch', () => {
    expect(findSpecMatchingPrs([pr()], { specIssueNumber: null })).toEqual([]);
  });

  it('matches a repository-qualified reference to the spec issue', () => {
    const prs = [pr({ description: 'Part of acme/app#42.' })];
    expect(findSpecMatchingPrs(prs, { specIssueNumber: 42 })).toEqual(prs);
  });

  it('matches a body that references the spec issue by its full URL', () => {
    const prs = [pr({ description: 'Spec: https://github.com/acme/app/issues/42' })];
    expect(findSpecMatchingPrs(prs, { specIssueNumber: 42 })).toEqual(prs);
  });

  it('does not match a longer issue number in a URL reference', () => {
    const prs = [pr({ description: 'See https://github.com/acme/app/issues/420' })];
    expect(findSpecMatchingPrs(prs, { specIssueNumber: 42 })).toEqual([]);
  });

  // Regression: a merged PR quoting the commit `66de91d76` in its body proved
  // `shipped` for the open Spec #66, because the digits sat between a backtick
  // and a `d` — the old predicate needed no `#` sigil at all.
  it('does not match a commit SHA that merely starts with the spec issue number', () => {
    const prs = [
      pr({
        status: 'merged',
        headRefName: 'spec/18-acp-chat',
        description: '- `66de91d76` — consumers now import from the source module.',
      }),
    ];
    expect(findSpecMatchingPrs(prs, { specIssueNumber: 66 })).toEqual([]);
  });

  it('does not match the spec issue number buried in a URL slug', () => {
    const prs = [
      pr({ description: 'Report: https://gist.github.com/x/2a66ec12763630b06e1e696974338ca7' }),
    ];
    expect(findSpecMatchingPrs(prs, { specIssueNumber: 66 })).toEqual([]);
  });

  it('does not match plain prose that happens to contain the number', () => {
    const prs = [pr({ description: 'Cuts the bundle by 66 KB and touches 66 files.' })];
    expect(findSpecMatchingPrs(prs, { specIssueNumber: 66 })).toEqual([]);
  });

  it('ignores a PR from another repository referencing the same number', () => {
    const foreign = pr({ repositoryUrl: OTHER_REPO, description: 'Closes #42' });
    expect(
      findSpecMatchingPrs([foreign], { specIssueNumber: 42, specRepositoryUrl: SPEC_REPO })
    ).toEqual([]);
  });

  it('keeps matching a PR in the spec issue own repository when scoped', () => {
    const own = pr({ description: 'Closes #42' });
    const foreign = pr({ repositoryUrl: OTHER_REPO, description: 'Closes #42' });
    expect(
      findSpecMatchingPrs([foreign, own], { specIssueNumber: 42, specRepositoryUrl: SPEC_REPO })
    ).toEqual([own]);
  });

  it('scopes the task branch fallback to the spec issue repository too', () => {
    const foreign = pr({ repositoryUrl: OTHER_REPO, headRefName: 'main', status: 'closed' });
    expect(
      findSpecMatchingPrs([foreign], {
        specIssueNumber: 42,
        specRepositoryUrl: SPEC_REPO,
        taskBranch: 'main',
      })
    ).toEqual([]);
  });

  it('stays unscoped when the spec issue repository is unknown', () => {
    const foreign = pr({ repositoryUrl: OTHER_REPO, description: 'Closes #42' });
    expect(findSpecMatchingPrs([foreign], { specIssueNumber: 42 })).toEqual([foreign]);
    expect(
      findSpecMatchingPrs([foreign], { specIssueNumber: 42, specRepositoryUrl: null })
    ).toEqual([foreign]);
  });

  // The end-to-end shape of the reported bug: an open Spec, no PR referencing it,
  // and the board must leave the card exactly where the Spec fact put it.
  it('derives no stage for an open spec whose only near-match is a SHA-quoting merged PR', () => {
    const merged = pr({
      status: 'merged',
      headRefName: 'spec/18-acp-chat',
      description: '- `66de91d76` — consumers now import from the source module.',
    });
    const foreignClosed = pr({
      repositoryUrl: OTHER_REPO,
      status: 'closed',
      description: 'Report: https://gist.github.com/x/2a66ec12763630b06e1e696974338ca7',
    });
    const matches = findSpecMatchingPrs([merged, foreignClosed], {
      specIssueNumber: 66,
      specRepositoryUrl: SPEC_REPO,
      taskBranch: 'fork-main',
    });
    expect(matches).toEqual([]);
    expect(derivePrStage(matches)).toBeNull();
  });
});

describe('derivePrStage', () => {
  it('returns null when there are no matching PRs', () => {
    expect(derivePrStage([])).toBeNull();
  });

  it('returns review when any matching PR is open', () => {
    expect(derivePrStage([pr({ status: 'closed' }), pr({ status: 'open' })])).toBe('review');
  });

  it('returns shipped when a PR merged and none are open', () => {
    expect(derivePrStage([pr({ status: 'closed' }), pr({ status: 'merged' })])).toBe('shipped');
  });

  it('returns triage when a PR closed without merge and none are open or merged', () => {
    expect(derivePrStage([pr({ status: 'closed' })])).toBe('triage');
  });

  it('prioritises open over merged over closed', () => {
    expect(
      derivePrStage([pr({ status: 'closed' }), pr({ status: 'merged' }), pr({ status: 'open' })])
    ).toBe('review');
  });
});

describe('isShippedFaded', () => {
  const now = new Date('2026-07-31T00:00:00.000Z').getTime();

  it('is not faded when never merged', () => {
    expect(isShippedFaded(null, now)).toBe(false);
    expect(isShippedFaded(undefined, now)).toBe(false);
  });

  it('is not faded just under the fade window', () => {
    const mergedAt = new Date(now - (SHIPPED_FADE_WINDOW_MS - 1000)).toISOString();
    expect(isShippedFaded(mergedAt, now)).toBe(false);
  });

  it('is faded just over the fade window', () => {
    const mergedAt = new Date(now - (SHIPPED_FADE_WINDOW_MS + 1000)).toISOString();
    expect(isShippedFaded(mergedAt, now)).toBe(true);
  });

  it('treats an unparseable mergedAt as not faded', () => {
    expect(isShippedFaded('not-a-date', now)).toBe(false);
  });
});

describe('deriveTaskStageAuthorityFact', () => {
  it('is declarative with no holding PR when the task has no Spec link', () => {
    expect(
      deriveTaskStageAuthorityFact({
        currentStage: 'idea',
        specIssueNumber: null,
        taskBranch: 'task/branch',
        prFacts: [pr({ headRefName: 'task/branch', status: 'open' })],
      })
    ).toEqual({ holdingPr: null, isCurrentStageGithubProven: false });
  });

  it('is declarative with no holding PR when no PR references the Spec at all', () => {
    expect(
      deriveTaskStageAuthorityFact({
        currentStage: 'idea',
        specIssueNumber: 42,
        taskBranch: null,
        prFacts: [pr({ headRefName: 'unrelated', description: 'Closes #99' })],
      })
    ).toEqual({ holdingPr: null, isCurrentStageGithubProven: false });
  });

  it('is github-proven with the open PR when an open PR references the Spec', () => {
    const open = pr({ headRefName: 'feature/1', status: 'open', description: 'Closes #42' });
    expect(
      deriveTaskStageAuthorityFact({
        currentStage: 'implementing',
        specIssueNumber: 42,
        taskBranch: null,
        prFacts: [open],
      })
    ).toEqual({ holdingPr: open, isCurrentStageGithubProven: true });
  });

  it('is github-proven with the merged PR when the Spec-referencing PR merged', () => {
    const merged = pr({ headRefName: 'feature/1', status: 'merged', description: 'Closes #42' });
    expect(
      deriveTaskStageAuthorityFact({
        currentStage: 'review',
        specIssueNumber: 42,
        taskBranch: null,
        prFacts: [merged],
      })
    ).toEqual({ holdingPr: merged, isCurrentStageGithubProven: true });
  });

  it('is github-proven with the closed PR when the Spec-referencing PR closed unmerged', () => {
    const closed = pr({ headRefName: 'feature/1', status: 'closed', description: 'Closes #42' });
    expect(
      deriveTaskStageAuthorityFact({
        currentStage: 'idea',
        specIssueNumber: 42,
        taskBranch: null,
        prFacts: [closed],
      })
    ).toEqual({ holdingPr: closed, isCurrentStageGithubProven: true });
  });

  it('picks the PR whose status matches the derived stage when several match', () => {
    const open = pr({ headRefName: 'feature/1', status: 'open', description: 'Closes #42' });
    const closedOther = pr({ headRefName: 'feature/2', status: 'closed', description: 'Re #42' });
    const { holdingPr } = deriveTaskStageAuthorityFact({
      currentStage: 'idea',
      specIssueNumber: 42,
      taskBranch: null,
      prFacts: [closedOther, open],
    });
    expect(holdingPr).toBe(open);
  });

  it('holds no PR when the only candidate lives in another repository', () => {
    const foreign = pr({ repositoryUrl: OTHER_REPO, status: 'merged', description: 'Closes #42' });
    expect(
      deriveTaskStageAuthorityFact({
        currentStage: 'spec',
        specIssueNumber: 42,
        specRepositoryUrl: SPEC_REPO,
        taskBranch: null,
        prFacts: [foreign],
      })
    ).toEqual({ holdingPr: null, isCurrentStageGithubProven: false });
  });

  it('is never github-proven while the task currently sits in triage, even with a holding PR', () => {
    const closed = pr({ headRefName: 'feature/1', status: 'closed', description: 'Closes #42' });
    expect(
      deriveTaskStageAuthorityFact({
        currentStage: 'triage',
        specIssueNumber: 42,
        taskBranch: null,
        prFacts: [closed],
      })
    ).toEqual({ holdingPr: closed, isCurrentStageGithubProven: false });
  });
});

describe('deriveTaskStageAuthorityFact — Assigned PR override (ticket #101)', () => {
  it('holds the assigned open PR, github-proven, when one is set', () => {
    const assigned = pr({ headRefName: 'fork-flow/branch', status: 'open', description: null });
    expect(
      deriveTaskStageAuthorityFact({
        currentStage: 'implementing',
        assignedPr: assigned,
        specIssueNumber: 42,
        taskBranch: null,
        prFacts: [],
      })
    ).toEqual({ holdingPr: assigned, isCurrentStageGithubProven: true });
  });

  it('holds the assigned merged PR when one is set', () => {
    const assigned = pr({ headRefName: 'fork-flow/branch', status: 'merged', description: null });
    expect(
      deriveTaskStageAuthorityFact({
        currentStage: 'review',
        assignedPr: assigned,
        specIssueNumber: 42,
        taskBranch: null,
        prFacts: [],
      })
    ).toEqual({ holdingPr: assigned, isCurrentStageGithubProven: true });
  });

  it('holds the assigned closed-without-merge PR', () => {
    const assigned = pr({ headRefName: 'fork-flow/branch', status: 'closed', description: null });
    expect(
      deriveTaskStageAuthorityFact({
        currentStage: 'idea',
        assignedPr: assigned,
        specIssueNumber: 42,
        taskBranch: null,
        prFacts: [],
      })
    ).toEqual({ holdingPr: assigned, isCurrentStageGithubProven: true });
  });

  it('is never github-proven while the task sits in triage, even for an assigned PR', () => {
    const assigned = pr({ headRefName: 'fork-flow/branch', status: 'open', description: null });
    expect(
      deriveTaskStageAuthorityFact({
        currentStage: 'triage',
        assignedPr: assigned,
        specIssueNumber: 42,
        taskBranch: null,
        prFacts: [],
      })
    ).toEqual({ holdingPr: assigned, isCurrentStageGithubProven: false });
  });

  it('wins over a contradicting Spec-derived match', () => {
    const assigned = pr({ headRefName: 'fork-flow/branch', status: 'open', description: null });
    const specMerged = pr({
      headRefName: 'feature/1',
      status: 'merged',
      description: 'Closes #42',
    });
    expect(
      deriveTaskStageAuthorityFact({
        currentStage: 'implementing',
        assignedPr: assigned,
        specIssueNumber: 42,
        taskBranch: null,
        prFacts: [specMerged],
      })
    ).toEqual({ holdingPr: assigned, isCurrentStageGithubProven: true });
  });

  it('is the holding fact even for a link-less task (no Spec link needed)', () => {
    const assigned = pr({ headRefName: 'fork-flow/branch', status: 'merged', description: null });
    expect(
      deriveTaskStageAuthorityFact({
        currentStage: 'review',
        assignedPr: assigned,
        specIssueNumber: null,
        taskBranch: null,
        prFacts: [],
      })
    ).toEqual({ holdingPr: assigned, isCurrentStageGithubProven: true });
  });

  it('reverts to the Spec-derived authority when unassigned', () => {
    const specOpen = pr({ headRefName: 'feature/1', status: 'open', description: 'Closes #42' });
    expect(
      deriveTaskStageAuthorityFact({
        currentStage: 'implementing',
        assignedPr: null,
        specIssueNumber: 42,
        taskBranch: null,
        prFacts: [specOpen],
      })
    ).toEqual({ holdingPr: specOpen, isCurrentStageGithubProven: true });
  });

  it('is declarative with no holding PR when unassigned and link-less', () => {
    expect(
      deriveTaskStageAuthorityFact({
        currentStage: 'idea',
        assignedPr: undefined,
        specIssueNumber: null,
        taskBranch: 'task/branch',
        prFacts: [pr({ headRefName: 'task/branch', status: 'open' })],
      })
    ).toEqual({ holdingPr: null, isCurrentStageGithubProven: false });
  });
});
