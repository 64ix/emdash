import { parseEmdashTaskMarker } from './issue-marker';
import { isSpecShapedIssue, isWayfinderLabeled } from './issue-shape';

/**
 * Ghost Card root-issue shape filter (ticket #9, CONTEXT.md "Ghost Card"):
 * true when an issue is eligible to surface as a Ghost Card by its *shape*
 * alone — not `[Spec]`-titled, not labelled `wayfinder:*`, and carrying no
 * `Emdash-Task:` marker (a marker means the issue is already claimed by a
 * task, even one this sync pass doesn't recognize — see
 * `parseEmdashTaskMarker`).
 *
 * Two more exclusions from the ticket's root-issue filter — "not a sub-issue
 * of anything" and "referenced by no task" — depend on data this pure filter
 * doesn't have (a GitHub API call, and the project's existing Linked Issue
 * Roles) and are applied by `IssuesSyncEngine` around this filter instead.
 */
export function isRootIssueCandidate(issue: {
  title: string;
  labels: readonly string[];
  body: string | null;
}): boolean {
  if (isSpecShapedIssue(issue.title)) return false;
  if (isWayfinderLabeled(issue.labels)) return false;
  if (parseEmdashTaskMarker(issue.body) !== null) return false;
  return true;
}
