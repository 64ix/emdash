/**
 * Unit tests for the load-older scroll-anchor decision helpers.
 *
 * These helpers are pure and have no DOM dependencies, so they run in the
 * `node` Vitest project without any special environment setup.
 */

import { describe, expect, it } from 'vitest';
import { captureLoadOlderAnchor, resolveLoadOlderAnchor } from './load-older-anchor';
import type { ItemIdLookup } from './load-older-anchor';

// ── Fixtures ──────────────────────────────────────────────────────────────────

/** Build a fixed-height units + geometry pair: every unit is `height` px tall. */
function buildFixedHeightFixture(itemIds: readonly string[], height: number) {
  const units: ItemIdLookup = {
    length: itemIds.length,
    at(i) {
      if (i < 0 || i >= itemIds.length) return undefined;
      return { itemId: itemIds[i] };
    },
  };
  const geometry = {
    top: (index: number) => index * height,
    findIndex: (offset: number) =>
      Math.min(itemIds.length - 1, Math.max(0, Math.floor(offset / height))),
  };
  return { units, geometry };
}

// ── captureLoadOlderAnchor ────────────────────────────────────────────────────

describe('captureLoadOlderAnchor', () => {
  it('anchors to the unit under scrollTop and records the sub-row offset', () => {
    const { units, geometry } = buildFixedHeightFixture(['a', 'b', 'c', 'd'], 100);
    // scrollTop 250 -> row 2 ('c'), 50px into that row.
    const anchor = captureLoadOlderAnchor(250, 0, units, geometry);
    expect(anchor).toEqual({ itemId: 'c', offset: 50 });
  });

  it('accounts for padTop when locating the anchor row', () => {
    const { units, geometry } = buildFixedHeightFixture(['a', 'b', 'c'], 100);
    // With a 20px pinned header, content-relative offset is scrollTop - padTop
    // (100 - 20 = 80, still row 0 — without the padTop adjustment this would
    // wrongly resolve to row 1).
    const anchor = captureLoadOlderAnchor(100, 20, units, geometry);
    expect(anchor).toEqual({ itemId: 'a', offset: 80 });
  });

  it('clamps negative content offsets to the first row', () => {
    const { units, geometry } = buildFixedHeightFixture(['a', 'b'], 100);
    // scrollTop below padTop would be negative; Math.max(0, ...) clamps to row 0.
    const anchor = captureLoadOlderAnchor(0, 50, units, geometry);
    expect(anchor).toEqual({ itemId: 'a', offset: 0 - (0 + 50) });
  });

  it('returns undefined for an empty transcript', () => {
    const { units, geometry } = buildFixedHeightFixture([], 100);
    expect(captureLoadOlderAnchor(0, 0, units, geometry)).toBeUndefined();
  });
});

// ── resolveLoadOlderAnchor ────────────────────────────────────────────────────

describe('resolveLoadOlderAnchor', () => {
  it('recomputes scrollTop after older units shift the anchored item to a higher index', () => {
    // Before prepend: anchor captured at itemId 'c' (index 2), offset 50.
    const before = buildFixedHeightFixture(['a', 'b', 'c', 'd'], 100);
    const anchor = captureLoadOlderAnchor(250, 0, before.units, before.geometry);
    expect(anchor).toBeDefined();

    // After prepending two older units, 'c' now lives at index 4.
    const after = buildFixedHeightFixture(['x', 'y', 'a', 'b', 'c', 'd'], 100);
    const newTop = resolveLoadOlderAnchor(anchor!, 0, after.units, after.geometry);
    // 'c' is now at row 4 -> top 400, plus the original 50px sub-row offset.
    expect(newTop).toBe(450);
  });

  it('accounts for padTop when recomputing scrollTop', () => {
    const anchor = { itemId: 'a', offset: 0 };
    const after = buildFixedHeightFixture(['x', 'a'], 100);
    expect(resolveLoadOlderAnchor(anchor, 20, after.units, after.geometry)).toBe(100 + 20 + 0);
  });

  it('returns undefined when the anchored item is no longer present', () => {
    const anchor = { itemId: 'missing', offset: 0 };
    const after = buildFixedHeightFixture(['a', 'b'], 100);
    expect(resolveLoadOlderAnchor(anchor, 0, after.units, after.geometry)).toBeUndefined();
  });

  it('round-trips exactly through a realistic multi-page load', () => {
    // Simulates loading a second page of 100 older turns ahead of an
    // already-loaded 100-turn window, anchored mid-viewport.
    const initial = Array.from({ length: 100 }, (_, i) => `turn-${i}`);
    const before = buildFixedHeightFixture(initial, 40);
    const scrollTop = 40 * 3 + 12; // mid-row-3, 12px in
    const anchor = captureLoadOlderAnchor(scrollTop, 0, before.units, before.geometry);
    expect(anchor).toEqual({ itemId: 'turn-3', offset: 12 });

    const older = Array.from({ length: 100 }, (_, i) => `older-${i}`);
    const after = buildFixedHeightFixture([...older, ...initial], 40);
    const newTop = resolveLoadOlderAnchor(anchor!, 0, after.units, after.geometry);
    // 'turn-3' now sits at index 103.
    expect(newTop).toBe(40 * 103 + 12);
  });
});
