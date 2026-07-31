/** See docs/adr/0003-board-stages-derived-not-declared.md and CONTEXT.md ("Spec", "Map"). */
const SPEC_TITLE_PREFIX = '[Spec]';
const MAP_LABEL = 'wayfinder:map';

/** Spec-shaped: title starts with `[Spec]`. */
export function isSpecShapedIssue(title: string): boolean {
  return title.trimStart().startsWith(SPEC_TITLE_PREFIX);
}

/** Map-shaped: labelled `wayfinder:map`. */
export function isMapShapedIssue(labels: readonly string[]): boolean {
  return labels.includes(MAP_LABEL);
}

export type IssueShape = 'spec' | 'map' | null;

/**
 * Classifies an issue's Linked Issue Role shape. Spec takes precedence over
 * Map on the rare issue that is (incorrectly) both — Spec is the more
 * advanced role in the pipeline.
 */
export function classifyIssueShape(issue: {
  title: string;
  labels: readonly string[];
}): IssueShape {
  if (isSpecShapedIssue(issue.title)) return 'spec';
  if (isMapShapedIssue(issue.labels)) return 'map';
  return null;
}
