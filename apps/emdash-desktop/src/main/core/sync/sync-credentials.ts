/**
 * Machine-local storage for the sync space credential (spec #130, ticket
 * #135): the relay device token and the space id it belongs to.
 *
 * Both values live in one safeStorage-encrypted `app_secrets` entry under
 * `SYNC_TOKEN_SECRET_KEY` (`app_secrets` table via `encryptedAppSecretsStore`,
 * the same idiom as the `emdash-account-token` session credential). The space
 * id is not secret, but keeping it in the same entry as the token makes the
 * pair atomic — there is never a window where a token is stored without its
 * space — and avoids adding a second secrets key. The machine-local `device`
 * KV namespace (device-identity.ts) stays reserved for the device identity.
 */
import { err, ok, toSerializedError, type Result } from '@emdash/shared';
import type { EncryptedAppSecretsStore } from '@main/core/secrets/encrypted-app-secrets-store';
import { log } from '@main/lib/logger';
import { SYNC_TOKEN_SECRET_KEY } from './sync-secrets';

export type SyncCredentialError = {
  type: 'persistence_failed';
  message: string;
};

/** The stored machine-local sync credential. */
export type SyncCredential = {
  /** The relay device token (`emdv1_…`), sent as `Authorization: Bearer`. */
  token: string;
  /** The relay space id the token is scoped to. */
  spaceId: string;
  /** The human device name this machine registered with the relay. */
  deviceName: string;
};

type SecretStore = Pick<EncryptedAppSecretsStore, 'getSecret' | 'setSecret' | 'deleteSecret'>;

export class SyncCredentialsStore {
  constructor(private readonly secrets: SecretStore) {}

  async get(): Promise<Result<SyncCredential | null, SyncCredentialError>> {
    let raw: string | null;
    try {
      raw = await this.secrets.getSecret(SYNC_TOKEN_SECRET_KEY);
    } catch (error) {
      log.error('Failed to read sync credential:', error);
      return err({
        type: 'persistence_failed',
        message: toSerializedError(error).message,
      });
    }
    if (raw === null) {
      return ok(null);
    }

    let parsed: Partial<SyncCredential>;
    try {
      parsed = JSON.parse(raw) as Partial<SyncCredential>;
    } catch {
      // A corrupt entry cannot authenticate; drop it so a re-pair is clean.
      await this.clear();
      return ok(null);
    }
    if (
      typeof parsed.token !== 'string' ||
      parsed.token === '' ||
      typeof parsed.spaceId !== 'string' ||
      parsed.spaceId === ''
    ) {
      // A malformed entry cannot authenticate; drop it so a re-pair is clean.
      await this.clear();
      return ok(null);
    }
    return ok({
      token: parsed.token,
      spaceId: parsed.spaceId,
      // Older entries predate the device name field; tolerate their absence.
      deviceName: typeof parsed.deviceName === 'string' ? parsed.deviceName : '',
    });
  }

  async set(credential: SyncCredential): Promise<Result<void, SyncCredentialError>> {
    try {
      await this.secrets.setSecret(
        SYNC_TOKEN_SECRET_KEY,
        JSON.stringify({
          token: credential.token,
          spaceId: credential.spaceId,
          deviceName: credential.deviceName,
        })
      );
      return ok();
    } catch (error) {
      log.error('Failed to store sync credential:', error);
      return err({
        type: 'persistence_failed',
        message: toSerializedError(error).message,
      });
    }
  }

  async clear(): Promise<Result<void, SyncCredentialError>> {
    try {
      await this.secrets.deleteSecret(SYNC_TOKEN_SECRET_KEY);
      return ok();
    } catch (error) {
      log.error('Failed to clear sync credential:', error);
      return err({
        type: 'persistence_failed',
        message: toSerializedError(error).message,
      });
    }
  }
}
