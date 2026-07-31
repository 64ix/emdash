/**
 * Fractional indexing for manually ordered lists (the Feature Board's Board
 * Rank). Hand-rolled — no new dependency — because the fork rebases on
 * upstream and a dependency-based implementation (e.g. `fractional-indexing`)
 * would add avoidable lockfile churn. See ADR 0001.
 *
 * Ranks are base-62 strings ordered by plain JS string comparison (`<`).
 * `rankBetween(a, b)` returns a string that sorts strictly between `a` and
 * `b`, treating `null` as "no bound" (start/end of the list). Repeated
 * insertion at the same point grows the string by roughly one character at a
 * time rather than colliding.
 */

// Ascending by char code: '0'-'9' (48-57) < 'A'-'Z' (65-90) < 'a'-'z' (97-122).
// This keeps plain string comparison consistent with digit-index comparison.
const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const BASE = DIGITS.length;

function digitIndex(char: string): number {
  const index = DIGITS.indexOf(char);
  if (index === -1) throw new Error(`board-rank: invalid rank character "${char}"`);
  return index;
}

/**
 * Returns a rank string that sorts strictly between `a` and `b`.
 * `null` for `a` means "before everything"; `null` for `b` means "after everything".
 * Throws if `a` and `b` are both set and `a` does not sort strictly before `b`.
 */
export function rankBetween(a: string | null, b: string | null): string {
  if (a !== null && b !== null && a >= b) {
    throw new Error(`rankBetween: lower bound "${a}" must sort before upper bound "${b}"`);
  }

  const lo = a ?? '';
  let result = '';
  let i = 0;
  // Once we consume a position where lo's digit is exactly one below hi's digit,
  // hi no longer constrains any subsequent digit — hi is a strict prefix bound.
  let hiActive = b !== null;

  for (;;) {
    const loDigit = i < lo.length ? digitIndex(lo[i]!) : 0;
    const hiDigit = hiActive && b !== null && i < b.length ? digitIndex(b[i]!) : BASE;

    if (loDigit === hiDigit) {
      result += DIGITS[loDigit];
      i += 1;
      continue;
    }

    if (hiDigit - loDigit >= 2) {
      const mid = loDigit + Math.floor((hiDigit - loDigit) / 2);
      return result + DIGITS[mid];
    }

    // Adjacent digits, no room here — take lo's digit and go one level deeper,
    // where hi no longer applies (any continuation already sorts below hi).
    result += DIGITS[loDigit];
    i += 1;
    hiActive = false;
  }
}
