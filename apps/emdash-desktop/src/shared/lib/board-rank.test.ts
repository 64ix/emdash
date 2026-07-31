import { describe, expect, it } from 'vitest';
import { rankBetween } from './board-rank';

describe('rankBetween', () => {
  it('returns a value strictly between two bounds', () => {
    const a = 'a';
    const b = 'b';
    const mid = rankBetween(a, b);
    expect(mid > a).toBe(true);
    expect(mid < b).toBe(true);
  });

  it('returns a value before an upper bound when there is no lower bound', () => {
    const b = 'm';
    const rank = rankBetween(null, b);
    expect(rank < b).toBe(true);
    expect(rank.length).toBeGreaterThan(0);
  });

  it('returns a value after a lower bound when there is no upper bound', () => {
    const a = 'm';
    const rank = rankBetween(a, null);
    expect(rank > a).toBe(true);
  });

  it('returns a mid-range value when there are no bounds at all (empty column)', () => {
    const rank = rankBetween(null, null);
    expect(typeof rank).toBe('string');
    expect(rank.length).toBeGreaterThan(0);
  });

  it('handles adjacent single-character bounds by growing the key', () => {
    // '0' and '1' are adjacent in the digit alphabet — no room for a single
    // extra digit at that position, so the result must be longer.
    const rank = rankBetween('0', '1');
    expect(rank > '0').toBe(true);
    expect(rank < '1').toBe(true);
    expect(rank.length).toBeGreaterThan(1);
  });

  it('handles bounds where one is a prefix of the other', () => {
    const a = 'a';
    const b = 'aa';
    const rank = rankBetween(a, b);
    expect(rank > a).toBe(true);
    expect(rank < b).toBe(true);
  });

  it('throws when the lower bound does not sort before the upper bound', () => {
    expect(() => rankBetween('b', 'a')).toThrow();
    expect(() => rankBetween('a', 'a')).toThrow();
  });

  it('repeated insertion at the very start keeps producing smaller, valid, distinct keys', () => {
    let upper: string | null = null;
    const keys: string[] = [];
    for (let i = 0; i < 30; i++) {
      const rank = rankBetween(null, upper);
      if (upper !== null) expect(rank < upper).toBe(true);
      keys.push(rank);
      upper = rank;
    }
    // All keys must be unique and strictly decreasing in sort order.
    expect(new Set(keys).size).toBe(keys.length);
    for (let i = 1; i < keys.length; i++) {
      expect(keys[i]! < keys[i - 1]!).toBe(true);
    }
  });

  it('repeated insertion at the very end keeps producing larger, valid, distinct keys', () => {
    let lower: string | null = null;
    const keys: string[] = [];
    for (let i = 0; i < 30; i++) {
      const rank = rankBetween(lower, null);
      if (lower !== null) expect(rank > lower).toBe(true);
      keys.push(rank);
      lower = rank;
    }
    expect(new Set(keys).size).toBe(keys.length);
    for (let i = 1; i < keys.length; i++) {
      expect(keys[i]! > keys[i - 1]!).toBe(true);
    }
  });

  it('repeated insertion at the same tight point grows key length over time', () => {
    // Insert always between the same two adjacent-ish bounds, tightening the gap
    // each time. Eventually the algorithm must add characters to stay distinct.
    const lo: string | null = '0';
    let hi: string | null = '1';
    const keys: string[] = [];
    for (let i = 0; i < 20; i++) {
      const rank = rankBetween(lo, hi);
      expect(rank > (lo ?? '')).toBe(true);
      expect(rank < (hi ?? String.fromCharCode(0x10ffff))).toBe(true);
      keys.push(rank);
      hi = rank;
    }
    expect(new Set(keys).size).toBe(keys.length);
    const lengths = keys.map((k) => k.length);
    const maxLength = Math.max(...lengths);
    const minLength = Math.min(...lengths);
    expect(maxLength).toBeGreaterThan(minLength);
  });

  it('produces values in the same relative order as repeated midpoint insertion', () => {
    // Build up a list via successive midpoint inserts and confirm the final
    // rank order matches the intended logical order.
    const first = rankBetween(null, null);
    const before = rankBetween(null, first);
    const after = rankBetween(first, null);
    const betweenFirstAndAfter = rankBetween(first, after);

    const ordered = [before, first, betweenFirstAndAfter, after];
    const sorted = [...ordered].sort();
    expect(sorted).toEqual(ordered);
  });
});
