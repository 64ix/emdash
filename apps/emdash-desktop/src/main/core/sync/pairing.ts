/**
 * Pairing service for multi-machine sync (spec #130, tickets #135 + #134).
 *
 * Attaches this machine to a relay sync space: creates a space (first device),
 * joins one with a pairing secret (second device), mints fresh pairing secrets
 * for additional devices, and lists/revokes the devices of the space. The
 * device token + space id are stored machine-locally through
 * `SyncCredentialsStore` (safeStorage); the space data key K0 is stored under
 * `SpaceKeyStore` (safeStorage, SYNC_ENCRYPTION_KEY_SECRET_KEY); the machine
 * identity comes from the `device` KV namespace (device-identity.ts).
 *
 * Pairing uses the two-half model of the spec: the pasted secret is
 * `emdj1_<space>_<join half b32>_<k0 b32>` (see crypto.ts). The join half is
 * the only half that ever transits to the relay, and only as SHA-256; K0
 * never transits and is what the sync engine derives per-row AES-256-GCM
 * keys from. Minting a secret for an additional device happens client-side:
 * a fresh join half is generated and its SHA-256 is registered with the
 * relay while K0 stays constant, so every device of the space derives the
 * same row keys.
 */
import { createHash } from 'node:crypto';
import { err, ok, type Result } from '@emdash/shared';
import { log } from '@main/lib/logger';
import {
  userFacingPairingMessage,
  type PairingErrorCode,
  type SyncDeviceInfo,
  type SyncState,
} from '@shared/core/sync/pairing';
import type { RelayApiError, RelayAuthApi } from './auth-api';
import { composeSpaceSecret, joinCredentialOf, mintJoinHalf, parseSpaceSecret } from './crypto';
import { getOrCreateDeviceIdentity, type DeviceIdentity } from './device-identity';
import type { SpaceKeyStore } from './space-key-store';
import type { SyncCredentialError, SyncCredentialsStore } from './sync-credentials';

/** The relay pairing-secret TTL and single-use/attempt semantics, surfaced to the UI. */
export const JOIN_SECRET_TTL_MS = 15 * 60_000;

export type PairingError = {
  code: PairingErrorCode;
  message: string;
  /** Present for relay/server-side failures. */
  status?: number;
};

/** Result of creating a space: the pairing secret to hand to the second machine. */
export type CreatedSpace = {
  spaceId: string;
  secret: string;
  deepLink: string;
};

/** Result of joining a space. */
export type JoinedSpace = {
  spaceId: string;
};

/** A freshly minted pairing secret for an additional device. */
export type MintedSecret = {
  secret: string;
  deepLink: string;
};

function pairingError(code: PairingErrorCode, options: { status?: number } = {}): PairingError {
  return { code, message: userFacingPairingMessage(code, options.status), status: options.status };
}

function fromApiError(error: RelayApiError): PairingError {
  switch (error.type) {
    case 'invalid_join_secret':
      return pairingError('invalid_join_secret');
    case 'unauthorized':
      return pairingError('unauthorized');
    case 'device_not_found':
      return pairingError('device_not_found');
    case 'relay_error':
      return pairingError('relay_error', { status: error.status });
    case 'network_error':
      return pairingError('network_error');
  }
}

function fromCredentialError(_error: SyncCredentialError): PairingError {
  return pairingError('persistence_failed');
}

/** `emdash://join?secret=<urlencoded>` deep link for a pairing secret. */
export function joinDeepLink(secret: string): string {
  return `emdash://join?secret=${encodeURIComponent(secret)}`;
}

type DeviceIdentityProvider = () => Promise<DeviceIdentity>;

export class PairingService {
  constructor(
    private readonly api: RelayAuthApi,
    private readonly credentials: SyncCredentialsStore,
    private readonly keys: SpaceKeyStore,
    private readonly identity: DeviceIdentityProvider = getOrCreateDeviceIdentity
  ) {}

  /** Whether this machine holds a credential, and for which space. */
  async getState(): Promise<Result<SyncState, PairingError>> {
    const credential = await this.credentials.get();
    if (!credential.success) {
      return err(fromCredentialError(credential.error));
    }
    if (credential.data === null) {
      return ok({ paired: false, spaceId: null, deviceName: null });
    }
    return ok({
      paired: true,
      spaceId: credential.data.spaceId,
      deviceName: credential.data.deviceName,
    });
  }

  /**
   * Creates a space on the relay with this machine as its first device,
   * stores the returned device token and the space data key K0 (extracted
   * from the returned pairing secret) machine-locally, and returns the
   * single-use pairing secret for the second machine.
   */
  async createSpace(deviceName?: string): Promise<Result<CreatedSpace, PairingError>> {
    const identity = await this.identity();
    const name = deviceName?.trim() || identity.deviceName;
    const result = await this.api.createSpace(name);
    if (!result.success) {
      return err(fromApiError(result.error));
    }
    const { spaceId, deviceToken, secret } = result.data;
    const parts = parseSpaceSecret(secret);
    if (parts === null || parts.spaceId !== spaceId) {
      // The relay minted the secret, so this cannot happen unless the two
      // sides disagree on the format — fail rather than store a half-broken
      // pairing state.
      return err(pairingError('invalid_secret_format'));
    }
    const stored = await this.credentials.set({ token: deviceToken, spaceId, deviceName: name });
    if (!stored.success) {
      return err(fromCredentialError(stored.error));
    }
    const keyStored = await this.keys.set(parts.k0);
    if (!keyStored.success) {
      return err(pairingError('persistence_failed'));
    }
    log.info('sync space created', { spaceId });
    return ok({ spaceId, secret, deepLink: joinDeepLink(secret) });
  }

