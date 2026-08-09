/**
 * End-to-end row encryption for multi-machine sync (spec #130, ticket #134).
 *
 * Row bodies are encrypted in the main process (node:crypto) before they
 * leave the machine, and decrypted on pull; the relay only ever sees
 * plaintext metadata (table, pk, version, client_version, deleted) plus an
 * opaque envelope string.
 *
 * Algorithm (per the spec):
 * - AES-256-GCM, 96-bit random nonce per encryption, 128-bit auth tag.
 * - Per-row key: HKDF-SHA256(K0, salt = row_id, info = "row-v1"), 32 bytes,
 *   where row_id = JSON.stringify([table, pk]) (unambiguous for composite
 *   keys and for pks containing separators).
 * - Envelope: `{alg: "AES-256-GCM", key_id, nonce, ct}` (base64url nonce and
 *   ciphertext; the 16-byte auth tag is appended to the ciphertext inside
 *   `ct`).
 * - AAD: UTF-8 JSON array `[table, pk, version, keyId]`. `version` is the
 *   CLIENT version the encrypting machine knew for the row (see
 *   `client_version` in transport.ts / the relay protocol) — the relay
 *   stores it verbatim and returns it on pull, so the encrypting and
 *   decrypting sides always agree, while a body replayed under different
 *   metadata fails authentication. Binding table+pk defeats row swaps by the
 *   relay; binding keyId defeats cross-key confusion after a rekey.
 *
 * Pairing secret (two-half model): `emdj1_<space 22>_<join b32 26>_<k0 b32
 * 52>`. The join half (16 random bytes) is the only half that ever transits
 * to the relay (as SHA-256); K0 (32 random bytes) is the space data key and
 * travels only machine-to-machine inside the pasted secret. K0 is stored
 * machine-locally in safeStorage (see space-key-store.ts).
 *
 * The base32 encoding (RFC 4648, lowercase, unpadded) and the secret layout
 * are mirrored by apps/sync-relay/src/crypto.ts; join-credential.test.ts
 * cross-checks the client derivation against the real relay service.
 */
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { err, ok, type Result } from '@emdash/shared';
import { JOIN_SECRET_PREFIX } from '@shared/core/sync/pairing';

export const SYNC_ALG = 'AES-256-GCM';
export const JOIN_HALF_BYTES = 16;
export const K0_BYTES = 32;
export const NONCE_BYTES = 12;
export const AUTH_TAG_BYTES = 16;
export const KEY_ID_HEX_CHARS = 16;

/**
 * The node:crypto algorithm name for the GCM overloads (case-insensitive at
 * runtime; `AES-256-GCM` is what the envelope carries).
 */
const NODE_GCM_ALG = 'aes-256-gcm';

/** Base32 (RFC 4648, lowercase, unpadded) character counts of the halves. */
export const JOIN_CREDENTIAL_CHARS = 26;
export const K0_B32_CHARS = 52;

/** The relay space id length (base64url of 16 bytes). */
export const SPACE_ID_CHARS = 22;

/** Full pasted-secret length: `emdj1_` + space + `_` + join + `_` + k0. */
export const SPACE_SECRET_CHARS = JOIN_SECRET_PREFIX.length + 22 + 1 + 26 + 1 + 52;

/** The versioned ciphertext envelope that travels as the row body. */
export interface SyncEnvelope {
  alg: string;
  key_id: string;
  /** base64url 96-bit nonce. */
  nonce: string;
  /** base64url of ciphertext ‖ 128-bit auth tag. */
  ct: string;
}

/** The metadata bound into the AEAD AAD on both encrypt and decrypt. */
export interface RowAad {
  table: string;
  pk: string;
  /** The client version of the row (0 for never-synced rows). */
  version: number;
  keyId: string;
}

export type SyncCryptoError =
  | { type: 'unknown_key_id'; message: string }
  | { type: 'unsupported_alg'; message: string }
  | { type: 'malformed_envelope'; message: string }
  | { type: 'aad_mismatch'; message: string };

/** The parsed halves of a pasted pairing secret. */
export interface SpaceSecretParts {
  spaceId: string;
  /** 16 random bytes; the join credential presented to the relay. */
  joinHalf: Uint8Array;
  /** 32 random bytes; the space data key. Stored in safeStorage locally. */
  k0: Uint8Array;
}

