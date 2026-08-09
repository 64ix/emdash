import type { Result } from '@emdash/shared';
/**
 * Unit tests for the sync row encryption (spec #130, ticket #134): envelope
 * format, per-row key derivation, AAD binding, and every decrypt failure
 * mode, plus the two-half pairing secret format.
 */
import { describe, expect, it, vi } from 'vitest';
import { JOIN_SECRET_PREFIX } from '@shared/core/sync/pairing';
import {
  AUTH_TAG_BYTES,
  base32Decode,
  composeSpaceSecret,
  decrypt,
  decryptBody,
  deriveRowKey,
  encrypt,
  encryptBody,
  joinCredentialOf,
  keyIdOf,
  K0_B32_CHARS,
  K0_BYTES,
  mintJoinHalf,
  mintK0,
  NONCE_BYTES,
  parseEnvelope,
  parseSpaceSecret,
  SYNC_ALG,
  type SyncEnvelope,
  type SyncCryptoError,
} from './crypto';

// `crypto.ts` imports the shared pairing constants whose module chain pulls
// in nothing electron-specific, but the logger mock keeps the sync test
// suite uniform (some sibling modules do log through @main/lib/logger).
vi.mock('@main/lib/logger', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const k0 = mintK0();
const keyId = keyIdOf(k0);

function envelopeOf(body: string): SyncEnvelope {
  return JSON.parse(body) as SyncEnvelope;
}

function expectCryptoError(
  result: Result<unknown, SyncCryptoError>,
  type: SyncCryptoError['type']
): void {
  expect(result.success).toBe(false);
  if (result.success) return;
  expect(result.error.type).toBe(type);
}

describe('envelope format', () => {
  it('round-trips a plaintext body through encrypt/decrypt', () => {
    const body = JSON.stringify({ deviceId: 'd', columns: { name: 'Repo', id: 'x' } });
    const envelope = encrypt(k0, keyId, { table: 'projects', pk: 'x', version: 3, keyId }, body);
    const decrypted = decrypt(k0, { table: 'projects', pk: 'x', version: 3, keyId }, envelope);
    expect(decrypted.success).toBe(true);
    if (decrypted.success) expect(decrypted.data).toBe(body);
  });

  it('produces a versioned envelope with exactly alg, key_id, nonce and ct', () => {
    const envelope = encrypt(k0, keyId, { table: 't', pk: 'a', version: 0, keyId }, 'payload');
    expect(Object.keys(envelope).sort()).toEqual(['alg', 'ct', 'key_id', 'nonce']);
    expect(envelope.alg).toBe(SYNC_ALG);
    expect(envelope.key_id).toBe(keyId);
    expect(Buffer.from(envelope.nonce, 'base64url').length).toBe(NONCE_BYTES);
    expect(Buffer.from(envelope.ct, 'base64url').length).toBeGreaterThan(AUTH_TAG_BYTES);
    // The ciphertext embeds the 16-byte auth tag: plaintext bytes + tag.
    expect(Buffer.from(envelope.ct, 'base64url').length).toBe(
      Buffer.byteLength('payload') + AUTH_TAG_BYTES
    );
  });

  it('uses a fresh random nonce per encryption (and never reuses ciphertext)', () => {
    const aad = { table: 't', pk: 'a', version: 1, keyId };
    const first = encrypt(k0, keyId, aad, 'same payload');
    const second = encrypt(k0, keyId, aad, 'same payload');
    expect(first.nonce).not.toBe(second.nonce);
    expect(first.ct).not.toBe(second.ct);
    // Both still decrypt independently.
    const a = decrypt(k0, aad, first);
    const b = decrypt(k0, aad, second);
    expect(a.success && a.data).toBe('same payload');
    expect(b.success && b.data).toBe('same payload');
  });

  it('serializes to the opaque JSON string the relay stores as the body', () => {
    const body = encryptBody(k0, keyId, { table: 't', pk: 'a', version: 0, keyId }, 'secret');
    const envelope = envelopeOf(body);
    expect(envelope.alg).toBe(SYNC_ALG);
    const parsed = parseEnvelope(body);
    expect(parsed.success).toBe(true);
  });
});

describe('per-row key derivation', () => {
  it('derives different row keys for different rows', () => {
    const a = deriveRowKey(k0, 'projects', '1');
    const b = deriveRowKey(k0, 'projects', '2');
    const c = deriveRowKey(k0, 'tasks', '1');
    expect(a).not.toEqual(b);
    expect(a).not.toEqual(c);
    expect(b).not.toEqual(c);
  });

  it('is deterministic for the same (k0, table, pk) and 32 bytes long', () => {
    const first = deriveRowKey(k0, 'projects', '1');
    const second = deriveRowKey(k0, 'projects', '1');
    expect(first).toEqual(second);
    expect(first.length).toBe(K0_BYTES);
    // Composite pks and pks containing separators cannot collide via the
    // JSON-encoded row id.
    expect(deriveRowKey(k0, 't', 'a:b')).not.toEqual(deriveRowKey(k0, 't:a', 'b'));
  });

  it('derives different keys for different K0 values (rekey changes every row key)', () => {
    const other = mintK0();
    expect(deriveRowKey(other, 't', 'a')).not.toEqual(deriveRowKey(k0, 't', 'a'));
  });
});

describe('AAD binding (relay row/version swaps fail)', () => {
  const body = 'row-content';
  const aad = { table: 'projects', pk: 'p1', version: 7, keyId };
  const envelope = encrypt(k0, keyId, aad, body);

  it('rejects decrypting under a different table', () => {
    expectCryptoError(decrypt(k0, { ...aad, table: 'tasks' }, envelope), 'aad_mismatch');
  });

  it('rejects decrypting under a different pk (row swap)', () => {
    expectCryptoError(decrypt(k0, { ...aad, pk: 'p2' }, envelope), 'aad_mismatch');
  });

  it('rejects decrypting under a different version (replay of an old body)', () => {
    expectCryptoError(decrypt(k0, { ...aad, version: 8 }, envelope), 'aad_mismatch');
    expectCryptoError(decrypt(k0, { ...aad, version: 6 }, envelope), 'aad_mismatch');
  });

  it('rejects decrypting under a different key id', () => {
    const otherKeyId = keyIdOf(mintK0());
    expectCryptoError(decrypt(k0, { ...aad, keyId: otherKeyId }, envelope), 'unknown_key_id');
  });

  it('rejects a tampered ciphertext (corrupted body)', () => {
    const bits = Buffer.from(envelope.ct, 'base64url');
    bits[0] = bits[0]! ^ 0xff;
    const tampered = { ...envelope, ct: bits.toString('base64url') };
    expectCryptoError(decrypt(k0, aad, tampered), 'aad_mismatch');
  });

  it('still decrypts with the exact original metadata', () => {
    expect(decrypt(k0, aad, envelope).success).toBe(true);
  });
});

describe('decrypt failure modes', () => {
  const aad = { table: 't', pk: 'a', version: 1, keyId };

  it('rejects an unknown key id (rekeyed space) with unknown_key_id', () => {
    const otherK0 = mintK0();
    const otherKeyId = keyIdOf(otherK0);
    const envelope = encrypt(otherK0, otherKeyId, { ...aad, keyId: otherKeyId }, 'x');
    expectCryptoError(decrypt(k0, aad, envelope), 'unknown_key_id');
    // decryptBody surfaces the same error through the serialized form.
    expectCryptoError(decryptBody(k0, aad, JSON.stringify(envelope)), 'unknown_key_id');
  });

  it('rejects a non-envelope body with malformed_envelope', () => {
    expectCryptoError(decryptBody(k0, aad, 'not-json'), 'malformed_envelope');
    expectCryptoError(decryptBody(k0, aad, '"just-a-string"'), 'malformed_envelope');
    expectCryptoError(decryptBody(k0, aad, '{"alg":"AES-256-GCM"}'), 'malformed_envelope');
  });

  it('rejects an unsupported algorithm', () => {
    const envelope = encrypt(k0, keyId, aad, 'x');
    expectCryptoError(decrypt(k0, aad, { ...envelope, alg: 'AES-128-CBC' }), 'unsupported_alg');
  });

  it('rejects a truncated nonce', () => {
    const envelope = encrypt(k0, keyId, aad, 'x');
    const truncated = { ...envelope, nonce: Buffer.alloc(6).toString('base64url') };
    expectCryptoError(decrypt(k0, aad, truncated), 'malformed_envelope');
  });

  it('rejects a truncated ciphertext (missing auth tag)', () => {
    const envelope = encrypt(k0, keyId, aad, 'x');
    const tagless = Buffer.from(envelope.ct, 'base64url').subarray(0, AUTH_TAG_BYTES - 1);
    expectCryptoError(
      decrypt(k0, aad, { ...envelope, ct: tagless.toString('base64url') }),
      'malformed_envelope'
    );
  });

  it('rejects a malformed key id in the envelope', () => {
    const envelope = encrypt(k0, keyId, aad, 'x');
    expectCryptoError(decrypt(k0, aad, { ...envelope, key_id: 'zz' }), 'malformed_envelope');
  });
});

describe('two-half pairing secret format', () => {
  it('composes and parses the secret with the documented layout', () => {
    const spaceId = 'AB12-34_CD56-78_EF90-1';
    const joinHalf = mintJoinHalf();
    const secret = composeSpaceSecret(spaceId, joinHalf, mintK0());

    expect(secret.startsWith(JOIN_SECRET_PREFIX)).toBe(true);
    expect(secret.length).toBe(JOIN_SECRET_PREFIX.length + 22 + 1 + 26 + 1 + 52);
    expect(secret).toMatch(
      new RegExp(`^${JOIN_SECRET_PREFIX}[A-Za-z0-9_-]{22}_[a-z2-7]{26}_[a-z2-7]{52}$`)
    );

    const parts = parseSpaceSecret(secret);
    expect(parts).not.toBeNull();
    expect(parts?.spaceId).toBe(spaceId);
    expect([...parts!.joinHalf]).toEqual([...joinHalf]);
    expect(parts?.k0.length).toBe(K0_BYTES);
  });

  it('derives the IDENTICAL K0 on two independent machines from the same secret', () => {
    const secret = composeSpaceSecret('AB12-34_CD56-78_EF90-1', mintJoinHalf(), mintK0());
    const machineA = parseSpaceSecret(secret);
    const machineB = parseSpaceSecret(secret);
    expect(machineA).not.toBeNull();
    expect(machineB).not.toBeNull();
    if (machineA === null || machineB === null) return;
    // The two-client invariant: same secret -> identical K0 -> identical
    // key_id -> identical row keys -> interchangeable ciphertexts.
    expect(Buffer.from(machineA.k0).equals(Buffer.from(machineB.k0))).toBe(true);
    expect(keyIdOf(machineA.k0)).toBe(keyIdOf(machineB.k0));
    const aad = { table: 't', pk: 'a', version: 0, keyId: keyIdOf(machineA.k0) };
    const ciphertext = encryptBody(machineA.k0, keyIdOf(machineA.k0), aad, 'shared');
    const decrypted = decryptBody(machineB.k0, { ...aad, keyId: keyIdOf(machineB.k0) }, ciphertext);
    expect(decrypted.success && decrypted.data).toBe('shared');
  });

  it('rejects malformed or truncated secrets', () => {
    const spaceId = 'AB12-34_CD56-78_EF90-1';
    const secret = composeSpaceSecret(spaceId, mintJoinHalf(), mintK0());
    expect(parseSpaceSecret(secret.slice(0, -1))).toBeNull();
    expect(parseSpaceSecret(`${secret}extra`)).toBeNull();
    expect(parseSpaceSecret(secret.replace(secret[0]!, 'x'))).toBeNull();
    expect(parseSpaceSecret(secret.toUpperCase())).toBeNull();
    expect(parseSpaceSecret('')).toBeNull();
    expect(parseSpaceSecret('emdj1_short')).toBeNull();
    // A swapped half (k0 length wrong) is rejected.
    const bad = secret.slice(0, 56) + secret.slice(56, 60);
    expect(parseSpaceSecret(bad)).toBeNull();
  });

  it('tolerates paste whitespace', () => {
    const secret = composeSpaceSecret('AB12-34_CD56-78_EF90-1', mintJoinHalf(), mintK0());
    const parsed = parseSpaceSecret(`  ${secret}\n`);
    expect(parsed).not.toBeNull();
    if (parsed !== null) {
      expect(parsed.spaceId).toBe('AB12-34_CD56-78_EF90-1');
    }
  });

  it('join credentials are the 26-char base32 join half', () => {
    const joinHalf = mintJoinHalf();
    const credential = joinCredentialOf(joinHalf);
    expect(credential).toMatch(/^[a-z2-7]{26}$/);
    expect([...base32Decode(credential)!]).toEqual([...joinHalf]);
    // The k0 half is 52 chars.
    expect(joinCredentialOf(mintK0()).length).toBe(K0_B32_CHARS);
  });
});

describe('key id derivation', () => {
  it('is deterministic per K0 and 16 hex chars', () => {
    expect(keyIdOf(k0)).toMatch(/^[0-9a-f]{16}$/);
    expect(keyIdOf(k0)).toBe(keyIdOf(k0));
  });

  it('changes when K0 changes (rekey)', () => {
    expect(keyIdOf(k0)).not.toBe(keyIdOf(mintK0()));
  });
});
