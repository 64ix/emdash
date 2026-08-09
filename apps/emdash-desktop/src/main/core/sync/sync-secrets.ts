/**
 * Reserved `app_secrets` keys for the multi-machine sync credential and
 * encryption key (spec #130, ticket #132).
 *
 * The keys are reserved in the schema sense only — no code writes or reads
 * them yet. The sync engine (ticket #133) will store and retrieve them
 * through `encryptedAppSecretsStore` (`app_secrets` table, safeStorage-
 * encrypted values) without any further schema change.
 */
export const SYNC_TOKEN_SECRET_KEY = 'sync-token';
export const SYNC_ENCRYPTION_KEY_SECRET_KEY = 'sync-encryption-key';
