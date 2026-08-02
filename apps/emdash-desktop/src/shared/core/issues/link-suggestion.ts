import type { LinkedIssue, LinkedIssueRole } from '@shared/core/linked-issue';

/**
 * A Spec- or Map-shaped GitHub issue with no Task Marker (or a marker that
 * points at an unknown task) and no task already linking it. Surfaced in the
 * UI as "attach to a task?" — see docs/agents/issue-tracker.md and
 * docs/adr/0003-board-stages-derived-not-declared.md.
 */
export type LinkSuggestion = {
  /** Stable id for the suggestion: the candidate issue's URL. */
  id: string;
  role: Extract<LinkedIssueRole, 'map' | 'spec'>;
  issue: LinkedIssue;
};
