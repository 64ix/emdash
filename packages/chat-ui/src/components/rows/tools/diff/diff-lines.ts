/**
 * diff-lines — pure line-level diff + review-surface shaping for the diff card.
 *
 * No external dependencies. Operates on the replaced region supplied by ACP
 * (`oldText` = old_string, `newText` = new_string), not on whole-file content.
 *
 * Layered public API:
 *   computeDiffRows(oldText, newText)      -- full interleaved row list, pure (no cache)
 *   countChanges(rows)                     -- adds + dels over the whole diff
 *   looksBinary(text)                      -- content-based binary heuristic (NUL byte)
 *   selectCollapsedWindow(rows, ...)       -- bounded window anchored at the first change
 *   selectExpandedWindow(rows, ...)        -- bounded window from the top of the diff
 *   formatOmittedSummary(before, after)    -- human-readable omitted-line count
 *   formatPatchText(rows)                  -- full (untruncated) unified-diff-style text
 *   resolveDiffGeometry(params)             -- which of the 5 review states applies + window
 *
 * Memoization of computeDiffRows itself is handled by the per-instance
 * ChatCaches bundle in core/caches.ts. Everything else here is cheap and
 * recomputed per render/measure call.
 */

// ── Types ─────────────────────────────────────────────────────────────────────

export type DiffRowType = 'context' | 'add' | 'remove';

export type DiffRow = {
  type: DiffRowType;
  text: string;
  /** Index into the old lines array (present on 'context' and 'remove' rows). */
  oldIdx?: number;
  /** Index into the new lines array (present on 'context' and 'add' rows). */
  newIdx?: number;
};

// ── Myers diff ────────────────────────────────────────────────────────────────

/**
 * Classic Myers shortest-edit-script over two string arrays.
 * Returns the sequence of operations to transform `a` into `b`:
 *   'keep'   — line is equal (context)
 *   'insert' — line exists in `b` only (add)
 *   'delete' — line exists in `a` only (remove)
 */
type EditOp = { op: 'keep' | 'insert' | 'delete'; aIdx: number; bIdx: number };

function myersDiff(a: string[], b: string[]): EditOp[] {
  const n = a.length;
  const m = b.length;
  const max = n + m;

  if (max === 0) return [];
  if (n === 0) return b.map((_, i) => ({ op: 'insert' as const, aIdx: 0, bIdx: i }));
  if (m === 0) return a.map((_, i) => ({ op: 'delete' as const, aIdx: i, bIdx: 0 }));

  // v[k] = furthest x reached on diagonal k
  const v: number[] = new Array(2 * max + 1).fill(0);
  // trace[d] = snapshot of v taken BEFORE computing d-step edits.
  //   trace[0] = initial (all zeros)
  //   trace[1] = state after d=0
  //   trace[d+1] = state after d
  // So during backtracking at step d, trace[d] gives us the "came-from" x values.
  const trace: number[][] = [];

  outer: for (let d = 0; d <= max; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      const ki = k + max;
      let x: number;
      // Choose whether to come from k+1 diagonal (insert) or k-1 diagonal (delete).
      if (k === -d || (k !== d && v[ki - 1]! < v[ki + 1]!)) {
        x = v[ki + 1]!; // insert: move down in b
      } else {
        x = v[ki - 1]! + 1; // delete: move right in a
      }
      let y = x - k;
      // Extend along the snake as far as equal lines allow.
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[ki] = x;
      if (x >= n && y >= m) break outer;
    }
  }

  // Backtrack to reconstruct the edit script.
  // For each d-step (d > 0): determine whether an insert or delete was taken,
  // emit the snake (context lines) from current (x,y) back to just after the edit,
  // then emit the edit and step back to the previous (x,y).
  // After the loop, emit any remaining context from d=0's snake.
  const ops: EditOp[] = [];
  let x = n;
  let y = m;

  for (let d = trace.length - 1; d > 0; d--) {
    const vd = trace[d]!;
    const k = x - y;
    const ki = k + max;

    // Was this d-step taken via an insert (came from diagonal k+1)?
    const insertStep = k === -d || (k !== d && vd[ki - 1]! < vd[ki + 1]!);
    const prevK = insertStep ? k + 1 : k - 1;
    const prevX = vd[prevK + max]!;
    const prevY = prevX - prevK;

    // The snake for this d-step starts just after the edit:
    //   insert: (prevX, prevY+1)  delete: (prevX+1, prevY)
    const snakeX = insertStep ? prevX : prevX + 1;
    const snakeY = insertStep ? prevY + 1 : prevY;

    // Emit keeps (snake) from (x,y) back to (snakeX, snakeY).
    while (x > snakeX && y > snakeY) {
      ops.push({ op: 'keep', aIdx: x - 1, bIdx: y - 1 });
      x--;
      y--;
    }

    // Emit the edit, then step back to (prevX, prevY).
    if (insertStep) {
      ops.push({ op: 'insert', aIdx: x, bIdx: y - 1 });
      y--;
    } else {
      ops.push({ op: 'delete', aIdx: x - 1, bIdx: y });
      x--;
    }
  }

  // Remaining snake from d=0 (context lines from (x,y) back to (0,0)).
  while (x > 0 && y > 0) {
    ops.push({ op: 'keep', aIdx: x - 1, bIdx: y - 1 });
    x--;
    y--;
  }

  ops.reverse();
  return ops;
}

