import type {
  PairingErrorCode,
  RelaySettingsView,
  SyncDeviceInfo,
  SyncState,
} from '@shared/core/sync/pairing';
import type { SyncStatus } from '@shared/core/sync/status';
/**
 * RPC controller for sync pairing (spec #130, ticket #135): the renderer-side
 * surface of `PairingService`. Every method returns plain serializable
 * payloads; expected failures come back as `{ success: false, code, message }`
 * with a user-facing `message` (never raw relay JSON).
 *
 * Ticket #137 adds the daily-sync surface: `getSyncStatus` and `syncNow` back
 * the sidebar status widget's store (plus the `sync:status` event).
 */
import { createRPCController } from '@shared/lib/ipc/rpc';
import { pairingService } from './pairing-service-instance';
import { UNCONFIGURED_RELAY_URL } from './relay-config';
import { getRelayEndpoint, relaySettingsStore } from './relay-endpoint-provider';
import { syncService } from './sync-service-instance';

type RelaySettingsSaved = { success: true } | { success: false; message: string };

type PairingFailure = { success: false; code: PairingErrorCode; message: string };

type PairingCreated = { success: true; spaceId: string; secret: string; deepLink: string };
type PairingJoined = { success: true; spaceId: string };
type PairingMinted = { success: true; secret: string; deepLink: string };
type PairingRevoked = { success: true };

function failure(error: { code: PairingErrorCode; message: string }): PairingFailure {
  return { success: false, code: error.code, message: error.message };
}

export const syncController = createRPCController({
  /** The machine-local relay connection settings (URL + whether a key is set). */
  getRelaySettings: async (): Promise<RelaySettingsView> => {
    const resolved = await getRelayEndpoint();
    return {
      url: resolved.baseUrl === UNCONFIGURED_RELAY_URL ? null : resolved.baseUrl,
      hasKey: resolved.relayKey !== undefined,
      configured: resolved.configured,
      envManaged: resolved.envManaged,
    };
  },

  /** Saves the relay URL + pre-shared key on this machine (safeStorage). */
  setRelaySettings: async (input: { url: string; key: string }): Promise<RelaySettingsSaved> => {
    const url = input.url.trim();
    const key = input.key.trim();
    if (!/^https:\/\/[^\s]+$/i.test(url)) {
      return { success: false, message: 'Enter a valid https:// relay URL.' };
    }
    if (key === '') {
      return { success: false, message: 'Enter the relay key.' };
    }
    const result = await relaySettingsStore.set({ url, key });
    if (!result.success) {
      return { success: false, message: result.error.message };
    }
    // Pick up the new endpoint on the next cycle without a restart.
    syncService.kick();
    return { success: true };
  },

  /** Clears the machine-local relay settings (does not un-pair). */
  clearRelaySettings: async (): Promise<{ success: true }> => {
    await relaySettingsStore.clear();
    return { success: true };
  },

  /** Whether this machine is paired, and with which space. */
  getState: async (): Promise<SyncState> => {
    const result = await pairingService.getState();
    if (!result.success) {
      return { paired: false, spaceId: null, deviceName: null };
    }
    return result.data;
  },

  /** Creates a space with this machine as its first device; returns the pairing secret. */
  createSpace: async (deviceName?: string): Promise<PairingCreated | PairingFailure> => {
    const result = await pairingService.createSpace(deviceName);
    if (!result.success) return failure(result.error);
    // A fresh space is syncable right away; start the engine immediately.
    syncService.kick();
    return { success: true, ...result.data };
  },

  /** Joins a space with a pasted pairing secret. */
  joinSpace: async (
    secret: string,
    deviceName?: string
  ): Promise<PairingJoined | PairingFailure> => {
    const result = await pairingService.joinSpace(secret, deviceName);
    if (!result.success) return failure(result.error);
    // First sync of a joined machine: pull the space's rows and push local ones.
    syncService.kick();
    return { success: true, spaceId: result.data.spaceId };
  },

  /** The current sync status snapshot (widget store bootstrap). */
  getSyncStatus: async (): Promise<SyncStatus> => {
    return syncService.getStatus();
  },

  /** Runs a sync cycle now and returns the resulting status. */
  syncNow: async (): Promise<SyncStatus> => {
    await syncService.syncNow();
    return syncService.getStatus();
  },

  /** Mints a fresh single-use pairing secret for an additional device. */
  mintSecret: async (): Promise<PairingMinted | PairingFailure> => {
    const result = await pairingService.mintSecret();
    if (!result.success) return failure(result.error);
    return { success: true, ...result.data };
  },

  /** Lists the devices of the paired space. */
  listDevices: async (): Promise<{ success: true; devices: SyncDeviceInfo[] } | PairingFailure> => {
    const result = await pairingService.listDevices();
    if (!result.success) return failure(result.error);
    return { success: true, devices: result.data };
  },

  /** Revokes a device of the paired space. */
  revokeDevice: async (deviceId: string): Promise<PairingRevoked | PairingFailure> => {
    const result = await pairingService.revokeDevice(deviceId);
    if (!result.success) return failure(result.error);
    return { success: true };
  },
});
