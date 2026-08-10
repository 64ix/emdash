/**
 * The app-wide relay endpoint provider (spec #130): one machine-local
 * `RelaySettingsStore` (safeStorage) plus a resolver that env vars override.
 * Transports and the pairing service read the endpoint fresh per request, so a
 * URL/key entered in Settings takes effect without an app restart.
 */
import { encryptedAppSecretsStore } from '@main/core/secrets/encrypted-app-secrets-store';
import { type ResolvedRelayEndpoint, resolveRelayEndpoint } from './relay-config';
import { RelaySettingsStore } from './relay-settings-store';

export const relaySettingsStore = new RelaySettingsStore(encryptedAppSecretsStore);

/** Resolves the effective endpoint (env → stored → unconfigured) per call. */
export function getRelayEndpoint(): Promise<ResolvedRelayEndpoint> {
  return resolveRelayEndpoint(relaySettingsStore);
}
