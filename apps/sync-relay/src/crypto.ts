/**
 * Credential handling for the relay.
 *
 * Device tokens and pairing secrets are random high-entropy values with a
 * fixed positional layout: `prefix_base64url(secret)_base64url(checksum)`.
 * The checksum is the first 4 bytes of SHA-256 over the secret part; the relay
 * verifies it with a constant-time comparison before hashing the full
 * credential for the store lookup. Only SHA-256 digests of credentials are
 * ever persisted (see `store.ts`).
 *
 * SHA-256 runs on WebCrypto (`crypto.subtle`), which is available on both the
 * Workers runtime and Node >= 18, so the exact same code paths run in
 * production and in tests.
 */

const TOKEN_PREFIX = 'emdv1_';
const JOIN_SECRET_PREFIX = 'emdj1_';

/** 32 random bytes for device tokens, 16 for the join-secret random half. */
const TOKEN_SECRET_BYTES = 32;
const JOIN_SECRET_RANDOM_BYTES = 16;
const CHECKSUM_BYTES = 4;

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
// Pairing secrets: `emdj1_<22 chars space id>_<22 chars random>_<6 chars
// checksum>` (57 total). The space id is embedded (in plaintext, like the
// space id itself) so the relay can attribute a failed join attempt to the
// pending secret of that space and charge its attempt budget.
// ---------------------------------------------------------------------------

export function isSpaceId(value: string): boolean {
  return new RegExp(`^[A-Za-z0-9_-]{${SPACE_ID_CHARS}}$`).test(value);
}

export async function makeJoinSecret(spaceId: string): Promise<string> {
  if (!isSpaceId(spaceId)) {
    throw new Error(`invalid space id: ${spaceId}`);
  }
  const random = randomBytes(JOIN_SECRET_RANDOM_BYTES);
  const checksum = await checksumOf(random);
  return `${JOIN_SECRET_PREFIX}${spaceId}_${base64url(random)}_${base64url(checksum)}`;
}

export interface ParsedJoinSecret {
  ok: boolean;
  spaceId: string | null;
}

export async function parseJoinSecret(raw: string): Promise<ParsedJoinSecret> {
  const body = raw.startsWith(JOIN_SECRET_PREFIX) ? raw.slice(JOIN_SECRET_PREFIX.length) : null;
  if (body === null || body.length !== SPACE_ID_CHARS + 1 + 22 + 1 + 6) {
    return { ok: false, spaceId: null };
  }
  const spaceId = body.slice(0, SPACE_ID_CHARS);
  const randomB64 = body.slice(SPACE_ID_CHARS + 1, SPACE_ID_CHARS + 1 + 22);
  const checksumB64 = body.slice(SPACE_ID_CHARS + 1 + 22 + 1);
  if (!isSpaceId(spaceId)) {
    return { ok: false, spaceId: null };
  }
  const random = base64urlDecode(randomB64);
  const checksum = base64urlDecode(checksumB64);
  if (
    random === null ||
    random.length !== JOIN_SECRET_RANDOM_BYTES ||
    checksum === null ||
    checksum.length !== CHECKSUM_BYTES
  ) {
    return { ok: false, spaceId: null };
  }
  const expected = await checksumOf(random);
  if (!constantTimeEqual(expected, checksum)) {
    return { ok: false, spaceId: null };
  }
  return { ok: true, spaceId };
}