const B32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const b32Pattern = /^[a-z2-7]+$/;
const spaceIdPattern = new RegExp(`^[A-Za-z0-9_-]{${SPACE_ID_CHARS}}$`);
const keyIdPattern = new RegExp(`^[0-9a-f]{${KEY_ID_HEX_CHARS}}$`);

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

/** Decodes lowercase base32 (uppercase tolerated); null on garbage. */
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

/** 16 random bytes: the join half of a pairing secret. */
export function mintJoinHalf(): Uint8Array {
  return randomBytes(JOIN_HALF_BYTES);
}

/** 32 random bytes: a fresh space data key (K0). */
export function mintK0(): Uint8Array {
  return randomBytes(K0_BYTES);
}

/** The join credential of a join half: base32, 26 chars. */
export function joinCredentialOf(joinHalf: Uint8Array): string {
  return base32Encode(joinHalf);
}

/** Composes the user-pasted pairing secret from its three parts. */
export function composeSpaceSecret(spaceId: string, joinHalf: Uint8Array, k0: Uint8Array): string {
  if (!spaceIdPattern.test(spaceId)) {
    throw new Error(`invalid space id: ${spaceId}`);
  }
  if (joinHalf.length !== JOIN_HALF_BYTES || k0.length !== K0_BYTES) {
    throw new Error('invalid join half or k0 length');
  }
  return `${JOIN_SECRET_PREFIX}${spaceId}_${joinCredentialOf(joinHalf)}_${base32Encode(k0)}`;
}

/**
 * Parses a pasted pairing secret into its halves. Rejects anything that is
 * not exactly `emdj1_<22>_<26>_<52>` with valid encodings. `null` on any
 * mismatch — the relay is the authority on validity, this only gates the
 * format (and keeps garbage pastes from reaching the relay at all).
 */
export function parseSpaceSecret(secret: string): SpaceSecretParts | null {
  const trimmed = secret.trim();
  if (!trimmed.startsWith(JOIN_SECRET_PREFIX) || trimmed.length !== SPACE_SECRET_CHARS) {
    return null;
  }
  const body = trimmed.slice(JOIN_SECRET_PREFIX.length);
  const spaceId = body.slice(0, SPACE_ID_CHARS);
  const joinB32 = body.slice(SPACE_ID_CHARS + 1, SPACE_ID_CHARS + 1 + JOIN_CREDENTIAL_CHARS);
  const k0B32 = body.slice(SPACE_ID_CHARS + 1 + JOIN_CREDENTIAL_CHARS + 1);
  if (!spaceIdPattern.test(spaceId)) {
    return null;
  }
  const joinHalf = base32Decode(joinB32);
  const k0 = base32Decode(k0B32);
  if (joinHalf === null || joinHalf.length !== JOIN_HALF_BYTES) return null;
  if (k0 === null || k0.length !== K0_BYTES) return null;
  return { spaceId, joinHalf, k0 };
}

/**
 * The join credential to present to the relay: the base32 join half. The
 * relay hashes it and compares against the digests it stores (never the
 * full secret). `null` when the secret does not even look like one.
 */
export function deriveJoinCredential(secret: string): string | null {
  const parts = parseSpaceSecret(secret);
  return parts === null ? null : joinCredentialOf(parts.joinHalf);
}

/**
 * The space key id: the first 8 bytes of SHA-256(K0) as hex. Deterministic
 * per K0, so it changes on rekey without any stored counter, and old
 * envelopes are rejected with `unknown_key_id` after a rekey.
 */
export function keyIdOf(k0: Uint8Array): string {
  return createHash('sha256').update(k0).digest('hex').slice(0, KEY_ID_HEX_CHARS);
}

/** Unambiguous per-row salt: JSON array of [table, pk]. */
export function rowIdOf(table: string, pk: string): Uint8Array {
  return Buffer.from(JSON.stringify([table, pk]), 'utf8');
}

/** The AEAD AAD bytes: UTF-8 JSON array of [table, pk, version, keyId]. */
export function aadOf(aad: RowAad): Uint8Array {
  return Buffer.from(JSON.stringify([aad.table, aad.pk, aad.version, aad.keyId]), 'utf8');
}

