import { describe, expect, it } from 'vitest';
import type { LinkedIssue, LinkedIssueRoles } from '@shared/core/linked-issue';
import type { PullRequest } from '@shared/core/pull-requests/pull-requests';
import {
  agentStateLabel,
  cardArtifactBadgeText,
  cardArtifactTitle,
  deriveCardArtifact,
  taskActivityInstant,
} from './board-card-view-model';

function makePr(overrides: Partial<PullRequest> = {}): PullRequest {
  return {
    url: 'https://github.com/acme/repo/pull/9',
    provider: 'github',
    repositoryUrl: 'https://github.com/acme/repo',
    baseRefName: 'main',
    baseRefOid: 'abc',
    headRepositoryUrl: 'https://github.com/acme/repo',
    headRefName: 'feature',
    headRefOid: 'def',
    identifier: '#9',
    title: 'Ship the feature',
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

function makeIssue(overrides: Partial<LinkedIssue> = {}): LinkedIssue {
  return {
    provider: 'github',
    url: 'https://github.com/acme/repo/issues/3',
    title: 'Spec issue',
    identifier: '#3',
    ...overrides,
  };
}

describe('deriveCardArtifact', () => {
  it('returns null for a purely local task with no PRs and no linked issues', () => {
    expect(deriveCardArtifact({})).toBeNull();
    expect(deriveCardArtifact({ prs: [], linkedIssues: null })).toBeNull();
  });

  it('prefers the current PR over a linked issue when both exist', () => {
    const pr = makePr();
    const linkedIssues: LinkedIssueRoles = { version: '1', spec: makeIssue() };
    const artifact = deriveCardArtifact({ prs: [pr], linkedIssues });
    expect(artifact).toEqual({ kind: 'pr', pr });
  });

  it('falls back to the most-advanced linked issue when there is no PR', () => {
    const linkedIssues: LinkedIssueRoles = {
      version: '1',
      origin: makeIssue({ url: 'https://github.com/acme/repo/issues/1', identifier: '#1' }),
      spec: makeIssue(),
    };
    const artifact = deriveCardArtifact({ prs: [], linkedIssues });
    expect(artifact).toEqual({ kind: 'linked-issue', role: 'spec', issue: linkedIssues.spec });
  });

  it('tolerates missing prs/linkedIssues fields entirely (defensive against partial task data)', () => {
    expect(deriveCardArtifact({ prs: undefined, linkedIssues: undefined })).toBeNull();
  });
});

describe('cardArtifactBadgeText / cardArtifactTitle', () => {
  it('renders a PR artifact as "PR <identifier>"', () => {
    const pr = makePr({ identifier: '#9', title: 'Ship the feature' });
    const artifact = { kind: 'pr' as const, pr };
    expect(cardArtifactBadgeText(artifact)).toBe('PR #9');
    expect(cardArtifactTitle(artifact)).toBe('Ship the feature');
  });

  it('falls back to the PR title when it has no identifier', () => {
    const pr = makePr({ identifier: null, title: 'Untitled PR' });
    expect(cardArtifactBadgeText({ kind: 'pr', pr })).toBe('Untitled PR');
  });

  it('renders a linked-issue artifact as "<role label> <identifier>"', () => {
    const issue = makeIssue({ identifier: '#3', title: 'Spec issue' });
    const artifact = { kind: 'linked-issue' as const, role: 'spec' as const, issue };
    expect(cardArtifactBadgeText(artifact)).toBe('Spec #3');
    expect(cardArtifactTitle(artifact)).toBe('Spec issue');
  });

  it('falls back to just the role label when the issue has no display identifier', () => {
    const issue = makeIssue({ identifier: '', displayIdentifier: null });
    expect(cardArtifactBadgeText({ kind: 'linked-issue', role: 'map', issue })).toBe('Map');
  });
});

describe('taskActivityInstant', () => {
  it('prefers the last-interacted instant when set', () => {
    expect(
      taskActivityInstant({
        updatedAt: '2026-01-01T00:00:00.000Z',
        lastInteractedAt: '2026-01-02T00:00:00.000Z',
      })
    ).toBe('2026-01-02T00:00:00.000Z');
  });

  it('falls back to updatedAt when never interacted with', () => {
    expect(taskActivityInstant({ updatedAt: '2026-01-01T00:00:00.000Z' })).toBe(
      '2026-01-01T00:00:00.000Z'
    );
  });
});

describe('agentStateLabel', () => {
  it('distinguishes all five agent states', () => {
    expect(agentStateLabel('working')).toBe('Working');
    expect(agentStateLabel('awaiting-input')).toBe('Awaiting input');
    expect(agentStateLabel('error')).toBe('Error');
    expect(agentStateLabel('completed')).toBe('Completed');
    expect(agentStateLabel('idle')).toBe('Idle');
  });

  it('maps the no-status case (null) to Idle, the same as the literal "idle" string', () => {
    expect(agentStateLabel(null)).toBe('Idle');
    expect(agentStateLabel(null)).toBe(agentStateLabel('idle'));
  });
});
