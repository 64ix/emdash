import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { KV } from '@main/db/kv';

export interface DeviceIdentity {
  deviceId: string;
  deviceName: string;
}

type DeviceKVSchema = {
  id: string;
  name: string;
};

/**
 * Machine-local device identity for multi-machine sync (spec #130, ticket
 * #132). Lives in the `kv` table under the `device:` namespace
 * (`device:id`, `device:name`) — deliberately separate from the telemetry
 * `instanceId` (`telemetry:instanceId`), which is a posthog install id and
 * not a device identity.
 *
 * Nothing calls this from app startup wiring yet: the sync engine (ticket
 * #133) is expected to invoke it when it needs to identify this machine to a
 * sync space.
 */
const deviceKV = new KV<DeviceKVSchema>('device');

/**
 * Returns the stable device identity for this machine, creating and
 * persisting it on first use. The id is a fresh UUID; the name defaults to
 * the OS hostname. Both are JSON-encoded values in the machine-local `kv`
 * table and are never synced to other machines.
 */
export async function getOrCreateDeviceIdentity(): Promise<DeviceIdentity> {
  let deviceId = await deviceKV.get('id');
  if (!deviceId) {
    deviceId = randomUUID();
    await deviceKV.set('id', deviceId);
  }

  let deviceName = await deviceKV.get('name');
  if (!deviceName) {
    deviceName = os.hostname();
    await deviceKV.set('name', deviceName);
  }

  return { deviceId, deviceName };
}
