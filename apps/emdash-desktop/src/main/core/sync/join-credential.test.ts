import { describe, expect, it, vi } from 'vitest';
import { JOIN_SECRET_PREFIX } from '@shared/core/sync/pairing';
/**
 * Verifies the client-side join-credential derivation against the relay's own
 * crypto (apps/sync-relay/src/crypto.ts). The relay mints `emdj1_` secrets,
 * stores only SHA-256 of the full credential, and matches join attempts by
 * hashing what the client presents — so the client's `join_hash` must be the
 * SHA-256 hex digest of the full secret string. The relay source is imported
 * directly (its package entry is the built `dist/index.mjs`, which this repo's
 * validation gate does not build); crypto.ts is dependency-free WebCrypto code
 * that runs identically in Node.
 */
import {
  constantTimeEqual,
  hexToBytes,
  makeJoinSecret,
  parseJoinSecret,
  sha256Hex,
} from '../../../../../sync-relay/src/crypto';
import { deriveJoinHash } from './pairing';

// `pairing.ts` logs through the main-process logger, whose import chain pulls
// in `electron` (unavailable in plain-Node tests) — mock it like other
// main-core node tests do. The device-identity import chain also reaches
// `@main/db/client` (and from there `electron`); these tests only exercise
// pure derivation, so the mock is never used at runtime.
vi.mock('@main/lib/logger', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('@main/db/client', () => ({
  get db() {
    throw new Error('no db in join-credential node tests');
  },
}));

describe('join credential derivation (client ↔ relay)', () => {
  it('derives the join hash the relay stores at mint time: sha256 of the full secret', async () => {
    const secret = await makeJoinSecret('AB12-34_CD56-78_EF90-1');

    const clientHash = deriveJoinHash(secret);
    expect(clientHash).not.toBeNull();
    // The relay stores sha256Hex(secret) at mint time and matches it against
    // the SHA-256 digest of what the client presents — the client's hex
    // string must therefore decode to exactly the digest of the minted secret.
    expect(clientHash).toBe(await sha256Hex(secret));
    expect(constantTimeEqual(hexToBytes(clientHash!), hexToBytes(await sha256Hex(secret)))).toBe(
      true
    );
  });

  it('derives a hash the relay considers a well-formed join credential', async () => {
    const spaceId = 'Xy9_zAbCDEf-01_2345678';
    const secret = await makeJoinSecret(spaceId);

    const parsed = await parseJoinSecret(secret);
    expect(parsed.ok).toBe(true);
    expect(parsed.spaceId).toBe(spaceId);

    const clientHash = deriveJoinHash(secret)!;
    // The relay hashes the presented credential and matches against the stored
    // digest of the minted secret.
    expect(clientHash).toBe(await sha256Hex(secret));
  });

  it('matches the relay secret format exactly (prefix + space + random + checksum)', async () => {
    const secret = await makeJoinSecret('AB12-34_CD56-78_EF90-1');
    const parsed = await parseJoinSecret(secret);

    expect(secret.startsWith(JOIN_SECRET_PREFIX)).toBe(true);
    // emdj1_ (6) + space (22) + _ (1) + random (22) + _ (1) + checksum (6)
    expect(secret.length).toBe(JOIN_SECRET_PREFIX.length + 22 + 1 + 22 + 1 + 6);
    expect(parsed.ok).toBe(true);
  });

  it('returns null for strings that do not start with the join-secret prefix', async () => {
    expect(deriveJoinHash('')).toBeNull();
    expect(deriveJoinHash('   ')).toBeNull();
    expect(deriveJoinHash('emdv1_abc_def')).toBeNull();
    expect(deriveJoinHash('emdj1_')).toBeNull();
    expect(deriveJoinHash('EMDJ1_ABC')).toBeNull();
  });

  it('tolerates surrounding whitespace (paste artifacts) without changing the hash', async () => {
    const secret = await makeJoinSecret('AB12-34_CD56-78_EF90-1');
    expect(deriveJoinHash(`  ${secret}\n`)).toBe(deriveJoinHash(secret));
  });

  it('is deterministic for the same secret', async () => {
    const secret = await makeJoinSecret('AB12-34_CD56-78_EF90-1');
    expect(deriveJoinHash(secret)).toBe(deriveJoinHash(secret));
  });
});
