/**
 * Credential handling for the relay.
 *
 * Device tokens are random high-entropy values with a fixed positional
 * layout: `emdv1_<43 chars secret>_<6 chars checksum>`. The checksum is the
 * first 4 bytes of SHA-256 over the secret part; the relay verifies it with a
 * constant-time comparison before hashing the full credential for the store
 * lookup. Only SHA-256 digests of credentials are ever persisted (see
 * `store.ts`).
 *
 * Pairing secrets (spec #130, ticket #134) use the two-half model plus a
 * checksum:
 *
 *   `emdj1_<space_id 22>_<join_half b32 26>_<k0 b32 52>_<checksum b32 7>`
 *   (116 chars)
 *
 * - `join_half`: 16 random bytes, base32-encoded (RFC 4648, lowercase, no
 *   padding). This is the only half that ever transits to the relay, and only
 *   as SHA-256 for the join.
 * - `k0`: 32 random bytes, the space data key (AES-256-GCM, HKDF per row).
 *   The relay never stores it and never receives it — it only travels
 *   machine-to-machine inside the pasted secret.
 * - `checksum`: the first 4 bytes of SHA-256(space_id bytes ‖ join_half ‖
 *   k0), base32-encoded — the exact truncated-SHA-256 approach as the
 *   device token checksum above (`checksumOf`), so a mistyped/OCR'd
 *   character anywhere in the pasted secret is rejected by the joining
 *   client's `parseSpaceSecret` at paste time instead of surfacing later as
 *   an opaque decrypt failure.
 * - The join **credential** is the base32 join_half alone (26 chars); the
 *   relay stores only SHA-256 of that credential, and `POST /v1/join`
 *   compares the SHA-256 of the presented credential against the stored
 *   digests of the space named in the request.
 *
 * SHA-256 runs on WebCrypto (`crypto.subtle`), which is available on both the
 * Workers runtime and Node >= 18, so the exact same code paths run in
 * production and in tests.
 */

const TOKEN_PREFIX = 'emdv1_';
const JOIN_SECRET_PREFIX = 'emdj1_';

/** 32 random bytes for device tokens, 16 for the join half, 32 for K0. */
const TOKEN_SECRET_BYTES = 32;
export const JOIN_HALF_BYTES = 16;
export const K0_BYTES = 32;
const CHECKSUM_BYTES = 4;

/**
 * Base32 (RFC 4648, lowercase, no padding) character counts for the pairing
 * secret halves: 16 bytes -> 26 chars, 32 bytes -> 52 chars. The trailing
 * checksum is CHECKSUM_BYTES bytes -> 7 chars.
 */
export const JOIN_CREDENTIAL_CHARS = 26;
export const K0_B32_CHARS = 52;
export const CHECKSUM_B32_CHARS = 7;

/**
 * Full secret length: `emdj1_` + space(22) + `_` + join(26) + `_` + k0(52) +
 * `_` + checksum(7).
 */
export const SPACE_SECRET_CHARS = JOIN_SECRET_PREFIX.length + 22 + 1 + 26 + 1 + 52 + 1 + 7;

/** Space ids are 16 random bytes base64url encoded: 22 characters. */
export const SPACE_ID_CHARS = 22;

const b64urlAlphabet = /^[A-Za-z0-9_-]+$/;

const textEncoder = new TextEncoder();

export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(input));
  return bytesToHex(new Uint8Array(digest));
}

