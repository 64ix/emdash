import type { TranscriptItem, TranscriptTurn, ToolNode } from '@emdash/core/acp/client';
import type { GitChange, GitChangeStatus } from '@emdash/core/git';
import { normalizeFileTreePath } from '@renderer/features/tasks/file-tree/tree-utils';
import { relativeToWorkspace } from '@renderer/features/tasks/stores/workspace-path';

/**
 * Task-scoped Changes footprint — a pure projection, not duplicate state.
 *
 * Derives the set of files a task's ACP conversation has edited or read from
 * the *canonical* transcript (both already-committed/persisted turns and the
 * in-flight active turn) plus the task's current Git working-tree status.
 * Nothing here is stored; callers recompute on every relevant change (new
 * transcript turn, older-history page, or a fresh Git snapshot) and diff the
 * result against what is already rendered.
 *
 * Reconciliation rules:
 *  - A path is "edited" if any create/modify/delete tool call ever touched it
 *    (across every loaded turn, active or persisted) OR the task's current
 *    Git status reports it as changed. Edited always wins over read, even if
 *    the file was read again afterward — reading a file back to verify an
 *    edit does not demote it.
 *  - A path is "read" only when it was never edited and never appears in the
 *    current Git status.
 *  - When both a transcript classification and a Git status exist for the
 *    same path, the Git status is authoritative for `status`/`additions`/
 *    `deletions` (it reflects what is actually different on disk right now),
 *    but transcript provenance (turn/item id) is preserved when available so
 *    a future "jump to transcript" action (see ticket #35) has somewhere to
 *    point.
 *  - Within the transcript, the *last* event touching a path wins for that
 *    path's provenance/classification — turns are processed in ascending
 *    `seq` order (regardless of the order the caller passes them in, so a
 *    prepended older-history page never reorders the outcome), and the
 *    active turn — always the most recent — is processed last.
 */

// ── Public types ────────────────────────────────────────────────────────────

export type ChangesFootprintEntryKind = 'edited' | 'read';

/** Points back at the most recent transcript item that touched a path. */
export interface ChangesFootprintProvenance {
  readonly turnId: string;
  readonly itemId: string;
}

export interface EditedChangesFootprintEntry {
  readonly kind: 'edited';
  readonly path: string;
  readonly status: GitChangeStatus;
  readonly additions: number;
  readonly deletions: number;
  readonly source: ChangesFootprintProvenance | null;
}

export interface ReadChangesFootprintEntry {
  readonly kind: 'read';
  readonly path: string;
  readonly source: ChangesFootprintProvenance | null;
}

export type ChangesFootprintEntry = EditedChangesFootprintEntry | ReadChangesFootprintEntry;

export interface ChangesFootprint {
  readonly edited: readonly EditedChangesFootprintEntry[];
  readonly read: readonly ReadChangesFootprintEntry[];
}

export interface ChangesFootprintInput {
  /** All committed/persisted turns currently loaded (any order — sorted internally by `seq`). */
  committedTurns: readonly TranscriptTurn[];
  /** The in-flight streaming turn, if any. Always treated as the most recent turn. */
  activeTurn?: TranscriptTurn | null;
  /** The task's current Git working-tree changes (already deduplicated per path by the caller). */
  gitChanges?: readonly GitChange[];
  /** Workspace root used to relativize absolute paths reported by providers or Git. */
  workspacePath?: string | null;
}

export const EMPTY_CHANGES_FOOTPRINT: ChangesFootprint = { edited: [], read: [] };

// ── Implementation ────────────────────────────────────────────────────────────

type EditKind = 'created' | 'modified' | 'deleted';

type FileEvent = { kind: 'read' | EditKind; path: string };

const FILE_TOOL_KINDS = new Set([
  'read-tool-call',
  'create-file-tool-call',
  'modify-file-tool-call',
  'delete-file-tool-call',
]);

