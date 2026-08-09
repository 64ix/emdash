/**
 * Test helper: tamper with the final character of a relay credential.
 *
 * Naively swapping the last char between `A` and `B` does NOT change the
 * decoded credential: the last base64url char of a 4-byte checksum encodes
 * 2 data bits plus 4 padding bits, and `A` (0) / `B` (1) differ only in
 * padding. To guarantee the tamper alters the decoded bytes, flip the high
 * bit of the char's base64url value (bit 0x20 always carries data).
 */
const B64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export function tamperLastChar(value: string): string {
  const last = value[value.length - 1];
  const index = B64URL_ALPHABET.indexOf(last);
  const replacement = B64URL_ALPHABET[(index ^ 0x20) % B64URL_ALPHABET.length];
  return value.slice(0, -1) + replacement;
}
