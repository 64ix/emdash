import { describe, expect, it } from 'vitest';
import type { ChangesFootprintEntry } from './acp-changes-footprint';
import {
  changesProvenanceJumpTarget,
  changesProvenanceLabel,
  changesProvenanceTooltip,
} from './changes-provenance';

function editedEntry(overrides: Partial<ChangesFootprintEntry> = {}): ChangesFootprintEntry {
  return {
    kind: 'edited',
    path: 'src/a.ts',
    status: 'modified',
    additions: 1,
    deletions: 0,
    source: { turnId: 'turn-1', itemId: 'item-1' },
    ...overrides,
  } as ChangesFootprintEntry;
}

function readEntry(overrides: Partial<ChangesFootprintEntry> = {}): ChangesFootprintEntry {
  return {
    kind: 'read',
    path: 'src/b.ts',
    source: { turnId: 'turn-1', itemId: 'item-2' },
    ...overrides,
  } as ChangesFootprintEntry;
}

describe('changesProvenanceJumpTarget', () => {
  it('returns the entry source unchanged when one is present', () => {
    const entry = editedEntry({ source: { turnId: 'turn-9', itemId: 'item-9' } });
    expect(changesProvenanceJumpTarget(entry)).toEqual({ turnId: 'turn-9', itemId: 'item-9' });
  });

  it('returns null for a Git-only entry with no transcript occurrence (e.g. a rename)', () => {
    const entry = editedEntry({ status: 'renamed', source: null });
    expect(changesProvenanceJumpTarget(entry)).toBeNull();
  });

  it('returns null for a Git-only entry never touched by the agent', () => {
    const entry = editedEntry({ source: null });
    expect(changesProvenanceJumpTarget(entry)).toBeNull();
  });
});

describe('changesProvenanceLabel', () => {
  it('labels an edited entry as a jump to its last edit', () => {
    expect(changesProvenanceLabel(editedEntry())).toBe('Jump to last edit in transcript');
  });

  it('labels a read entry as a jump to its last read', () => {
    expect(changesProvenanceLabel(readEntry())).toBe('Jump to last read in transcript');
  });

  it('never implies a single, exclusive origin for a file touched by several turns', () => {
    // buildChangesFootprint only ever resolves the *last* touching turn (see
    // its module doc) — the label must read as "last", not "the only" or
    // "where this was", so the UI stays honest about files with more history
    // than a single occurrence.
    const label = changesProvenanceLabel(editedEntry());
    expect(label).toContain('last');
    expect(label).not.toMatch(/\bthe\b/i);
  });

  it('returns null when there is no transcript provenance to jump to', () => {
    expect(changesProvenanceLabel(editedEntry({ source: null }))).toBeNull();
    expect(changesProvenanceLabel(readEntry({ source: null }))).toBeNull();
  });
});

describe('changesProvenanceTooltip', () => {
  it('combines the path with the jump label when provenance is available', () => {
    expect(changesProvenanceTooltip(editedEntry())).toBe(
      'src/a.ts — Jump to last edit in transcript'
    );
  });

  it('falls back to the bare path when there is nothing to jump to — never a dead link', () => {
    expect(changesProvenanceTooltip(editedEntry({ source: null }))).toBe('src/a.ts');
    expect(changesProvenanceTooltip(readEntry({ source: null }))).toBe('src/b.ts');
  });
});
