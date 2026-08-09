import { encryptedAppSecretsStore } from '@main/core/secrets/encrypted-app-secrets-store';
import { HttpRelayAuthApi } from './auth-api';
import { PairingService } from './pairing';
import { SyncCredentialsStore } from './sync-credentials';

/** The app-wide pairing service: HTTP relay + safeStorage credentials. */
export const pairingService = new PairingService(
  new HttpRelayAuthApi(),
  new SyncCredentialsStore(encryptedAppSecretsStore)
);