/** HKDF-SHA256 per-row key: 32 bytes, deterministic for (K0, table, pk). */
export function deriveRowKey(k0: Uint8Array, table: string, pk: string): Uint8Array {
  // `hkdfSync` returns an ArrayBuffer; wrap it so callers get a Uint8Array.
  return Buffer.from(
    hkdfSync('sha256', k0, rowIdOf(table, pk), Buffer.from('row-v1', 'utf8'), K0_BYTES)
  );
}

/** Encrypts a plaintext row body into a versioned envelope. */
export function encrypt(
  k0: Uint8Array,
  keyId: string,
  aad: RowAad,
  plaintext: string
): SyncEnvelope {
  const rowKey = deriveRowKey(k0, aad.table, aad.pk);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(NODE_GCM_ALG, rowKey, nonce, {
    authTagLength: AUTH_TAG_BYTES,
  });
  cipher.setAAD(aadOf(aad));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return {
    alg: SYNC_ALG,
    key_id: keyId,
    nonce: nonce.toString('base64url'),
    ct: ciphertext.toString('base64url'),
  };
}

/** Serialized envelope: the opaque string the relay stores as the body. */
export function encryptBody(k0: Uint8Array, keyId: string, aad: RowAad, plaintext: string): string {
  return JSON.stringify(encrypt(k0, keyId, aad, plaintext));
}

/** Parses an envelope string, rejecting malformed shapes before any crypto. */
export function parseEnvelope(raw: string): Result<SyncEnvelope, SyncCryptoError> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return err({ type: 'malformed_envelope', message: 'row body is not a valid envelope' });
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return err({ type: 'malformed_envelope', message: 'row body is not a valid envelope' });
  }
  const envelope = parsed as Partial<SyncEnvelope>;
  if (
    typeof envelope.alg !== 'string' ||
    typeof envelope.key_id !== 'string' ||
    typeof envelope.nonce !== 'string' ||
    typeof envelope.ct !== 'string'
  ) {
    return err({ type: 'malformed_envelope', message: 'row body is not a valid envelope' });
  }
  return ok(envelope as SyncEnvelope);
}

/**
 * Decrypts an envelope. Fails cleanly with a typed error for every
 * failure mode: unknown key id (rekeyed space), unsupported algorithm,
 * malformed envelope (truncated nonce, garbage), or an AEAD
 * authentication failure (tampered ciphertext, wrong table/pk/version/keyId
 * in the AAD — including a body replayed under different metadata).
 */
export function decrypt(
  k0: Uint8Array,
  aad: RowAad,
  envelope: SyncEnvelope
): Result<string, SyncCryptoError> {
  if (!keyIdPattern.test(envelope.key_id)) {
    return err({ type: 'malformed_envelope', message: 'envelope key_id is malformed' });
  }
  if (envelope.key_id !== aad.keyId) {
    return err({
      type: 'unknown_key_id',
      message: `row is encrypted with key ${envelope.key_id}, local key is ${aad.keyId}`,
    });
  }
  if (envelope.alg !== SYNC_ALG) {
    return err({ type: 'unsupported_alg', message: `unsupported algorithm ${envelope.alg}` });
  }
  const nonce = Buffer.from(envelope.nonce, 'base64url');
  const ctAndTag = Buffer.from(envelope.ct, 'base64url');
  if (nonce.length !== NONCE_BYTES || ctAndTag.length <= AUTH_TAG_BYTES) {
    return err({
      type: 'malformed_envelope',
      message: 'envelope nonce or ciphertext is truncated',
    });
  }
  const rowKey = deriveRowKey(k0, aad.table, aad.pk);
  const ciphertext = ctAndTag.subarray(0, ctAndTag.length - AUTH_TAG_BYTES);
  const tag = ctAndTag.subarray(ctAndTag.length - AUTH_TAG_BYTES);
  const decipher = createDecipheriv(NODE_GCM_ALG, rowKey, nonce, {
    authTagLength: AUTH_TAG_BYTES,
  });
  decipher.setAAD(aadOf(aad));
  decipher.setAuthTag(tag);
  try {
    return ok(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'));
  } catch {
    return err({
      type: 'aad_mismatch',
      message: 'row body failed authentication (tampered or bound to different metadata)',
    });
  }
}

/** Decrypts a serialized envelope; see {@link decrypt}. */
export function decryptBody(
  k0: Uint8Array,
  aad: RowAad,
  body: string
): Result<string, SyncCryptoError> {
  const parsed = parseEnvelope(body);
  if (!parsed.success) return parsed;
  return decrypt(k0, aad, parsed.data);
}