// ── Line splitting ────────────────────────────────────────────────────────────

/**
 * Split text into lines for diffing/display.
 *
 * Normalizes CRLF to LF first: without this, every line of a CRLF-terminated
 * string carries a trailing carriage-return that survives `split('\n')`,
 * which (a) makes every line compare unequal to its LF counterpart —
 * spuriously marking a same-content CRLF file as "all changed" — and (b)
 * renders a stray control character at the end of each line. A file with no
 * trailing newline is unaffected: `split('\n')` never emits a trailing empty
 * entry unless the source text actually ends with `\n`.
 */
function toLines(text: string): string[] {
  return text.replace(/\r\n/g, '\n').split('\n');
}

// ── Public API — row computation ───────────────────────────────────────────────

/**
 * Compute a line-level diff between `oldText` and `newText`.
 *
 * When `oldText` is null (new file), every line in `newText` is an 'add' row.
 * Pure — no internal cache. Memoization lives in ChatCaches (core/caches.ts).
 */
export function computeDiffRows(oldText: string | null, newText: string): DiffRow[] {
  if (oldText === null) {
    return toLines(newText).map((text, i) => ({ type: 'add' as const, text, newIdx: i }));
  }

  const aLines = toLines(oldText);
  const bLines = toLines(newText);
  const ops = myersDiff(aLines, bLines);

  return ops.map((op) => {
    if (op.op === 'keep') {
      return {
        type: 'context' as const,
        text: aLines[op.aIdx]!,
        oldIdx: op.aIdx,
        newIdx: op.bIdx,
      };
    }
    if (op.op === 'delete') {
      return { type: 'remove' as const, text: aLines[op.aIdx]!, oldIdx: op.aIdx };
    }
    return { type: 'add' as const, text: bLines[op.bIdx]!, newIdx: op.bIdx };
  });
}

/**
 * Count the total number of additions and deletions across a full diff.
 */
export function countChanges(rows: DiffRow[]): { adds: number; dels: number } {
  let adds = 0;
  let dels = 0;
  for (const row of rows) {
    if (row.type === 'add') adds++;
    else if (row.type === 'remove') dels++;
  }
  return { adds, dels };
}

/** A NUL byte, expressed via fromCharCode so no literal control character sits in this source file. */
const NUL = String.fromCharCode(0);

/**
 * Content-based binary heuristic: a NUL byte never appears in well-formed
 * text but is common in binary payloads that end up smuggled into a text
 * field. ACP edit tool calls always carry text, so this is a defensive
 * backstop rather than a common case — but when it fires, running the line
 * diff would be meaningless (or, for large payloads, expensive) so the diff
 * card should show a distinct "binary/unsupported" state instead.
 */
export function looksBinary(text: string): boolean {
  return text.includes(NUL);
}

// ── Public API — window selection ──────────────────────────────────────────────

export type DiffWindow = {
  /** Rows to render for this window (a contiguous slice of the full row list). */
  rows: DiffRow[];
  /** Number of rows omitted before `rows[0]`. */
  omittedBefore: number;
  /** Number of rows omitted after `rows.at(-1)`. */
  omittedAfter: number;
};

/**
 * Collapsed-state window: bounded, anchored around the first changed line
 * with `context` leading context rows, so the preview opens on the
 * interesting part of the diff rather than its (possibly irrelevant) start.
 *
 * Returns an empty window when there are no changes at all (caller should
 * treat that as the "no changes to preview" / empty state, not a truncated one).
 */
