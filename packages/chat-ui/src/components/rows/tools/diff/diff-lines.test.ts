/**
 * diff-lines.ts — unit tests.
 *
 * Covers:
 *   1. computeDiffRows(): Myers diff correctness + awkward-shape edge cases
 *      (empty files, no-newline-at-EOF, CRLF, very long lines, new files).
 *   2. countChanges(): adds/dels accounting.
 *   3. looksBinary(): NUL-byte content heuristic.
 *   4. selectCollapsedWindow() / selectExpandedWindow(): exact window/omitted
 *      counts, including the expanded-cap boundary for very large diffs.
 *   5. formatOmittedSummary() / formatPatchText(): presentation formatting.
 *   6. resolveDiffGeometry(): the single source of truth for which of the
 *      five review states applies.
 */

import { describe, expect, it } from 'vitest';
import {
  computeDiffRows,
  countChanges,
  formatOmittedSummary,
  formatPatchText,
  looksBinary,
  resolveDiffGeometry,
  selectCollapsedWindow,
  selectExpandedWindow,
  type DiffRow,
} from './diff-lines';

describe('computeDiffRows', () => {
  it('treats a null oldText as a new file — every line is an add', () => {
    expect(computeDiffRows(null, 'a\nb')).toEqual<DiffRow[]>([
      { type: 'add', text: 'a', newIdx: 0 },
      { type: 'add', text: 'b', newIdx: 1 },
    ]);
  });

  it('produces a pure context diff when nothing changed', () => {
    expect(computeDiffRows('a\nb', 'a\nb')).toEqual<DiffRow[]>([
      { type: 'context', text: 'a', oldIdx: 0, newIdx: 0 },
      { type: 'context', text: 'b', oldIdx: 1, newIdx: 1 },
    ]);
  });

  it('classifies a single-line replacement as remove+add with correct indices', () => {
    expect(computeDiffRows('a\nold\nc', 'a\nnew\nc')).toEqual<DiffRow[]>([
      { type: 'context', text: 'a', oldIdx: 0, newIdx: 0 },
      { type: 'remove', text: 'old', oldIdx: 1 },
      { type: 'add', text: 'new', newIdx: 1 },
      { type: 'context', text: 'c', oldIdx: 2, newIdx: 2 },
    ]);
  });

  it('handles two empty strings (empty file, no change)', () => {
    expect(computeDiffRows('', '')).toEqual<DiffRow[]>([
      { type: 'context', text: '', oldIdx: 0, newIdx: 0 },
    ]);
  });

  it('handles an empty new file (oldText null, newText empty)', () => {
    expect(computeDiffRows(null, '')).toEqual<DiffRow[]>([{ type: 'add', text: '', newIdx: 0 }]);
  });

  it('does not emit a trailing empty row for text with no trailing newline', () => {
    const rows = computeDiffRows('a\nb\nc', 'a\nb\nc\nd');
    expect(rows).toEqual<DiffRow[]>([
      { type: 'context', text: 'a', oldIdx: 0, newIdx: 0 },
      { type: 'context', text: 'b', oldIdx: 1, newIdx: 1 },
      { type: 'context', text: 'c', oldIdx: 2, newIdx: 2 },
      { type: 'add', text: 'd', newIdx: 3 },
    ]);
  });

  it('normalizes CRLF so a same-content CRLF file diffs as unchanged', () => {
    const rows = computeDiffRows('a\r\nb\r\nc', 'a\nb\nc');
    expect(rows.every((r) => r.type === 'context')).toBe(true);
    expect(rows.map((r) => r.text)).toEqual(['a', 'b', 'c']);
  });

  it('diffs a genuine CRLF-side change correctly', () => {
    const rows = computeDiffRows('a\r\nold\r\nc', 'a\r\nnew\r\nc');
    expect(rows).toEqual<DiffRow[]>([
      { type: 'context', text: 'a', oldIdx: 0, newIdx: 0 },
      { type: 'remove', text: 'old', oldIdx: 1 },
      { type: 'add', text: 'new', newIdx: 1 },
      { type: 'context', text: 'c', oldIdx: 2, newIdx: 2 },
    ]);
  });

  it('does not truncate a very long single line', () => {
    const longLine = 'x'.repeat(50_000);
    const rows = computeDiffRows('short', longLine);
    expect(rows).toEqual<DiffRow[]>([
      { type: 'remove', text: 'short', oldIdx: 0 },
      { type: 'add', text: longLine, newIdx: 0 },
    ]);
    expect(rows[1]!.text.length).toBe(50_000);
  });

  it('handles a rename/mode-only-style change (identical content) as a no-op diff', () => {
    const content = 'export const x = 1;\n';
    expect(computeDiffRows(content, content).every((r) => r.type === 'context')).toBe(true);
  });
});

