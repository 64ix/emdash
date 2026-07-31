/**
 * Matches a whole `Emdash-Task: <task-id>` line (see docs/agents/issue-tracker.md
 * "Task Marker"). The id must be a single non-whitespace token so a marker
 * embedded mid-sentence never matches.
 */
const MARKER_LINE_RE = /^Emdash-Task:[ \t]*(\S+)[ \t]*$/gm;

/**
 * Parses the `Emdash-Task: <task-id>` marker line from an issue body. Agents
 * append it as the final body line when publishing a Spec or Map issue for
 * the task they're running in (see docs/agents/issue-tracker.md).
 *
 * Returns null when no marker line is present. When more than one marker
 * line is present (e.g. the body was edited), the last one wins. This parser
 * only validates marker *syntax* — whether the extracted id names a real task
 * is a lookup the caller performs; an id that doesn't resolve is ignored
 * safely, not treated as a parse error.
 */
export function parseEmdashTaskMarker(body: string | null | undefined): string | null {
  if (!body) return null;

  let match: RegExpExecArray | null;
  let lastId: string | null = null;
  const re = new RegExp(MARKER_LINE_RE.source, MARKER_LINE_RE.flags);
  while ((match = re.exec(body)) !== null) {
    lastId = match[1] ?? null;
  }

  return lastId;
}
