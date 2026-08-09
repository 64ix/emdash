/**
 * Pairing service for multi-machine sync (spec #130, ticket #135).
 *
 * Attaches this machine to a relay sync space: creates a space (first device),
 * joins one with a pairing secret (second device), mints fresh pairing secrets
 * for additional devices, and lists/revokes the devices of the space. The
 * device token + space id are stored machine-locally through
 * `SyncCredentialsStore` (safeStorage); the machine identity comes from the
 * `device` KV namespace (device-identity.ts).
 *
 * Join credential derivation matches the relay exactly
 * (apps/sync-relay/src/crypto.ts + service.ts): the relay mints a secret
 * `emdj1_<space>_<random>_<checksum>`, stores only SHA-256 of the full
 * credential, and matches presented credentials by hashing what the client
 * sends. So the client's join credential is simply `sha256(trimmedSecret)`,
 * hex — the relay itself parses the secret to attribute the attempt to the
 * space. The K0/HKDF halves of the spec's end-to-end crypto are ticket #134's
 * scope and are deliberately not derived here.
 */
import { createHash } from 'node:crypto';
import { err, ok, type Result } from '@emdash/shared';
import { log } from '@main/lib/logger';
import {
  JOIN_SECRET_PREFIX,
  userFacingPairingMessage,
  type PairingErrorCode,
  type SyncDeviceInfo,
  type SyncState,
} from '@shared/core/sync/pairing';
import type { RelayApiError, RelayAuthApi } from './auth-api';
import { getOrCreateDeviceIdentity, type DeviceIdentity } from './device-identity';
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

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * The relay's join-secret layout (apps/sync-relay/src/crypto.ts):
 * `emdj1_<space id 22>_<random 22>_<checksum 6>` = 57 chars total. The client
 * mirrors the length check so obviously truncated/pasted-together strings are
 * rejected locally; the checksum itself is verified by the relay. Ticket #134
 * may extend this format with the K0 half — keep this constant in sync with
 * the relay's `parseJoinSecret` when it does.
 */
const RELAY_JOIN_SECRET_LENGTH = JOIN_SECRET_PREFIX.length + 22 + 1 + 22 + 1 + 6;

/**
 * Derives the join credential from a pasted pairing secret, matching the
 * relay's verification exactly: the client sends SHA-256 (hex) of the full
 * secret string; the relay parses the secret to attribute the attempt and
 * compares digests. `null` when the secret does not even look like one (wrong
 * prefix or wrong length) — the relay is the authority on checksum/TTL/attempt
 * validity.
 */
export function deriveJoinHash(secret: string): string | null {
  const trimmed = secret.trim();
  if (!trimmed.startsWith(JOIN_SECRET_PREFIX) || trimmed.length !== RELAY_JOIN_SECRET_LENGTH) {
    return null;
  }
  return sha256Hex(trimmed);
}

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
   * stores the returned device token machine-locally, and returns the
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
    const stored = await this.credentials.set({ token: deviceToken, spaceId, deviceName: name });
    if (!stored.success) {
      return err(fromCredentialError(stored.error));
    }
    log.info('sync space created', { spaceId });
    return ok({ spaceId, secret, deepLink: joinDeepLink(secret) });
  }

  /**
   * Joins the space named by `secret` (a `emdj1_…` pairing secret from
   * another device), storing the issued device token machine-locally.
   */
  async joinSpace(secret: string, deviceName?: string): Promise<Result<JoinedSpace, PairingError>> {
    const joinHash = deriveJoinHash(secret);
    if (joinHash === null) {
      return err(pairingError('invalid_secret_format'));
    }
    const identity = await this.identity();
    const name = deviceName?.trim() || identity.deviceName;
    const result = await this.api.joinSpace(joinHash, name);
    if (!result.success) {
      return err(fromApiError(result.error));
    }
    const spaceId = extractSpaceId(secret);
    const stored = await this.credentials.set({
      token: result.data.deviceToken,
      spaceId,
      deviceName: name,
    });
    if (!stored.success) {
      return err(fromCredentialError(stored.error));
    }
    log.info('joined sync space', { spaceId });
    return ok({ spaceId });
  }

  /**
   * Mints a fresh single-use pairing secret for an additional device. Requires
   * this machine to already hold a valid token for the space.
   */
  async mintSecret(): Promise<Result<MintedSecret, PairingError>> {
    const tokenResult = await this.requireToken();
    if (!tokenResult.success) {
      return tokenResult;
    }
    const result = await this.api.mintJoinSecret(tokenResult.data.token);
    if (!result.success) {
      return err(fromApiError(result.error));
    }
    return ok({ secret: result.data.secret, deepLink: joinDeepLink(result.data.secret) });
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
  private async requireToken(): Promise<Result<{ token: string }, PairingError>> {
    const credential = await this.credentials.get();
    if (!credential.success) {
      return err(fromCredentialError(credential.error));
    }
    if (credential.data === null) {
      return err(pairingError('not_paired'));
    }
    return ok({ token: credential.data.token });
  }
}

/**
 * The relay embeds the space id in the pairing secret
 * (`emdj1_<space_id>_<random>_<checksum>`); re-derive it on the client so the
 * stored credential knows its space without an extra round trip. The relay is
 * the authority — this is only for the local credential record. 22 characters
 * matches `SPACE_ID_CHARS` in apps/sync-relay/src/crypto.ts.
 */
const RELAY_SPACE_ID_CHARS = 22;

function extractSpaceId(secret: string): string {
  const body = secret.trim().slice(JOIN_SECRET_PREFIX.length);
  return body.slice(0, RELAY_SPACE_ID_CHARS);
}
