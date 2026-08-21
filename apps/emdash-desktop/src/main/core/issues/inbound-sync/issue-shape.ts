/** See docs/adr/0003-board-stages-derived-not-declared.md and CONTEXT.md ("Spec", "Map"). */
const MAP_LABEL = 'wayfinder:map';
const WAYFINDER_LABEL_PREFIX = 'wayfinder:';

/**
 * Accepted spec title prefixes (CONTEXT.md "Spec"): the canonical `[Spec]`,
 * the fork's numbered `[Spec #N]` form, and the `Spec:` variant —
 * case-insensitive on the marker word, with optional whitespace before the
 * colon (`Spec :`). The bracket forms match the full `[...]` group so
 * stripping removes the whole marker (`[Spec #120] Title` → `Title`).
 */
const SPEC_TITLE_PREFIX_PATTERN = /^\[spec(?:\]|\s[^\]]*\])|^spec\s*:/i;

/** Spec-shaped: title starts with a recognized spec prefix (`[Spec]`, `[Spec #N]`, `Spec:`). */
export function isSpecShapedIssue(title: string): boolean {
  return SPEC_TITLE_PREFIX_PATTERN.test(title.trimStart());
}

/**
 * `[Spec] Feature Board drag-and-drop` → `Feature Board drag-and-drop`: the
 * name of the task a Spec issue belongs to is the feature, not the spec.
 * Returns the title unchanged when stripping would leave nothing.
 */
export function stripSpecTitlePrefix(title: string): string {
  const trimmed = title.trim();
  if (!isSpecShapedIssue(trimmed)) return trimmed;
  const stripped = trimmed.replace(SPEC_TITLE_PREFIX_PATTERN, '').trim();
  return stripped || trimmed;
}

/** Map-shaped: labelled `wayfinder:map`. */
export function isMapShapedIssue(labels: readonly string[]): boolean {
  return labels.includes(MAP_LABEL);
}

/**
 * Labelled with any `wayfinder:*` label — broader than the `wayfinder:map`
 * Map shape. Used by the Ghost Card root-issue filter (ticket #9), which
 * excludes every Wayfinder-tracked issue, not just Map issues specifically.
 */
export function isWayfinderLabeled(labels: readonly string[]): boolean {
  return labels.some((label) => label.startsWith(WAYFINDER_LABEL_PREFIX));
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
