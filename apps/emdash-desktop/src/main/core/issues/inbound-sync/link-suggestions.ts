import type { LinkSuggestion } from '@shared/core/issues/link-suggestion';
import type { LinkedIssue } from '@shared/core/linked-issue';
import type { RemoteIssue } from './github-issues-client';

/** Converts a fetched remote issue into the shared `LinkedIssue` snapshot shape. */
export function remoteIssueToLinkedIssue(issue: RemoteIssue): LinkedIssue {
  return {
    provider: 'github',
    identifier: `#${issue.number}`,
    title: issue.title,
    url: issue.url,
    status: issue.state,
    updatedAt: issue.updatedAt,
    fetchedAt: new Date().toISOString(),
  };
}

export type SuggestionCandidate = {
  issue: RemoteIssue;
  role: 'map' | 'spec';
  /** Whether the issue body contained *any* `Emdash-Task:` marker line, valid or not. */
  hasMarker: boolean;
};

/**
 * Open Spec/Map-shaped issues with no Task Marker at all (a marker present —
 * even one pointing at an unknown task — is "ignored safely", not surfaced as
 * a suggestion) that no task links yet and that haven't been dismissed.
 */
export function computeLinkSuggestions(params: {
  candidates: SuggestionCandidate[];
  linkedIssueUrls: ReadonlySet<string>;
  dismissedIssueUrls: ReadonlySet<string>;
}): LinkSuggestion[] {
  const { candidates, linkedIssueUrls, dismissedIssueUrls } = params;
  const suggestions: LinkSuggestion[] = [];

  for (const candidate of candidates) {
    const { issue, role, hasMarker } = candidate;
    if (hasMarker) continue;
    if (issue.state !== 'open') continue;
    if (linkedIssueUrls.has(issue.url) || dismissedIssueUrls.has(issue.url)) continue;

    suggestions.push({ id: issue.url, role, issue: remoteIssueToLinkedIssue(issue) });
  }

  return suggestions;
}
