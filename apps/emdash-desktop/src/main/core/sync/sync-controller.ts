import type { PairingErrorCode, SyncDeviceInfo, SyncState } from '@shared/core/sync/pairing';
/**
 * RPC controller for sync pairing (spec #130, ticket #135): the renderer-side
 * surface of `PairingService`. Every method returns plain serializable
 * payloads; expected failures come back as `{ success: false, code, message }`
 * with a user-facing `message` (never raw relay JSON).
 */
import { createRPCController } from '@shared/lib/ipc/rpc';
import { pairingService } from './pairing-service-instance';

type PairingFailure = { success: false; code: PairingErrorCode; message: string };

function failure(error: { code: PairingErrorCode; message: string }): PairingFailure {
  return { success: false, code: error.code, message: error.message };
}

export const syncController = createRPCController({
  /** Whether this machine is paired, and with which space. */
  getState: async (): Promise<SyncState> => {
    const result = await pairingService.getState();
    if (!result.success) {
      return { paired: false, spaceId: null, deviceName: null };
    }
    return result.data;
  },

  /** Creates a space with this machine as its first device; returns the pairing secret. */
  createSpace: async (deviceName?: string) => {
    const result = await pairingService.createSpace(deviceName);
    if (!result.success) return failure(result.error);
    return { success: true, spaceId: result.data.spaceId, ...result.data };
  },

  /** Joins a space with a pasted pairing secret. */
  joinSpace: async (secret: string, deviceName?: string) => {
    const result = await pairingService.joinSpace(secret, deviceName);
    if (!result.success) return failure(result.error);
    return { success: true, spaceId: result.data.spaceId };
  },

  /** Mints a fresh single-use pairing secret for an additional device. */
  mintSecret: async () => {
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
  revokeDevice: async (deviceId: string) => {
    const result = await pairingService.revokeDevice(deviceId);
    if (!result.success) return failure(result.error);
    return { success: true };
  },
});
