import { parseRepositoryRef, type RepositoryRef } from '@shared/repository-ref';

/** A GitHub issue URL, decomposed into its (normalized) repository ref and issue number. */
export type ParsedGitHubIssueUrl = {
  repository: RepositoryRef;
  number: number;
};

/**
 * Parses a GitHub (or GitHub Enterprise) issue URL of the form
 * `https://<host>/<owner>/<repo>/issues/<number>` into a normalized
 * `RepositoryRef` (the same normalization `parseRepositoryRef` applies
 * elsewhere) and issue number. Returns null for anything else (malformed
 * URL, non-issue path).
 */
export function parseGitHubIssueUrl(url: string): ParsedGitHubIssueUrl | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  const segments = parsed.pathname.split('/').filter(Boolean);
  // lastIndexOf, not indexOf: an owner or repo literally named "issues"
  // (e.g. /foo/issues/issues/42) would otherwise match the wrong segment.
  const issuesIndex = segments.lastIndexOf('issues');
  if (issuesIndex < 2) return null;

  const owner = segments[issuesIndex - 2];
  const repo = segments[issuesIndex - 1];
  const numberSegment = segments[issuesIndex + 1];
  const number = numberSegment ? Number.parseInt(numberSegment, 10) : NaN;
  if (!owner || !repo || !Number.isFinite(number)) return null;

  const repository = parseRepositoryRef(`${parsed.protocol}//${parsed.host}/${owner}/${repo}`);
  if (!repository) return null;

  return { repository, number };
}
