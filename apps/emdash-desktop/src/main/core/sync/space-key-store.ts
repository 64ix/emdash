/**
 * Machine-local storage for the sync space data key (spec #130, ticket
 * #134): K0 plus its derived key_id, in one safeStorage-encrypted
 * `app_secrets` entry under `SYNC_ENCRYPTION_KEY_SECRET_KEY` — the same
 * idiom as `SyncCredentialsStore` (SYNC_TOKEN_SECRET_KEY) and the
 * `emdash-account-token` session credential.
 *
 * K0 is the AES-256-GCM space key: it never transits to the relay and is
 * backed up by design only through the pairing secret shown at space
 * creation. The key_id is derived from K0 (first 8 bytes of SHA-256), so a
 * rekey produces a new key_id without any stored counter, and old envelopes
 * are rejected with `unknown_key_id` on every other machine.
 *
 * The store holds exactly ONE key: pairing is machine-scoped to one space,
 * and joining a new space overwrites the previous key atomically.
 */
import { err, ok, toSerializedError, type Result } from '@emdash/shared';
import type { EncryptedAppSecretsStore } from '@main/core/secrets/encrypted-app-secrets-store';
import { log } from '@main/lib/logger';
import { K0_BYTES, keyIdOf } from './crypto';
import { SYNC_ENCRYPTION_KEY_SECRET_KEY } from './sync-secrets';

export type SpaceKeyStoreError = {
  type: 'persistence_failed';
  message: string;
};

/** The space data key as used by the crypto helper. */
export type SpaceKey = {
  keyId: string;
  /** The 32-byte AES-256-GCM space key. */
  k0: Uint8Array;
};

type SecretStore = Pick<EncryptedAppSecretsStore, 'getSecret' | 'setSecret' | 'deleteSecret'>;

interface StoredSpaceKey {
  keyId: string;
  /** base64 of the 32-byte key. */
  k0: string;
}

export class SpaceKeyStore {
  constructor(private readonly secrets: SecretStore) {}

  async get(): Promise<Result<SpaceKey | null, SpaceKeyStoreError>> {
    let raw: string | null;
    try {
      raw = await this.secrets.getSecret(SYNC_ENCRYPTION_KEY_SECRET_KEY);
    } catch (error) {
      log.error('Failed to read sync space key:', error);
      return err({
        type: 'persistence_failed',
        message: toSerializedError(error).message,
      });
    }
    if (raw === null) {
      return ok(null);
    }

    let parsed: Partial<StoredSpaceKey>;
    try {
      parsed = JSON.parse(raw) as Partial<StoredSpaceKey>;
    } catch {
      // A corrupt entry cannot encrypt anything; drop it so a re-pair is clean.
      await this.clear();
      return ok(null);
    }
    const k0 = typeof parsed.k0 === 'string' ? Buffer.from(parsed.k0, 'base64') : null;
    if (
      k0 === null ||
      k0.length !== K0_BYTES ||
      typeof parsed.keyId !== 'string' ||
      // The stored key_id must match the derivation from K0: a mismatch means
      // a corrupt or tampered entry, and decrypting under a wrong id would
      // mislabel every failure as `unknown_key_id`.
      parsed.keyId !== keyIdOf(k0)
    ) {
      await this.clear();
      return ok(null);
    }
    return ok({ keyId: parsed.keyId, k0 });
  }

  /** Stores K0 (deriving the key_id) atomically. */
  async set(k0: Uint8Array): Promise<Result<void, SpaceKeyStoreError>> {
    if (k0.length !== K0_BYTES) {
      return err({ type: 'persistence_failed', message: 'space key must be 32 bytes' });
    }
    const stored: StoredSpaceKey = { keyId: keyIdOf(k0), k0: Buffer.from(k0).toString('base64') };
    try {
      await this.secrets.setSecret(SYNC_ENCRYPTION_KEY_SECRET_KEY, JSON.stringify(stored));
      return ok();
    } catch (error) {
      log.error('Failed to store sync space key:', error);
      return err({
        type: 'persistence_failed',
        message: toSerializedError(error).message,
      });
    }
  }

  async clear(): Promise<Result<void, SpaceKeyStoreError>> {
    try {
      await this.secrets.deleteSecret(SYNC_ENCRYPTION_KEY_SECRET_KEY);
      return ok();
    } catch (error) {
      log.error('Failed to clear sync space key:', error);
      return err({
        type: 'persistence_failed',
        message: toSerializedError(error).message,
      });
    }
  }
}
