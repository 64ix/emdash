import { openFixture } from '@tooling/utils/db';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import { appSecrets } from '@main/db/schema';
import { decrypt, encrypt, keyIdOf, mintK0 } from './crypto';
import { SpaceKeyStore } from './space-key-store';
import { SYNC_ENCRYPTION_KEY_SECRET_KEY } from './sync-secrets';

// `space-key-store.ts` logs through the main-process logger, whose import
// chain pulls in `electron` (unavailable in plain-Node tests) — mock it like
// other main-core node tests do. The dynamically imported
// `encrypted-app-secrets-store` also binds `safeStorage` from `electron` at
// module level; the constructor under test receives a fake safeStorage, so
// the mock is only needed for import safety.
vi.mock('@main/lib/logger', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn(),
    decryptString: vi.fn(),
    getSelectedStorageBackend: vi.fn(() => 'keychain'),
  },
}));

// Stop client.ts from opening the real Electron DB at import time. The
// EncryptedAppSecretsStore singleton is constructed at module import with the
// default `db` binding, so the mock must be in place before the dynamic
// import below.
const mocks = vi.hoisted(() => ({ db: undefined as AppDb | undefined }));
vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));

/** Fake safeStorage: deterministic base64-obscured round trip. */
function fakeSafeStorage(available = true, backend: 'basic_text' | 'unknown' = 'unknown') {
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain: string) => Buffer.from(`enc:${plain}`, 'utf8'),
    decryptString: (encrypted: Buffer) => encrypted.toString('utf8').slice(4),
    getSelectedStorageBackend: () => backend,
    setUsePlainTextEncryption: () => {},
  };
}

describe('sync space key storage (safeStorage-backed app_secrets)', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;
  let store: SpaceKeyStore;

  afterEach(() => {
    fixture?.close();
  });

  async function openStore(available = true): Promise<void> {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
    const { EncryptedAppSecretsStore } =
      await import('@main/core/secrets/encrypted-app-secrets-store');
    store = new SpaceKeyStore(
      new EncryptedAppSecretsStore(fixture.db, fakeSafeStorage(available), 'darwin')
    );
  }

  it('round-trips K0 and its derived key id through the encrypted store', async () => {
    await openStore();
    const k0 = mintK0();

    const before = await store.get();
    expect(before.success).toBe(true);
    if (before.success) expect(before.data).toBeNull();

    const set = await store.set(k0);
    expect(set.success).toBe(true);

    const after = await store.get();
    expect(after.success).toBe(true);
    if (!after.success || after.data === null) return;
    expect(after.data.keyId).toBe(keyIdOf(k0));
    expect(Buffer.from(after.data.k0).equals(Buffer.from(k0))).toBe(true);

    // The value is stored under the reserved sync-encryption-key key,
    // encrypted (base64 of the safeStorage ciphertext — never the plaintext).
    const [row] = await fixture.db
      .select({ key: appSecrets.key, secret: appSecrets.secret })
      .from(appSecrets)
      .where(eq(appSecrets.key, SYNC_ENCRYPTION_KEY_SECRET_KEY));
    expect(row?.key).toBe(SYNC_ENCRYPTION_KEY_SECRET_KEY);
    expect(Buffer.from(row!.secret, 'base64').toString('utf8').startsWith('enc:')).toBe(true);
    expect(row!.secret).not.toContain(after.data.keyId);
  });

  it('a rekey replaces the key atomically and old envelopes fail with unknown_key_id', async () => {
    await openStore();
    const oldK0 = mintK0();
    await store.set(oldK0);
    const oldKeyId = keyIdOf(oldK0);
    const oldEnvelope = encrypt(
      oldK0,
      oldKeyId,
      { table: 't', pk: 'a', version: 1, keyId: oldKeyId },
      'old'
    );

    // Rekey: a new K0 overwrites the stored one, and the key id changes.
    const newK0 = mintK0();
    const newKeyId = keyIdOf(newK0);
    expect(newKeyId).not.toBe(oldKeyId);
    const set = await store.set(newK0);
    expect(set.success).toBe(true);

    const after = await store.get();
    expect(after.success && after.data?.keyId).toBe(newKeyId);

    // Envelopes encrypted under the old key fail with a clear typed error.
    const result = decrypt(
      newK0,
      { table: 't', pk: 'a', version: 1, keyId: newKeyId },
      oldEnvelope
    );
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.type).toBe('unknown_key_id');
  });

  it('treats a corrupt stored entry as absent and removes it', async () => {
    await openStore();
    await fixture.db
      .insert(appSecrets)
      .values({
        key: SYNC_ENCRYPTION_KEY_SECRET_KEY,
        secret: Buffer.from('not-json!').toString('base64'),
      })
      .onConflictDoNothing()
      .execute();

    const after = await store.get();
    expect(after.success).toBe(true);
    if (after.success) expect(after.data).toBeNull();

    const [row] = await fixture.db
      .select({ key: appSecrets.key })
      .from(appSecrets)
      .where(eq(appSecrets.key, SYNC_ENCRYPTION_KEY_SECRET_KEY));
    expect(row).toBeUndefined();
  });

  it('treats a stored entry whose key_id does not match K0 as corrupt', async () => {
    await openStore();
    const k0 = mintK0();
    await store.set(k0);
    // Tamper with the stored key_id directly in the DB (the row exists, so
    // replace it with a mismatched entry).
    await fixture.db
      .delete(appSecrets)
      .where(eq(appSecrets.key, SYNC_ENCRYPTION_KEY_SECRET_KEY))
      .execute();
    await fixture.db
      .insert(appSecrets)
      .values({
        key: SYNC_ENCRYPTION_KEY_SECRET_KEY,
        secret: Buffer.from(
          `enc:${JSON.stringify({ keyId: 'f'.repeat(16), k0: Buffer.from(k0).toString('base64') })}`
        ).toString('base64'),
      })
      .execute();

    // Reading the entry must not mislabel decrypt failures: it is dropped.
    const after = await store.get();
    expect(after.success).toBe(true);
    if (after.success) expect(after.data).toBeNull();
  });

  it('reports persistence_failed when secure storage is unavailable', async () => {
    await openStore(true);
    const set = await store.set(mintK0());
    expect(set.success).toBe(true);

    // The OS secure store becomes unavailable later: reads must fail with a
    // typed error, not throw.
    const { EncryptedAppSecretsStore } =
      await import('@main/core/secrets/encrypted-app-secrets-store');
    const unavailableStore = new SpaceKeyStore(
      new EncryptedAppSecretsStore(fixture.db, fakeSafeStorage(false), 'darwin')
    );

    const get = await unavailableStore.get();
    expect(get.success).toBe(false);
    if (get.success) return;
    expect(get.error.type).toBe('persistence_failed');
    expect(get.error.message).toBeTruthy();
  });
});