describe('countChanges', () => {
  it('counts adds and dels across the full row list', () => {
    const rows = computeDiffRows('a\nold\nc', 'a\nnew\nc');
    expect(countChanges(rows)).toEqual({ adds: 1, dels: 1 });
  });

  it('returns zero/zero for a pure-context diff', () => {
    const rows = computeDiffRows('a\nb', 'a\nb');
    expect(countChanges(rows)).toEqual({ adds: 0, dels: 0 });
  });
});

describe('looksBinary', () => {
  it('returns false for ordinary text', () => {
    expect(looksBinary('export function f() {}\n')).toBe(false);
  });

  it('returns true when a NUL byte is present (binary content smuggled into text)', () => {
    const binaryish = `\x89PNG${String.fromCharCode(0)}\x00\x00\x00IHDR`;
    expect(looksBinary(binaryish)).toBe(true);
  });

  it('returns false for an empty string', () => {
    expect(looksBinary('')).toBe(false);
  });
});

describe('selectCollapsedWindow', () => {
  it('anchors on the first change with the requested leading context', () => {
    const rows: DiffRow[] = [
      { type: 'context', text: 'l1' },
      { type: 'context', text: 'l2' },
      { type: 'context', text: 'l3' },
      { type: 'remove', text: 'old' },
      { type: 'add', text: 'new' },
      { type: 'context', text: 'l6' },
    ];
    const win = selectCollapsedWindow(rows, 3, 1);
    // firstChange index = 3, context = 1 → start = 2, maxLines=3 → end = 5
    expect(win.rows.map((r) => r.text)).toEqual(['l3', 'old', 'new']);
    expect(win.omittedBefore).toBe(2);
    expect(win.omittedAfter).toBe(1);
  });

  it('returns an empty window (not an error) when there are no changes', () => {
    const rows: DiffRow[] = [
      { type: 'context', text: 'a' },
      { type: 'context', text: 'b' },
    ];
    expect(selectCollapsedWindow(rows, 8, 1)).toEqual({
      rows: [],
      omittedBefore: 0,
      omittedAfter: 0,
    });
  });

  it('reports zero omitted when the whole diff fits inside maxLines', () => {
    const rows: DiffRow[] = [
      { type: 'context', text: 'a' },
      { type: 'add', text: 'b' },
    ];
    const win = selectCollapsedWindow(rows, 8, 1);
    expect(win).toEqual({ rows, omittedBefore: 0, omittedAfter: 0 });
  });
});

describe('selectExpandedWindow', () => {
  it('returns every row untouched when under the cap', () => {
    const rows: DiffRow[] = Array.from({ length: 50 }, (_, i) => ({
      type: 'add' as const,
      text: `l${i}`,
      newIdx: i,
    }));
    const win = selectExpandedWindow(rows, 100);
    expect(win).toEqual({ rows, omittedBefore: 0, omittedAfter: 0 });
  });

  it('caps exactly at the boundary — N rows at cap N is untruncated', () => {
    const rows: DiffRow[] = Array.from({ length: 2000 }, (_, i) => ({
      type: 'add' as const,
      text: `l${i}`,
      newIdx: i,
    }));
    const win = selectExpandedWindow(rows, 2000);
    expect(win.rows.length).toBe(2000);
    expect(win.omittedAfter).toBe(0);
  });

  it('caps at the boundary — N+1 rows at cap N truncates exactly one row', () => {
    const rows: DiffRow[] = Array.from({ length: 2001 }, (_, i) => ({
      type: 'add' as const,
      text: `l${i}`,
      newIdx: i,
    }));
    const win = selectExpandedWindow(rows, 2000);
    expect(win.rows.length).toBe(2000);
    expect(win.omittedBefore).toBe(0);
    expect(win.omittedAfter).toBe(1);
    expect(win.rows.at(-1)!.text).toBe('l1999');
  });

  it('handles a diff with thousands of lines by capping, not choking', () => {
    const rows: DiffRow[] = Array.from({ length: 5000 }, (_, i) => ({
      type: i % 2 === 0 ? ('add' as const) : ('remove' as const),
      text: `l${i}`,
    }));
    const win = selectExpandedWindow(rows, 2000);
    expect(win.rows.length).toBe(2000);
    expect(win.omittedAfter).toBe(3000);
  });
});

