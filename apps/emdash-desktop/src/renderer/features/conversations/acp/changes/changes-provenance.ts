import type { ChangesFootprintEntry, ChangesFootprintProvenance } from './acp-changes-footprint';

/**
 * Changes-rail provenance (ticket #35, spec #18) — the pure decisions the UI
 * needs to expose a Changes entry's "jump to transcript" affordance honestly.
 *
 * `buildChangesFootprint` (ticket #29) already resolves, per path, the *last*
 * transcript event that touched it — never the full history of every turn
 * that ever touched it (see that module's doc for the "last wins" rule).
 * Everything here just reads that single resolved `source`; it never
 * re-derives provenance from the transcript itself, so there is exactly one
 * place a reviewer needs to check for "which turn wins" semantics.
 */

export type ChangesProvenanceJumpTarget = ChangesFootprintProvenance;

/**
 * The transcript occurrence a Changes entry should jump to, or `null` when
 * there is nothing to jump to — a Git-only change (a rename, or a file
 * edited/reverted outside this conversation) never had a transcript
 * occurrence in the first place. Callers must treat `null` as "no jump
 * available" and fall back to a direct open action, never a dead link.
 */
export function changesProvenanceJumpTarget(
  entry: ChangesFootprintEntry
): ChangesProvenanceJumpTarget | null {
  return entry.source;
}

function provenanceVerb(entry: ChangesFootprintEntry): 'edit' | 'read' {
  return entry.kind === 'edited' ? 'edit' : 'read';
}

/**
 * Label for the jump affordance, or `null` when the entry has no transcript
 * provenance to jump to.
 *
 * Deliberately says "last", never "the" or "where this was" — a file can be
 * touched by several turns, and `source` only ever carries the most recent
 * one (see module doc above). Wording that implied a single, exclusive
 * origin would misrepresent files with more history than the rail shows.
 */
export function changesProvenanceLabel(entry: ChangesFootprintEntry): string | null {
  if (!entry.source) return null;
  return `Jump to last ${provenanceVerb(entry)} in transcript`;
}

/** Row tooltip: the path, plus the honest jump label when one is available. */
export function changesProvenanceTooltip(entry: ChangesFootprintEntry): string {
  const label = changesProvenanceLabel(entry);
  return label ? `${entry.path} — ${label}` : entry.path;
}