function fileEvent(node: ToolNode): FileEvent | null {
  switch (node.kind) {
    case 'read-tool-call':
      return node.path ? { kind: 'read', path: node.path } : null;
    case 'create-file-tool-call':
      return { kind: 'created', path: node.path };
    case 'modify-file-tool-call':
      return { kind: 'modified', path: node.path };
    case 'delete-file-tool-call':
      return { kind: 'deleted', path: node.path };
    default:
      return null;
  }
}

function childrenOf(node: TranscriptItem | ToolNode): readonly ToolNode[] {
  if (node.kind === 'tool-group') return node.children;
  if (node.kind === 'message' || node.kind === 'thinking') return [];
  return node.children ?? [];
}

/** Recursively visits every tool-call node (including nested/grouped children) in seq order. */
function walkFileEvents(
  nodes: readonly (TranscriptItem | ToolNode)[],
  visit: (node: ToolNode) => void
): void {
  for (const node of nodes) {
    if (FILE_TOOL_KINDS.has(node.kind)) visit(node as ToolNode);
    const children = childrenOf(node);
    if (children.length > 0) walkFileEvents(children, visit);
  }
}

function statusForEditKind(kind: EditKind): GitChangeStatus {
  switch (kind) {
    case 'created':
      return 'added';
    case 'modified':
      return 'modified';
    case 'deleted':
      return 'deleted';
  }
}

function normalizePath(rawPath: string, workspacePath: string | null | undefined): string {
  const relative = workspacePath ? relativeToWorkspace(workspacePath, rawPath) : rawPath;
  return normalizeFileTreePath(relative);
}

export function buildChangesFootprint({
  committedTurns,
  activeTurn = null,
  gitChanges = [],
  workspacePath = null,
}: ChangesFootprintInput): ChangesFootprint {
  const editEvents = new Map<string, { changeKind: EditKind; turnId: string; itemId: string }>();
  const readEvents = new Map<string, ChangesFootprintProvenance>();

  const orderedTurns = [...committedTurns].sort((a, b) => a.seq - b.seq);
  if (activeTurn) orderedTurns.push(activeTurn);

  for (const turn of orderedTurns) {
    walkFileEvents(turn.items, (node) => {
      const event = fileEvent(node);
      if (!event) return;
      const path = normalizePath(event.path, workspacePath);
      if (event.kind === 'read') {
        readEvents.set(path, { turnId: turn.id, itemId: node.id });
      } else {
        editEvents.set(path, { changeKind: event.kind, turnId: turn.id, itemId: node.id });
      }
    });
  }

  const gitByPath = new Map<
    string,
    { status: GitChangeStatus; additions: number; deletions: number }
  >();
  for (const change of gitChanges) {
    const path = normalizePath(change.path, workspacePath);
    gitByPath.set(path, {
      status: change.status,
      additions: change.additions,
      deletions: change.deletions,
    });
  }

  const editedPaths = new Set<string>([...editEvents.keys(), ...gitByPath.keys()]);

  const edited: EditedChangesFootprintEntry[] = [...editedPaths].map((path) => {
    const gitEntry = gitByPath.get(path);
    const editEntry = editEvents.get(path);
    const readEntry = readEvents.get(path);
    // Invariant: every path in `editedPaths` came from `editEvents` and/or
    // `gitByPath`, so when `gitEntry` is absent `editEntry` must be present —
    // the 'modified' fallback only guards against that invariant ever
    // silently breaking, it is not expected to be observed.
    const status =
      gitEntry?.status ?? (editEntry ? statusForEditKind(editEntry.changeKind) : 'modified');
    const source = editEntry
      ? { turnId: editEntry.turnId, itemId: editEntry.itemId }
      : (readEntry ?? null);
    return {
      kind: 'edited' as const,
      path,
      status,
      additions: gitEntry?.additions ?? 0,
      deletions: gitEntry?.deletions ?? 0,
      source,
    };
  });

  const read: ReadChangesFootprintEntry[] = [...readEvents.entries()]
    .filter(([path]) => !editedPaths.has(path))
    .map(([path, source]) => ({ kind: 'read' as const, path, source }));

  edited.sort((a, b) => a.path.localeCompare(b.path));
  read.sort((a, b) => a.path.localeCompare(b.path));

  return { edited, read };
}