export async function sha256Bytes(input: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest('SHA-256', textEncoder.encode(input));
  return new Uint8Array(digest);
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

export function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Constant-time comparison of two byte buffers, mirroring
 * `node:crypto.timingSafeEqual` semantics. Used wherever the relay compares
 * credential-derived values (checksums, stored SHA-256 digests) so that
 * timing cannot leak information about how close an attempted credential is
 * to a real one.
 */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

export function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64urlDecode(value: string): Uint8Array | null {
  if (!b64urlAlphabet.test(value)) {
    return null;
  }
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
}

/** 16 random bytes base64url: the identifier format for spaces and devices. */
export function makeSpaceId(): string {
  return base64url(randomBytes(16));
}

export function makeDeviceId(): string {
  return base64url(randomBytes(16));
}

// ---------------------------------------------------------------------------
// Base32 (RFC 4648, lowercase, no padding) — the pairing secret halves are
// user-pasted, so they use a transcription-safe alphabet with no padding.
// ---------------------------------------------------------------------------

const B32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const b32Pattern = /^[a-z2-7]+$/;

export function base32Encode(bytes: Uint8Array): string {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += B32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return out;
}

/** Decodes lowercase base32 (uppercase input is tolerated); null on garbage. */
export function base32Decode(input: string): Uint8Array | null {
  const normalized = input.toLowerCase();
  if (normalized.length === 0) return new Uint8Array(0);
  if (!b32Pattern.test(normalized)) return null;
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of normalized) {
    value = (value << 5) | B32_ALPHABET.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(bytes);
}

async function checksumOf(bytes: Uint8Array): Promise<Uint8Array> {
  // Copy into a fresh ArrayBuffer-backed buffer: `crypto.subtle.digest`
  // requires a BufferSource and rejects SharedArrayBuffer-backed views.
  const copy = new Uint8Array(bytes);
  const digest = await crypto.subtle.digest('SHA-256', copy);
  return new Uint8Array(digest).slice(0, CHECKSUM_BYTES);
}

// ---------------------------------------------------------------------------
// Device tokens: `emdv1_<43 chars secret>_<6 chars checksum>` (56 total).
// ---------------------------------------------------------------------------

export async function makeToken(): Promise<string> {
  const secret = randomBytes(TOKEN_SECRET_BYTES);
  const checksum = await checksumOf(secret);
  return `${TOKEN_PREFIX}${base64url(secret)}_${base64url(checksum)}`;
}

export interface ParsedToken {
  ok: boolean;
}

export async function parseToken(raw: string): Promise<ParsedToken> {
  const body = raw.startsWith(TOKEN_PREFIX) ? raw.slice(TOKEN_PREFIX.length) : null;
  if (body === null || body.length !== 43 + 1 + 6) {
    return { ok: false };
  }
  const secretB64 = body.slice(0, 43);
  const checksumB64 = body.slice(44);
  const secret = base64urlDecode(secretB64);
  const checksum = base64urlDecode(checksumB64);
  if (
    secret === null ||
    secret.length !== TOKEN_SECRET_BYTES ||
    checksum === null ||
    checksum.length !== CHECKSUM_BYTES
  ) {
    return { ok: false };
  }
  const expected = await checksumOf(secret);
  if (!constantTimeEqual(expected, checksum)) {
    return { ok: false };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Pairing secrets (two-half model + checksum, spec #130 ticket #134):
// `emdj1_<space id 22>_<join half b32 26>_<k0 b32 52>_<checksum b32 7>`
// (116 total). The space id is embedded (in plaintext, like the space id
// itself) so the joining client can validate the paste; the relay only ever
// sees the join credential (the base32 join half, 26 chars) and its SHA-256
// digest. The checksum covers the whole payload (space id + join half + k0)
// so a mistyped/OCR'd character anywhere is caught by the joining client at
// parse time instead of surfacing later as a decrypt failure.
// ---------------------------------------------------------------------------

export function isSpaceId(value: string): boolean {
  return new RegExp(`^[A-Za-z0-9_-]{${SPACE_ID_CHARS}}$`).test(value);
}

/** 16 random bytes: the join half of a pairing secret. */
export function makeJoinHalf(): Uint8Array {
  return randomBytes(JOIN_HALF_BYTES);
}

/** 32 random bytes: the space data key (K0). Never stored or transmitted. */
export function makeK0(): Uint8Array {
  return randomBytes(K0_BYTES);
}

/** The join credential of a join half: base32, 26 chars. */
export function joinCredentialOf(joinHalf: Uint8Array): string {
  return base32Encode(joinHalf);
}

/**
 * The checksum segment of a pairing secret: the first CHECKSUM_BYTES bytes
 * of SHA-256(space id bytes, join half, k0), base32-encoded (7 chars). Same
 * truncated-SHA-256 approach as the device token checksum (`checksumOf`
 * above), but base32 rather than base64url since the rest of the secret
 * already speaks base32. Decoding the space id back to its raw 16 bytes
 * (rather than hashing its base64url text) covers the exact same payload the
 * joining client independently recomputes in its own crypto.ts.
 */
async function pairingChecksumOf(
  spaceId: string,
  joinHalf: Uint8Array,
  k0: Uint8Array
): Promise<string> {
  const spaceIdBytes = base64urlDecode(spaceId);
  if (spaceIdBytes === null) {
    // Unreachable via composeSpaceSecret, which validates spaceId first.
    throw new Error(`invalid space id: ${spaceId}`);
  }
  const payload = new Uint8Array(spaceIdBytes.length + joinHalf.length + k0.length);
  payload.set(spaceIdBytes, 0);
  payload.set(joinHalf, spaceIdBytes.length);
  payload.set(k0, spaceIdBytes.length + joinHalf.length);
  return base32Encode(await checksumOf(payload));
}

/** Composes the user-pasted secret from its three parts. */
export async function composeSpaceSecret(
  spaceId: string,
  joinHalf: Uint8Array,
  k0: Uint8Array
): Promise<string> {
  if (!isSpaceId(spaceId)) {
    throw new Error(`invalid space id: ${spaceId}`);
  }
  if (joinHalf.length !== JOIN_HALF_BYTES || k0.length !== K0_BYTES) {
    throw new Error('invalid join half or k0 length');
  }
  const checksum = await pairingChecksumOf(spaceId, joinHalf, k0);
  return `${JOIN_SECRET_PREFIX}${spaceId}_${joinCredentialOf(joinHalf)}_${base32Encode(k0)}_${checksum}`;
}

/** Mints a fresh join half + K0 and composes the secret. */
export async function makeSpaceSecret(
  spaceId: string
): Promise<{ secret: string; credential: string }> {
  const joinHalf = makeJoinHalf();
  const k0 = makeK0();
  return {
    secret: await composeSpaceSecret(spaceId, joinHalf, k0),
    credential: joinCredentialOf(joinHalf),
  };
}

export interface ParsedJoinCredential {
  ok: boolean;
}

/**
 * Validates a presented join credential: exactly 26 base32 chars decoding to
 * 16 bytes. No checksum — the credential is the bare join half, so the relay
 * compares SHA-256 of the presented value against the stored digests.
 */
export function parseJoinCredential(raw: string): ParsedJoinCredential {
  if (raw.length !== JOIN_CREDENTIAL_CHARS) {
    return { ok: false };
  }
  const decoded = base32Decode(raw);
  if (decoded === null || decoded.length !== JOIN_HALF_BYTES) {
    return { ok: false };
  }
  return { ok: true };
}
