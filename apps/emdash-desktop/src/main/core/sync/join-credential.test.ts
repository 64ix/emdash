import { describe, expect, it, vi } from 'vitest';
import { JOIN_SECRET_PREFIX } from '@shared/core/sync/pairing';
/**
 * Verifies the client-side join credential against the relay's actual join
 * protocol (apps/sync-relay/src/service.ts + crypto.ts): the relay mints
 * `emdj1_` secrets, stores only SHA-256 of the full credential, and on join
 * parses the presented credential as the raw secret (space id, length,
 * checksum) before comparing the SHA-256 digest of what the client sent
 * against the stored digest. The client's `join_hash` must therefore be the
 * trimmed secret itself — the relay does the hashing. The relay service and
 * its in-process D1 harness are imported directly, so these tests exercise
 * the real join path rather than a client-side copy of the protocol.
 */
import {
  constantTimeEqual,
  hexToBytes,
  makeJoinSecret,
  parseJoinSecret,
  sha256Hex,
} from '../../../../../sync-relay/src/crypto';
import type { SqlDb } from '../../../../../sync-relay/src/db';
import { ensureSchema } from '../../../../../sync-relay/src/schema';
import { ApiError, createSpace, join } from '../../../../../sync-relay/src/service';
import { MemoryD1 } from '../../../../../sync-relay/test/memory-d1';
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

const T0 = 1_800_000_000_000;

async function makeDb(): Promise<SqlDb> {
  const db = new MemoryD1();
  await ensureSchema(db);
  return db;
}

describe('join credential derivation (client ↔ relay)', () => {
  it('joins through the real relay service with the derived credential and receives a token', async () => {
    const db = await makeDb();
    const space = await createSpace(db, { name: 'first' }, T0);

    const credential = deriveJoinHash(space.secret);
    expect(credential).toBe(space.secret);

    const joined = await join(db, { join_hash: credential!, name: 'laptop' }, T0);
    expect(joined.device_token).toMatch(/^emdv1_/);
    expect(joined.device_id).not.toBe(space.device_id);
  });

  it('is rejected by the relay when the client pre-hashes the secret (sha256 hex is not a join credential)', async () => {
    const db = await makeDb();
    const space = await createSpace(db, { name: 'first' }, T0);

    const preHashed = await sha256Hex(space.secret);
    await expect(join(db, { join_hash: preHashed, name: 'second' }, T0)).rejects.toMatchObject({
      status: 401,
      message: 'invalid join secret',
    });
  });

  it('is single-use: the relay rejects the second join with the same secret', async () => {
    const db = await makeDb();
    const space = await createSpace(db, { name: 'first' }, T0);

    const first = await join(db, { join_hash: space.secret, name: 'second' }, T0);
    expect(first.device_token).toMatch(/^emdv1_/);

    await expect(join(db, { join_hash: space.secret, name: 'third' }, T0)).rejects.toMatchObject({
      status: 401,
      message: 'invalid join secret',
    });
  });

  it('matches the relay secret format exactly (prefix + space + random + checksum)', async () => {
    const secret = await makeJoinSecret('AB12-34_CD56-78_EF90-1');
    const parsed = await parseJoinSecret(secret);

    expect(secret.startsWith(JOIN_SECRET_PREFIX)).toBe(true);
    // emdj1_ (6) + space (22) + _ (1) + random (22) + _ (1) + checksum (6)
    expect(secret.length).toBe(JOIN_SECRET_PREFIX.length + 22 + 1 + 22 + 1 + 6);
    expect(parsed.ok).toBe(true);
    expect(deriveJoinHash(secret)).toBe(secret);
  });

  it('derives a credential whose digest equals the one the relay stores at mint time', async () => {
    const secret = await makeJoinSecret('AB12-34_CD56-78_EF90-1');

    const storedDigest = await sha256Hex(secret);
    const presentedSha = await sha256Hex(deriveJoinHash(secret)!);
    expect(constantTimeEqual(hexToBytes(presentedSha), hexToBytes(storedDigest))).toBe(true);
  });

  it('returns null for strings that do not start with the join-secret prefix', async () => {
    expect(deriveJoinHash('')).toBeNull();
    expect(deriveJoinHash('   ')).toBeNull();
    expect(deriveJoinHash('emdv1_abc_def')).toBeNull();
    expect(deriveJoinHash('emdj1_')).toBeNull();
    expect(deriveJoinHash('EMDJ1_ABC')).toBeNull();
  });

  it('tolerates surrounding whitespace (paste artifacts) without changing the credential', async () => {
    const secret = await makeJoinSecret('AB12-34_CD56-78_EF90-1');
    expect(deriveJoinHash(`  ${secret}\n`)).toBe(deriveJoinHash(secret));
  });

  it('is deterministic for the same secret', async () => {
    const secret = await makeJoinSecret('AB12-34_CD56-78_EF90-1');
    expect(deriveJoinHash(secret)).toBe(deriveJoinHash(secret));
  });

  it('fails with ApiError 401 for a well-formed-looking but unknown secret', async () => {
    const db = await makeDb();
    const space = await createSpace(db, { name: 'first' }, T0);

    const unknown = space.secret.slice(0, -1) + (space.secret.endsWith('A') ? 'B' : 'A');
    await expect(join(db, { join_hash: unknown, name: 'x' }, T0)).rejects.toBeInstanceOf(ApiError);
    await expect(join(db, { join_hash: unknown, name: 'x' }, T0)).rejects.toMatchObject({
      status: 401,
    });
  });
});
