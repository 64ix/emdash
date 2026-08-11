/**
 * Machine-local storage for the self-operated relay's connection settings
 * (spec #130): the relay base URL and its pre-shared key, entered by hand on
 * each machine (this fork ships no default relay — see relay-config.ts).
 *
 * Both live in one safeStorage-encrypted `app_secrets` entry under
 * `SYNC_RELAY_CONFIG_SECRET_KEY` — the same idiom as `SyncCredentialsStore`.
 * The URL is not secret, but keeping it beside the key makes the pair atomic,
 * keeps it out of the sync allowlist (never synced), and avoids a second
 * settings surface. Environment variables still override these at resolve
 * time (see `resolveRelayEndpoint`).
 */
import { err, ok, toSerializedError, type Result } from '@emdash/shared';
import type { EncryptedAppSecretsStore } from '@main/core/secrets/encrypted-app-secrets-store';
import { log } from '@main/lib/logger';
import { SYNC_RELAY_CONFIG_SECRET_KEY } from './sync-secrets';

export type RelaySettingsError = {
  type: 'persistence_failed';
  message: string;
};

/** The stored machine-local relay connection settings. */
export type RelaySettings = {
  /** The self-operated relay origin, e.g. `https://relay.example.workers.dev`. */
  url: string;
  /** The pre-shared relay key, sent as `X-Relay-Key`. */
  key: string;
};

type SecretStore = Pick<EncryptedAppSecretsStore, 'getSecret' | 'setSecret' | 'deleteSecret'>;

export class RelaySettingsStore {
  constructor(private readonly secrets: SecretStore) {}

  async get(): Promise<Result<RelaySettings | null, RelaySettingsError>> {
    let raw: string | null;
    try {
      raw = await this.secrets.getSecret(SYNC_RELAY_CONFIG_SECRET_KEY);
    } catch (error) {
      log.error('Failed to read relay settings:', error);
      return err({ type: 'persistence_failed', message: toSerializedError(error).message });
    }
    if (raw === null) {
      return ok(null);
    }
    let parsed: Partial<RelaySettings>;
    try {
      parsed = JSON.parse(raw) as Partial<RelaySettings>;
    } catch {
      await this.clear();
      return ok(null);
    }
    if (
      typeof parsed.url !== 'string' ||
      parsed.url === '' ||
      typeof parsed.key !== 'string' ||
      parsed.key === ''
    ) {
      await this.clear();
      return ok(null);
    }
    return ok({ url: parsed.url, key: parsed.key });
  }

  async set(settings: RelaySettings): Promise<Result<void, RelaySettingsError>> {
    try {
      await this.secrets.setSecret(
        SYNC_RELAY_CONFIG_SECRET_KEY,
        JSON.stringify({ url: settings.url, key: settings.key })
      );
      return ok();
    } catch (error) {
      log.error('Failed to store relay settings:', error);
      return err({ type: 'persistence_failed', message: toSerializedError(error).message });
    }
  }

  async clear(): Promise<Result<void, RelaySettingsError>> {
    try {
      await this.secrets.deleteSecret(SYNC_RELAY_CONFIG_SECRET_KEY);
      return ok();
    } catch (error) {
      log.error('Failed to clear relay settings:', error);
      return err({ type: 'persistence_failed', message: toSerializedError(error).message });
    }
  }
}