  /**
   * Joins the space named by `secret` (an `emdj1_…` pairing secret from
   * another device): extracts the join half (presented to the relay) and K0
   * (stored locally), and stores the issued device token machine-locally.
   */
  async joinSpace(secret: string, deviceName?: string): Promise<Result<JoinedSpace, PairingError>> {
    const parts = parseSpaceSecret(secret);
    if (parts === null) {
      return err(pairingError('invalid_secret_format'));
    }
    // Guard against a mis-pasted secret silently switching this machine to a
    // different space (which would overwrite its token + K0 and drop sync with
    // its current devices). Re-joining the SAME space is fine.
    const existing = await this.credentials.get();
    if (existing.success && existing.data !== null && existing.data.spaceId !== parts.spaceId) {
      return err(pairingError('already_paired'));
    }
    const identity = await this.identity();
    const name = deviceName?.trim() || identity.deviceName;
    const result = await this.api.joinSpace(joinCredentialOf(parts.joinHalf), parts.spaceId, name);
    if (!result.success) {
      return err(fromApiError(result.error));
    }
    const spaceId = result.data.spaceId;
    const stored = await this.credentials.set({
      token: result.data.deviceToken,
      spaceId,
      deviceName: name,
    });
    if (!stored.success) {
      return err(fromCredentialError(stored.error));
    }
    const keyStored = await this.keys.set(parts.k0);
    if (!keyStored.success) {
      return err(pairingError('persistence_failed'));
    }
    log.info('joined sync space', { spaceId });
    return ok({ spaceId });
  }

  /**
   * Mints a fresh single-use pairing secret for an additional device,
   * client-side: a new join half + the space's unchanged K0. Only the
   * SHA-256 digest of the join credential is registered with the relay.
   * Requires this machine to already hold a token and the space key.
   */
  async mintSecret(): Promise<Result<MintedSecret, PairingError>> {
    const tokenResult = await this.requireToken();
    if (!tokenResult.success) {
      return tokenResult;
    }
    const keyResult = await this.requireKey();
    if (!keyResult.success) {
      return keyResult;
    }
    const { spaceId, token } = tokenResult.data;
    const joinHalf = mintJoinHalf();
    const secret = composeSpaceSecret(spaceId, joinHalf, keyResult.data.k0);
    const joinHash = createHash('sha256').update(joinCredentialOf(joinHalf), 'utf8').digest('hex');
    const result = await this.api.mintJoinSecret(token, joinHash);
    if (!result.success) {
      return err(fromApiError(result.error));
    }
    return ok({ secret, deepLink: joinDeepLink(secret) });
  }

  /** Lists the devices of the paired space. */
  async listDevices(): Promise<Result<SyncDeviceInfo[], PairingError>> {
    const tokenResult = await this.requireToken();
    if (!tokenResult.success) {
      return tokenResult;
    }
    const result = await this.api.listDevices(tokenResult.data.token);
    if (!result.success) {
      return err(fromApiError(result.error));
    }
    return ok(result.data);
  }

  /** Revokes a device of the paired space (per-device, keeps the audit row). */
  async revokeDevice(deviceId: string): Promise<Result<void, PairingError>> {
    const tokenResult = await this.requireToken();
    if (!tokenResult.success) {
      return tokenResult;
    }
    const result = await this.api.revokeDevice(tokenResult.data.token, deviceId);
    if (!result.success) {
      return err(fromApiError(result.error));
    }
    return ok();
  }

  /** The stored token, or a `not_paired` error. */
  private async requireToken(): Promise<Result<{ token: string; spaceId: string }, PairingError>> {
    const credential = await this.credentials.get();
    if (!credential.success) {
      return err(fromCredentialError(credential.error));
    }
    if (credential.data === null) {
      return err(pairingError('not_paired'));
    }
    return ok({ token: credential.data.token, spaceId: credential.data.spaceId });
  }

  /** The stored space data key, or a `not_paired` error. */
  private async requireKey(): Promise<Result<{ k0: Uint8Array }, PairingError>> {
    const key = await this.keys.get();
    if (!key.success) {
      return err(fromCredentialError(key.error));
    }
    if (key.data === null) {
      // A paired machine without a stored K0 cannot mint secrets that other
      // machines could decrypt; surface the pairing state instead of a
      // half-working mint.
      return err(pairingError('not_paired'));
    }
    return ok({ k0: key.data.k0 });
  }
}
