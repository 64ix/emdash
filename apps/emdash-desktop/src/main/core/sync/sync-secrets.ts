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
