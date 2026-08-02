import { describe, expect, it } from 'vitest';
import type { RemoteIssue } from './github-issues-client';
import { computeLinkSuggestions, remoteIssueToLinkedIssue } from './link-suggestions';

function makeIssue(overrides: Partial<RemoteIssue> = {}): RemoteIssue {
  return {
    number: 1,
    url: 'https://github.com/acme/repo/issues/1',
    title: '[Spec] Feature',
    body: null,
    state: 'open',
    labels: [],
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('remoteIssueToLinkedIssue', () => {
  it('maps a remote issue to the shared LinkedIssue shape', () => {
    const issue = makeIssue();
    const linked = remoteIssueToLinkedIssue(issue);
    expect(linked).toMatchObject({
      provider: 'github',
      identifier: '#1',
      title: '[Spec] Feature',
      url: issue.url,
      status: 'open',
      updatedAt: issue.updatedAt,
    });
    expect(linked.fetchedAt).toBeTruthy();
  });
});

describe('computeLinkSuggestions', () => {
  it('surfaces an open, unlinked, unmarked, undismissed candidate', () => {
    const issue = makeIssue();
    const suggestions = computeLinkSuggestions({
      candidates: [{ issue, role: 'spec', hasMarker: false }],
      linkedIssueUrls: new Set(),
      dismissedIssueUrls: new Set(),
    });
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]).toMatchObject({
      id: issue.url,
      role: 'spec',
      issue: {
        provider: 'github',
        identifier: '#1',
        title: issue.title,
        url: issue.url,
        status: 'open',
        updatedAt: issue.updatedAt,
      },
    });
    // `remoteIssueToLinkedIssue` stamps `fetchedAt` with `new Date().toISOString()`
    // at call time; asserting it exactly against a second, separately-computed
    // call (as the previous `toEqual` did) can fail on a 1ms boundary under load.
    expect(suggestions[0].issue.fetchedAt).toBeTruthy();
  });

  it('excludes a candidate with any Task Marker, even an unresolved one', () => {
    const issue = makeIssue();
    const suggestions = computeLinkSuggestions({
      candidates: [{ issue, role: 'spec', hasMarker: true }],
      linkedIssueUrls: new Set(),
      dismissedIssueUrls: new Set(),
    });
    expect(suggestions).toEqual([]);
  });

  it('excludes a closed candidate', () => {
    const issue = makeIssue({ state: 'closed' });
    const suggestions = computeLinkSuggestions({
      candidates: [{ issue, role: 'spec', hasMarker: false }],
      linkedIssueUrls: new Set(),
      dismissedIssueUrls: new Set(),
    });
    expect(suggestions).toEqual([]);
  });

  it('excludes a candidate already linked to a task', () => {
    const issue = makeIssue();
    const suggestions = computeLinkSuggestions({
      candidates: [{ issue, role: 'spec', hasMarker: false }],
      linkedIssueUrls: new Set([issue.url]),
      dismissedIssueUrls: new Set(),
    });
    expect(suggestions).toEqual([]);
  });

  it('excludes a dismissed candidate', () => {
    const issue = makeIssue();
    const suggestions = computeLinkSuggestions({
      candidates: [{ issue, role: 'spec', hasMarker: false }],
      linkedIssueUrls: new Set(),
      dismissedIssueUrls: new Set([issue.url]),
    });
    expect(suggestions).toEqual([]);
  });
});