describe('formatOmittedSummary', () => {
  it('returns null when nothing is omitted', () => {
    expect(formatOmittedSummary(0, 0)).toBeNull();
  });

  it('pluralizes correctly', () => {
    expect(formatOmittedSummary(0, 1)).toBe('1 line hidden');
    expect(formatOmittedSummary(2, 3)).toBe('5 lines hidden');
    expect(formatOmittedSummary(1, 0)).toBe('1 line hidden');
  });
});

describe('formatPatchText', () => {
  it('prefixes add/remove/context rows and always covers the full row list', () => {
    const rows = computeDiffRows('a\nold\nc', 'a\nnew\nc');
    expect(formatPatchText(rows)).toBe(' a\n-old\n+new\n c');
  });

  it('formats a pure addition (new file) with a leading +', () => {
    expect(formatPatchText(computeDiffRows(null, 'hello'))).toBe('+hello');
  });
});

describe('resolveDiffGeometry', () => {
  const baseParams = {
    expanded: false,
    collapsedMaxLines: 8,
    collapsedContext: 1,
    expandedRowCap: 2000,
  };

  it('resolves to loading while running with no content yet', () => {
    expect(
      resolveDiffGeometry({ ...baseParams, isRunning: true, oldText: null, newText: '', rows: [] })
    ).toEqual({ kind: 'loading' });
  });

  it('resolves to streaming while running with partial content', () => {
    const rows = computeDiffRows(null, 'a\nb');
    expect(
      resolveDiffGeometry({ ...baseParams, isRunning: true, oldText: null, newText: 'a\nb', rows })
    ).toEqual({
      kind: 'streaming',
      window: { rows, omittedBefore: 0, omittedAfter: 0 },
    });
  });

  it('resolves to binary when the settled content looks binary', () => {
    const newText = `bad${String.fromCharCode(0)}bytes`;
    expect(
      resolveDiffGeometry({ ...baseParams, isRunning: false, oldText: null, newText, rows: [] })
    ).toEqual({ kind: 'binary' });
  });

  it('resolves to empty when settled content has no line-level changes (mode-only/rename-style)', () => {
    const rows = computeDiffRows('same', 'same');
    expect(
      resolveDiffGeometry({
        ...baseParams,
        isRunning: false,
        oldText: 'same',
        newText: 'same',
        rows,
      })
    ).toEqual({ kind: 'empty' });
  });

  it('resolves to content with the collapsed window when settled and not expanded', () => {
    const rows = computeDiffRows('a\nold\nc', 'a\nnew\nc');
    const geometry = resolveDiffGeometry({
      ...baseParams,
      isRunning: false,
      oldText: 'a\nold\nc',
      newText: 'a\nnew\nc',
      rows,
      expanded: false,
    });
    expect(geometry).toEqual({
      kind: 'content',
      expanded: false,
      window: selectCollapsedWindow(rows, 8, 1),
    });
  });

  it('resolves to content with the expanded window when settled and expanded', () => {
    const rows = computeDiffRows('a\nold\nc', 'a\nnew\nc');
    const geometry = resolveDiffGeometry({
      ...baseParams,
      isRunning: false,
      oldText: 'a\nold\nc',
      newText: 'a\nnew\nc',
      rows,
      expanded: true,
    });
    expect(geometry).toEqual({
      kind: 'content',
      expanded: true,
      window: selectExpandedWindow(rows, 2000),
    });
  });
});
