import { app } from 'electron';
import { createProjectAutoAttachHook } from '@main/core/projects/auto-attach';
import { encryptedAppSecretsStore } from '@main/core/secrets/encrypted-app-secrets-store';
import { sqlite } from '@main/db/client';
import { events } from '@main/lib/events';
import { syncStatusChannel } from '@shared/events/syncEvents';
import { getOrCreateDeviceIdentity } from './device-identity';
import { SYNC_RELAY_CONFIG } from './relay-config';
import { SpaceKeyStore } from './space-key-store';
import { SyncCredentialsStore } from './sync-credentials';
import { SyncService } from './sync-service';
import { HttpRelayTransport } from './transport';

/**
 * The app-wide sync service (spec #130, ticket #137): HTTP relay transport
 * with the safeStorage device token, E2E encryption when the space key K0 is
 * stored, the auto-attach hook for freshly imported projects, status events
 * through `events.emit` (window-liveness guarded by the main emitter), and OS
 * connectivity hooks (`app` `online`/`offline` events).
 *
 * The credential/key stores are constructed here (not via `pairingService`):
 * both stores are thin stateless wrappers over the same `app_secrets` entries
 * (`sync-token`, `sync-encryption-key`), so separate instances stay coherent.
 */
const credentials = new SyncCredentialsStore(encryptedAppSecretsStore);
const spaceKeys = new SpaceKeyStore(encryptedAppSecretsStore);

export const syncService = new SyncService({
  sqlite,
  getCredentials: () => credentials.get(),
  getSpaceKey: () => spaceKeys.get(),
  getDeviceIdentity: getOrCreateDeviceIdentity,
  createTransport: (token) => new HttpRelayTransport(SYNC_RELAY_CONFIG.baseUrl, async () => token),
  projectAttachHook: createProjectAutoAttachHook(),
  onStatusChange: (status) => events.emit(syncStatusChannel, status),
  connectivity: {
    // Electron emits 'online'/'offline' on the app at runtime (network
    // availability changes); the shipped App type only models a subset of
    // events, so the app object is viewed as its runtime EventEmitter base.
    onOnline: (callback) => {
      const emitter = app as unknown as NodeJS.EventEmitter;
      emitter.on('online', callback);
      return () => emitter.removeListener('online', callback);
    },
    onOffline: (callback) => {
      const emitter = app as unknown as NodeJS.EventEmitter;
      emitter.on('offline', callback);
      return () => emitter.removeListener('offline', callback);
    },
  },
});