export function selectCollapsedWindow(
  rows: DiffRow[],
  maxLines: number,
  context: number
): DiffWindow {
  const firstChange = rows.findIndex((r) => r.type !== 'context');
  if (firstChange === -1) return { rows: [], omittedBefore: 0, omittedAfter: 0 };
  const start = Math.max(0, firstChange - context);
  const end = Math.min(rows.length, start + maxLines);
  return { rows: rows.slice(start, end), omittedBefore: start, omittedAfter: rows.length - end };
}

/**
 * Expanded-state window: reads top-to-bottom from the start of the diff (not
 * anchored on the first change) so an expanded review reads like a normal
 * diff, not a "jump to change" preview. Still capped at `maxLines` — an
 * explicit, discoverable safety net so a pathological edit spanning
 * thousands of lines never renders an unbounded DOM. Realistic diffs sit far
 * under the cap and come back with `omittedAfter === 0` (nothing hidden).
 */
export function selectExpandedWindow(rows: DiffRow[], maxLines: number): DiffWindow {
  const end = Math.min(rows.length, maxLines);
  return { rows: rows.slice(0, end), omittedBefore: 0, omittedAfter: rows.length - end };
}

/** Human-readable summary of hidden lines, or null when nothing is hidden. */
export function formatOmittedSummary(omittedBefore: number, omittedAfter: number): string | null {
  const total = omittedBefore + omittedAfter;
  if (total <= 0) return null;
  return `${total} line${total === 1 ? '' : 's'} hidden`;
}

/**
 * Render the FULL (untruncated) row list as unified-diff-style text, prefixing
 * added/removed/context lines with `+`/`-`/` ` respectively.
 *
 * Deliberately operates on the complete row list, never a truncated preview
 * window — "Copy" must always return the intended patch content regardless of
 * how much of it the collapsed/expanded preview currently renders.
 */
export function formatPatchText(rows: DiffRow[]): string {
  return rows
    .map((row) => {
      const prefix = row.type === 'add' ? '+' : row.type === 'remove' ? '-' : ' ';
      return `${prefix}${row.text}`;
    })
    .join('\n');
}

// ── Public API — review-state resolution ───────────────────────────────────────

export type DiffGeometry =
  /** Running, no content streamed in yet — header-only shimmer. */
  | { kind: 'loading' }
  /** Running, content is arriving — bounded preview, no interactive footer. */
  | { kind: 'streaming'; window: DiffWindow }
  /** Settled, content looks binary/unsupported — no line diff is rendered. */
  | { kind: 'binary' }
  /** Settled, no line-level changes (identical content, mode-only, etc). */
  | { kind: 'empty' }
  /** Settled, normal reviewable diff. */
  | { kind: 'content'; window: DiffWindow; expanded: boolean };

export type DiffGeometryParams = {
  isRunning: boolean;
  oldText: string | null;
  newText: string;
  /** Full row list — typically the cached result of computeDiffRows. */
  rows: DiffRow[];
  /** Current expand/collapse state (ctx.expanded(item.id) / viewState.isCollapsed(item.id)). */
  expanded: boolean;
  collapsedMaxLines: number;
  collapsedContext: number;
  expandedRowCap: number;
};

/**
 * Resolve which of the five diff-card review states applies, and (for the
 * states with a body) which row window to render. The single source of truth
 * for "loading vs streaming vs binary vs empty vs content" so measure() and
 * Render() can never disagree about which state they're in.
 */
export function resolveDiffGeometry(params: DiffGeometryParams): DiffGeometry {
  const {
    isRunning,
    oldText,
    newText,
    rows,
    expanded,
    collapsedMaxLines,
    collapsedContext,
    expandedRowCap,
  } = params;

  if (isRunning && newText.length === 0) return { kind: 'loading' };
  if (isRunning) {
    return {
      kind: 'streaming',
      window: selectCollapsedWindow(rows, collapsedMaxLines, collapsedContext),
    };
  }
  if (looksBinary(oldText ?? '') || looksBinary(newText)) return { kind: 'binary' };

  const { adds, dels } = countChanges(rows);
  if (adds === 0 && dels === 0) return { kind: 'empty' };

  const window = expanded
    ? selectExpandedWindow(rows, expandedRowCap)
    : selectCollapsedWindow(rows, collapsedMaxLines, collapsedContext);
  return { kind: 'content', window, expanded };
}
