import { describe, expect, it } from 'vitest';
import type { PullRequest } from './pull-requests';
import { resolveTaskPr } from './task-pr';

const SPEC_REPO = 'https://github.com/acme/app';
const OTHER_REPO = 'https://github.com/upstream/app';

const SPEC = { identifier: '#42', url: `${SPEC_REPO}/issues/42` };

function pr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    url: `${SPEC_REPO}/pull/1`,
    provider: 'github',
    repositoryUrl: SPEC_REPO,
    baseRefName: 'main',
    baseRefOid: 'b'.repeat(40),
    headRepositoryUrl: SPEC_REPO,
    headRefName: 'feature/one',
    headRefOid: 'h'.repeat(40),
    identifier: '#1',
    title: 'PR title',
    description: null,
    status: 'open',
    isDraft: false,
    additions: null,
    deletions: null,
    changedFiles: null,
    commitCount: null,
    mergeableStatus: null,
    mergeStateStatus: null,
    reviewDecision: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    mergedAt: null,
    author: null,
    labels: [],
    assignees: [],
    checks: [],
    ...overrides,
  };
}

describe('resolveTaskPr (ticket #99)', () => {
  it('returns the assigned PR over every derived candidate', () => {
    const assigned = pr({ url: `${SPEC_REPO}/pull/9`, identifier: '#9' });
    const result = resolveTaskPr({
      assignedPr: assigned,
      prs: [pr({ status: 'open' })],
      spec: SPEC,
      taskBranch: 'feature/one',
    });

    expect(result).toBe(assigned);
  });

  it('returns the open branch-matched PR over merged or closed ones', () => {
    const open = pr({ url: `${SPEC_REPO}/pull/2`, identifier: '#2', status: 'open' });
    const merged = pr({
      url: `${SPEC_REPO}/pull/3`,
      identifier: '#3',
      status: 'merged',
      createdAt: '2026-01-02T00:00:00.000Z',
    });

    expect(resolveTaskPr({ prs: [merged, open], spec: SPEC, taskBranch: 'feature/one' })).toBe(
      open
    );
  });

  it('falls back to the most recently created branch-matched PR when none is open', () => {
    const older = pr({
      url: `${SPEC_REPO}/pull/4`,
      identifier: '#4',
      status: 'closed',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const newer = pr({
      url: `${SPEC_REPO}/pull/5`,
      identifier: '#5',
      status: 'merged',
      createdAt: '2026-01-02T00:00:00.000Z',
    });

    expect(resolveTaskPr({ prs: [older, newer], spec: SPEC, taskBranch: 'feature/one' })).toBe(
      newer
    );
  });

  it('ignores PRs on other branches when the task branch is known', () => {
    const otherBranch = pr({
      url: `${SPEC_REPO}/pull/6`,
      identifier: '#6',
      headRefName: 'jan/other-branch',
      status: 'open',
    });

    expect(
      resolveTaskPr({ prs: [otherBranch], spec: SPEC, taskBranch: 'feature/one' })
    ).toBeUndefined();
  });

  it('falls back to a Spec-referencing PR when no branch-matched PR exists', () => {
    const specPr = pr({
      url: `${SPEC_REPO}/pull/7`,
      identifier: '#7',
      headRefName: 'jan/spec-work',
      description: 'Closes #42.',
      status: 'open',
    });

    expect(resolveTaskPr({ prs: [specPr], spec: SPEC, taskBranch: 'feature/one' })).toBe(specPr);
  });

  it('falls back to a Spec-referencing PR matched by branch token', () => {
    const specPr = pr({
      url: `${SPEC_REPO}/pull/8`,
      identifier: '#8',
      headRefName: 'spec/42-board',
      description: null,
      status: 'open',
    });

    expect(resolveTaskPr({ prs: [specPr], spec: SPEC })).toBe(specPr);
  });

  it('does not let a PR from another repository answer for the Spec issue', () => {
    const upstreamPr = pr({
      url: `${OTHER_REPO}/pull/7`,
      identifier: '#7',
      repositoryUrl: OTHER_REPO,
      headRepositoryUrl: OTHER_REPO,
      headRefName: 'jan/upstream-branch',
      description: 'Closes #42.',
      status: 'open',
    });

    expect(
      resolveTaskPr({ prs: [upstreamPr], spec: SPEC, taskBranch: 'feature/one' })
    ).toBeUndefined();
  });

  it('returns undefined for a task with no assigned PR, no branch PR and no Spec', () => {
    expect(
      resolveTaskPr({
        prs: [pr({ headRefName: 'jan/other-branch', status: 'closed' })],
        taskBranch: 'feature/one',
      })
    ).toBeUndefined();
  });

  it('returns undefined when nothing matches at all', () => {
    expect(resolveTaskPr({ prs: [], spec: null })).toBeUndefined();
  });
});
