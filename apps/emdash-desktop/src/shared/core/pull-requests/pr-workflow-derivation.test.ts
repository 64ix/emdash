import { describe, expect, it } from 'vitest';
import {
  derivePrStage,
  findSpecMatchingPrs,
  isShippedFaded,
  parseIssueNumberFromIdentifier,
  SHIPPED_FADE_WINDOW_MS,
  type PrWorkflowFact,
} from './pr-workflow-derivation';

function pr(overrides: Partial<PrWorkflowFact> = {}): PrWorkflowFact {
  return {
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
