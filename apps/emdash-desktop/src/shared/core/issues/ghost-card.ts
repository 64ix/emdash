import type { LinkedIssue } from '@shared/core/linked-issue';

/**
 * A lightweight candidate card for a root GitHub issue that no task links yet
 * (not `[Spec]`-titled, not a sub-issue of anything, not labelled
 * `wayfinder:*`, carrying no Task Marker) — see CONTEXT.md ("Ghost Card") and
 * ticket #9. Not a task: adopting one creates a real task with the issue as
 * its Origin; rejecting one hides it permanently. Nothing is persisted for a
 * ghost before adoption except, on rejection, the rejection itself.
 */
export type GhostCard = {
  /** Stable id for the ghost card: the candidate issue's URL. */
  id: string;
  issue: LinkedIssue;
};
