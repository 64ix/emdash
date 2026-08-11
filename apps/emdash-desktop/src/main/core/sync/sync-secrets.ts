/**
 * Reserved `app_secrets` keys for the multi-machine sync credential and
 * encryption key (spec #130, ticket #132).
 *
 * Both keys are read and written through `encryptedAppSecretsStore`
 * (`app_secrets` table, safeStorage-encrypted values): SYNC_TOKEN_SECRET_KEY
 * by `SyncCredentialsStore` (ticket #133) and SYNC_ENCRYPTION_KEY_SECRET_KEY
 * by `SpaceKeyStore` (ticket #134).
 */
export const SYNC_TOKEN_SECRET_KEY = 'sync-token';
export const SYNC_ENCRYPTION_KEY_SECRET_KEY = 'sync-encryption-key';
/**
 * The self-operated relay's URL and pre-shared key, entered by hand per
 * machine (RelaySettingsStore). Kept in `app_secrets` — not `app_settings` —
 * so the relay key is safeStorage-encrypted and neither value is ever synced
 * (app_secrets is out of the sync allowlist by design); the URL is not secret
 * but rides in the same entry to keep the pair atomic and machine-local.
 */
export const SYNC_RELAY_CONFIG_SECRET_KEY = 'sync-relay-config';
