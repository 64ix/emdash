import { encryptedAppSecretsStore } from '@main/core/secrets/encrypted-app-secrets-store';
import { HttpRelayAuthApi } from './auth-api';
import { PairingService } from './pairing';
import { getRelayEndpoint } from './relay-endpoint-provider';
import { SpaceKeyStore } from './space-key-store';
import { SyncCredentialsStore } from './sync-credentials';

/** The app-wide pairing service: HTTP relay + safeStorage credentials and space key. */
export const pairingService = new PairingService(
  new HttpRelayAuthApi(getRelayEndpoint),
  new SyncCredentialsStore(encryptedAppSecretsStore),
  new SpaceKeyStore(encryptedAppSecretsStore)
);
