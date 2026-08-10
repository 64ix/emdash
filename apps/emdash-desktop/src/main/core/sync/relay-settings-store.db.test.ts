import { openFixture } from '@tooling/utils/db';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';

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

const mocks = vi.hoisted(() => ({ db: undefined as AppDb | undefined }));
vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));

import { RelaySettingsStore } from './relay-settings-store';

/** Fake safeStorage: deterministic obscured round trip (matches sync-credentials tests). */
function fakeSafeStorage() {
  return {
    isEncryptionAvailable: () => true,
    setUsePlainTextEncryption: (_usePlainText: boolean) => {},
    encryptString: (plain: string) => Buffer.from(`enc:${plain}`, 'utf8'),
    decryptString: (encrypted: Buffer) => encrypted.toString('utf8').slice(4),
    getSelectedStorageBackend: () => 'kwallet' as const,
  };
}

describe('relay settings storage (safeStorage-backed app_secrets)', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;
  let store: RelaySettingsStore;

  afterEach(() => {
    fixture?.close();
  });

  async function openStore(): Promise<void> {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
    const { EncryptedAppSecretsStore } =
      await import('@main/core/secrets/encrypted-app-secrets-store');
    store = new RelaySettingsStore(
      new EncryptedAppSecretsStore(fixture.db, fakeSafeStorage(), 'darwin')
    );
  }

  it('returns null before anything is stored', async () => {
    await openStore();
    const result = await store.get();
    expect(result.success && result.data).toBeNull();
  });

  it('round-trips the URL and key', async () => {
    await openStore();
    const set = await store.set({ url: 'https://relay.example', key: 'a-relay-key' });
    expect(set.success).toBe(true);
    const got = await store.get();
    expect(got.success && got.data).toEqual({ url: 'https://relay.example', key: 'a-relay-key' });
  });

  it('drops a malformed (missing key) entry on read', async () => {
    await openStore();
    // Write a partial payload directly through the underlying secrets store.
    const { EncryptedAppSecretsStore } =
      await import('@main/core/secrets/encrypted-app-secrets-store');
    const secrets = new EncryptedAppSecretsStore(fixture.db, fakeSafeStorage(), 'darwin');
    const { SYNC_RELAY_CONFIG_SECRET_KEY } = await import('./sync-secrets');
    await secrets.setSecret(SYNC_RELAY_CONFIG_SECRET_KEY, JSON.stringify({ url: 'https://x' }));
    const got = await store.get();
    expect(got.success && got.data).toBeNull();
  });

  it('clears the stored settings', async () => {
    await openStore();
    await store.set({ url: 'https://relay.example', key: 'a-relay-key' });
    await store.clear();
    const got = await store.get();
    expect(got.success && got.data).toBeNull();
  });
});
