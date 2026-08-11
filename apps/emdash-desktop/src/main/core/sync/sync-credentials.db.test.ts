import { openFixture } from '@tooling/utils/db';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import { appSecrets } from '@main/db/schema';
import { SYNC_TOKEN_SECRET_KEY } from './sync-secrets';

// `sync-credentials.ts` logs through the main-process logger, whose import
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

import { SyncCredentialsStore, type SyncCredential } from './sync-credentials';

/** Fake safeStorage: deterministic base64-obscured round trip. */
function fakeSafeStorage(
  available = true,
  backend: 'basic_text' | 'gnome_libsecret' | 'kwallet' | 'unknown' = 'kwallet'
) {
  return {
    isEncryptionAvailable: () => available,
    setUsePlainTextEncryption: (_usePlainText: boolean) => {},
    encryptString: (plain: string) => Buffer.from(`enc:${plain}`, 'utf8'),
    decryptString: (encrypted: Buffer) => encrypted.toString('utf8').slice(4),
    getSelectedStorageBackend: () => backend,
  };
}

describe('sync credentials storage (safeStorage-backed app_secrets)', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;
  let store: SyncCredentialsStore;

  afterEach(() => {
    fixture?.close();
  });

  async function openStore(available = true): Promise<void> {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
    const { EncryptedAppSecretsStore } =
      await import('@main/core/secrets/encrypted-app-secrets-store');
    store = new SyncCredentialsStore(
      new EncryptedAppSecretsStore(fixture.db, fakeSafeStorage(available), 'darwin')
    );
  }

  const credential: SyncCredential = {
    token: 'emdv1_token_abcd',
    spaceId: 'space-22-chars-000',
    deviceName: 'office-mac',
  };

  it('round-trips token and space id through the encrypted store', async () => {
    await openStore();

    const before = await store.get();
    expect(before.success).toBe(true);
    if (before.success) expect(before.data).toBeNull();

    const set = await store.set(credential);
    expect(set.success).toBe(true);

    const after = await store.get();
    expect(after.success).toBe(true);
    if (!after.success) return;
    expect(after.data).toEqual(credential);

    // The value is stored under the reserved sync-token key, encrypted
    // (base64 of the safeStorage ciphertext — never the plaintext).
    const [row] = await fixture.db
      .select({ key: appSecrets.key, secret: appSecrets.secret })
      .from(appSecrets)
      .where(eq(appSecrets.key, SYNC_TOKEN_SECRET_KEY));
    expect(row?.key).toBe(SYNC_TOKEN_SECRET_KEY);
    expect(Buffer.from(row!.secret, 'base64').toString('utf8').startsWith('enc:')).toBe(true);
    expect(row!.secret).not.toContain(credential.token);
  });

  it('overwrites a previous credential atomically', async () => {
    await openStore();
    await store.set(credential);
    const replacement: SyncCredential = {
      token: 'emdv1_other_xyz',
      spaceId: 'other-space-0000',
      deviceName: 'second',
    };

    const set = await store.set(replacement);
    expect(set.success).toBe(true);

    const after = await store.get();
    expect(after.success && after.data).toEqual(replacement);
  });

  it('clears the stored credential', async () => {
    await openStore();
    await store.set(credential);

    const cleared = await store.clear();
    expect(cleared.success).toBe(true);

    const after = await store.get();
    expect(after.success && after.data).toBeNull();
  });

  it('treats a malformed stored entry as absent and removes it', async () => {
    await openStore();
    await fixture.db
      .insert(appSecrets)
      .values({ key: SYNC_TOKEN_SECRET_KEY, secret: Buffer.from('not-json!').toString('base64') })
      .onConflictDoNothing()
      .execute();

    const after = await store.get();
    expect(after.success).toBe(true);
    if (after.success) expect(after.data).toBeNull();

    const [row] = await fixture.db
      .select({ key: appSecrets.key })
      .from(appSecrets)
      .where(eq(appSecrets.key, SYNC_TOKEN_SECRET_KEY));
    expect(row).toBeUndefined();
  });

  it('reports persistence_failed when secure storage is unavailable', async () => {
    await openStore(true);
    const set = await store.set(credential);
    expect(set.success).toBe(true);

    // The OS secure store becomes unavailable later: reads of the stored
    // credential must fail with a typed error, not throw.
    const { EncryptedAppSecretsStore } =
      await import('@main/core/secrets/encrypted-app-secrets-store');
    const unavailableStore = new SyncCredentialsStore(
      new EncryptedAppSecretsStore(fixture.db, fakeSafeStorage(false), 'darwin')
    );

    const get = await unavailableStore.get();
    expect(get.success).toBe(false);
    if (get.success) return;
    expect(get.error.type).toBe('persistence_failed');
    expect(get.error.message).toBeTruthy();
  });
});
