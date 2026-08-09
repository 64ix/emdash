import { describe, expect, it, vi } from 'vitest';
import { JOIN_SECRET_PREFIX } from '@shared/core/sync/pairing';
/**
 * Verifies the client-side join credential against the relay's actual join
 * protocol (apps/sync-relay/src/service.ts + crypto.ts, spec #130 ticket
 * #134): the pasted secret is `emdj1_<space 22>_<join half b32 26>_<k0 b32
 * 52>`; the join credential is the base32 join half alone (26 chars), and
 * the relay stores only SHA-256 of that credential. On join the client
 * presents the credential plus the space id; the relay hashes the presented
 * credential and compares against the stored digests with a constant-time
 * comparison. The relay service and its in-process D1 harness are imported
 * directly, so these tests exercise the real join path rather than a
 * client-side copy of the protocol.
 */
import { sha256Hex } from '../../../../../sync-relay/src/crypto';
import type { SqlDb } from '../../../../../sync-relay/src/db';
import { ensureSchema } from '../../../../../sync-relay/src/schema';
import { ApiError, createSpace, join } from '../../../../../sync-relay/src/service';
import { MemoryD1 } from '../../../../../sync-relay/test/memory-d1';
import {
  composeSpaceSecret,
  joinCredentialOf,
  mintJoinHalf,
  mintK0,
  parseSpaceSecret,
} from './crypto';

// `crypto.ts` / `pairing.ts` log through the main-process logger, whose
// import chain pulls in `electron` (unavailable in plain-Node tests) — mock
// it like other main-core node tests do. The device-identity import chain
// also reaches `@main/db/client` (and from there `electron`); these tests
// only exercise pure derivation, so the mock is never used at runtime.
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

    const parts = parseSpaceSecret(space.secret);
    expect(parts).not.toBeNull();
    if (parts === null) return;
    const credential = joinCredentialOf(parts.joinHalf);

    const joined = await join(
      db,
      { join_hash: credential, space_id: parts.spaceId, name: 'laptop' },
      T0
    );
    expect(joined.device_token).toMatch(/^emdv1_/);
    expect(joined.device_id).not.toBe(space.device_id);
    expect(joined.space_id).toBe(parts.spaceId);
  });

  it('is rejected by the relay when the client pre-hashes the credential', async () => {
    const db = await makeDb();
    const space = await createSpace(db, { name: 'first' }, T0);
    const parts = parseSpaceSecret(space.secret);
    if (parts === null) throw new Error('secret did not parse');

    // sha256 hex is not a base32 join credential: format validation fails.
    const preHashed = await sha256Hex(joinCredentialOf(parts.joinHalf));
    await expect(
      join(db, { join_hash: preHashed, space_id: parts.spaceId, name: 'second' }, T0)
    ).rejects.toMatchObject({
      status: 401,
      message: 'invalid join secret',
    });
  });

  it('is single-use: the relay rejects the second join with the same credential', async () => {
    const db = await makeDb();
    const space = await createSpace(db, { name: 'first' }, T0);
    const parts = parseSpaceSecret(space.secret);
    if (parts === null) throw new Error('secret did not parse');
    const credential = joinCredentialOf(parts.joinHalf);

    const first = await join(
      db,
      { join_hash: credential, space_id: parts.spaceId, name: 'second' },
      T0
    );
    expect(first.device_token).toMatch(/^emdv1_/);

    await expect(
      join(db, { join_hash: credential, space_id: parts.spaceId, name: 'third' }, T0)
    ).rejects.toMatchObject({
      status: 401,
      message: 'invalid join secret',
    });
  });

  it('matches the relay secret format exactly (prefix + space + join half + k0)', () => {
    const spaceId = 'AB12-34_CD56-78_EF90-1';
    const secret = composeSpaceSecret(spaceId, mintJoinHalf(), mintK0());

    expect(secret.startsWith(JOIN_SECRET_PREFIX)).toBe(true);
    // emdj1_ (6) + space (22) + _ (1) + join b32 (26) + _ (1) + k0 b32 (52)
    expect(secret.length).toBe(JOIN_SECRET_PREFIX.length + 22 + 1 + 26 + 1 + 52);

    const parts = parseSpaceSecret(secret);
    expect(parts).not.toBeNull();
    expect(parts?.spaceId).toBe(spaceId);
    expect(parts?.joinHalf.length).toBe(16);
    expect(parts?.k0.length).toBe(32);
  });

  it('derives a credential whose digest equals the one the relay stores at mint time', async () => {
    const db = await makeDb();
    const space = await createSpace(db, { name: 'first' }, T0);
    const parts = parseSpaceSecret(space.secret);
    if (parts === null) throw new Error('secret did not parse');

    const storedDigest = await sha256Hex(joinCredentialOf(parts.joinHalf));
    const pending = await import('../../../../../sync-relay/src/store').then((store) =>
      store.listPendingJoinSecrets(db, parts.spaceId)
    );
    expect(pending[0]?.sha256).toBe(storedDigest);
  });

  it('returns null for strings that do not start with the join-secret prefix', () => {
    expect(parseSpaceSecret('')).toBeNull();
    expect(parseSpaceSecret('   ')).toBeNull();
    expect(parseSpaceSecret('emdv1_abc_def')).toBeNull();
    expect(parseSpaceSecret('emdj1_')).toBeNull();
    expect(parseSpaceSecret('EMDJ1_ABC')).toBeNull();
  });

  it('tolerates surrounding whitespace (paste artifacts) without changing the halves', () => {
    const spaceId = 'AB12-34_CD56-78_EF90-1';
    const secret = composeSpaceSecret(spaceId, mintJoinHalf(), mintK0());
    const parsed = parseSpaceSecret(`  ${secret}\n`);
    expect(parsed).not.toBeNull();
    if (parsed === null) return;
    expect(parsed.k0).toEqual(parseSpaceSecret(secret)?.k0);
  });

  it('is deterministic for the same secret', () => {
    const spaceId = 'AB12-34_CD56-78_EF90-1';
    const secret = composeSpaceSecret(spaceId, mintJoinHalf(), mintK0());
    expect(joinCredentialOf(parseSpaceSecret(secret)!.joinHalf)).toBe(
      joinCredentialOf(parseSpaceSecret(secret)!.joinHalf)
    );
  });

  it('fails with ApiError 401 for a well-formed-looking but unknown credential', async () => {
    const db = await makeDb();
    const space = await createSpace(db, { name: 'first' }, T0);
    const parts = parseSpaceSecret(space.secret);
    if (parts === null) throw new Error('secret did not parse');

    // A different secret for the same space: well-formed, never registered.
    const other = parseSpaceSecret(composeSpaceSecret(parts.spaceId, mintJoinHalf(), mintK0()));
    if (other === null) throw new Error('secret did not parse');
    const unknown = joinCredentialOf(other.joinHalf);
    await expect(
      join(db, { join_hash: unknown, space_id: parts.spaceId, name: 'x' }, T0)
    ).rejects.toBeInstanceOf(ApiError);
    await expect(
      join(db, { join_hash: unknown, space_id: parts.spaceId, name: 'x' }, T0)
    ).rejects.toMatchObject({
      status: 401,
    });
  });
});
