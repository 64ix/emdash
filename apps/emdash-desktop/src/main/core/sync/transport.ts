/**
 * Sync relay transport (spec #130, ticket #133).
 *
 * The relay (apps/sync-relay, @emdash/sync-relay) is an ordering relay: it
 * stores opaque, client-encoded row bodies plus plaintext metadata and orders
 * them by a per-space monotonic version. The engine talks to it ONLY through
 * this interface, so every behavioural property (push/pull, tombstones,
 * conflict ordering, dirty-row preservation, version skew) is testable against
 * an in-process fake with the same semantics.
 *
 * The wire types below mirror apps/sync-relay/src/types.ts; the app does not
 * depend on the relay package at runtime (the seam is the interface).
 */
import { log } from '@main/lib/logger';
import type { RelayEndpoint } from './relay-config';

export type SyncOp = 'upsert' | 'delete';

export interface SyncPatch {
  space: string;
  table: string;
  pk: string;
  /** The per-space monotonic version stamped by the relay at write time. */
  version: number;
  /**
   * The version the encrypting machine bound into the body's AEAD AAD (its
   * last-known version of the row, or 0). Stored verbatim by the relay, so
   * replaying an old body under newer metadata fails decryption.
   */
  client_version: number;
  op: SyncOp;
  deleted: boolean;
  /** Opaque encoded payload; `null` for tombstones. Never inspected by the relay. */
  body: string | null;
  /**
   * Set by encrypting transports when a body could not be decrypted
   * (unknown key id after a rekey, tampering, AAD mismatch). The engine
   * records the patch's version and skips it instead of wedging the pull.
   */
  decryptError?: string;
}

export interface SyncPullResult {
  /** Next cursor: the last returned version, or the request cursor if none. */
  cursor: number;
  patches: SyncPatch[];
}

export interface SyncMutation {
  table: string;
  pk: string;
  /**
   * The client's last-known version of this row (0 for never-synced rows).
   * The relay stores it verbatim as `client_version` and ignores it for
   * ordering (last-write-wins by server receipt order). Encrypting
   * transports bind it into the body's AEAD AAD.
   */
  client_version: number;
  body?: string | null;
  op: SyncOp;
}

export interface SyncPushResult {
  results: Array<{ table: string; pk: string; version: number }>;
}

export interface SyncSpaceCreated {
  space_id: string;
  device_id: string;
  device_token: string;
  /** Single-use, TTL-bounded pairing secret for a second device. */
  secret: string;
}

export interface SyncJoinResult {
  device_id: string;
  device_token: string;
  space_id: string;
}

export interface SyncDeviceInfo {
  device_id: string;
  name: string;
  created_at: number;
  last_seen_at: number | null;
  revoked: boolean;
  revoked_at: number | null;
  self: boolean;
}

/** Raised by HTTP transports when the relay answers with a non-2xx status. */
export class RelayHttpError extends Error {
  constructor(
    public readonly status: number,
    message: string
  ) {
    super(message);
    this.name = 'RelayHttpError';
  }
}

/**
 * The full relay API as methods. The engine itself only uses push/pull; the
 * pairing/device endpoints are exercised by the space-management tickets
 * (spec #130, #135) and are part of the same seam.
 */
export interface RelayTransport {
  createSpace(name?: string): Promise<SyncSpaceCreated>;
  /**
   * Joins a space with the base32 join credential extracted from the pairing
   * secret, plus the space id the client parsed from that secret (the relay
   * attributes failed attempts to the named space).
   */
  join(joinHash: string, spaceId: string, name?: string): Promise<SyncJoinResult>;
  /**
   * Registers a client-minted join credential: `joinHash` is the SHA-256 hex
   * digest of the base32 join credential (K0 never transits).
   */
  mintJoinSecret(joinHash: string): Promise<{ join_hash: string }>;
  listDevices(): Promise<{ devices: SyncDeviceInfo[] }>;
  revokeDevice(deviceId: string): Promise<{ device_id: string; revoked: boolean }>;
  push(mutations: SyncMutation[]): Promise<SyncPushResult>;
  pull(cursor: number, limit?: number): Promise<SyncPullResult>;
  poll(cursor: number, timeoutMs?: number): Promise<SyncPullResult>;
}

/**
 * fetch-based transport against a relay base URL, carrying the device bearer
 * token on every authenticated request.
 */
export class HttpRelayTransport implements RelayTransport {
  constructor(
    /** Resolves the base URL and pre-shared key per request (env override →
     * machine-local settings), so config entered in the app takes effect
     * without a restart. The key rides as `X-Relay-Key` on every request so
     * the operator's relay can refuse strangers even on the unauthenticated
     * endpoints (space creation, join). */
    private readonly getEndpoint: () => Promise<RelayEndpoint>,
    private readonly getToken: () => Promise<string>
  ) {}

  async createSpace(name?: string): Promise<SyncSpaceCreated> {
    return this.post<SyncSpaceCreated>('/v1/space', { name }, false);
  }

  async join(joinHash: string, spaceId: string, name?: string): Promise<SyncJoinResult> {
    return this.post<SyncJoinResult>(
      '/v1/join',
      { join_hash: joinHash, space_id: spaceId, name },
      false
    );
  }

  async mintJoinSecret(joinHash: string): Promise<{ join_hash: string }> {
    return this.post<{ join_hash: string }>('/v1/devices/join-secret', { join_hash: joinHash });
  }

  async listDevices(): Promise<{ devices: SyncDeviceInfo[] }> {
    return this.post<{ devices: SyncDeviceInfo[] }>('/v1/devices', {});
  }

  async revokeDevice(deviceId: string): Promise<{ device_id: string; revoked: boolean }> {
    return this.post<{ device_id: string; revoked: boolean }>('/v1/devices/revoke', {
      device_id: deviceId,
    });
  }

  async push(mutations: SyncMutation[]): Promise<SyncPushResult> {
    return this.post<SyncPushResult>('/v1/sync/push', { mutations });
  }

  async pull(cursor: number, limit?: number): Promise<SyncPullResult> {
    return this.post<SyncPullResult>('/v1/sync/pull', { cursor, limit });
  }

  async poll(cursor: number, timeoutMs?: number): Promise<SyncPullResult> {
    return this.post<SyncPullResult>('/v1/sync/poll', { cursor, timeout_ms: timeoutMs });
  }

  private async post<T>(path: string, body: unknown, authenticated = true): Promise<T> {
    const { baseUrl, relayKey } = await this.getEndpoint();
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (relayKey !== undefined) {
      headers['x-relay-key'] = relayKey;
    }
    if (authenticated) {
      headers.authorization = `Bearer ${await this.getToken()}`;
    }
    let response: Response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw new RelayHttpError(0, `relay unreachable: ${String(error)}`);
    }
    const text = await response.text();
    if (!response.ok) {
      log.warn('[sync] relay request failed', { path, status: response.status, body: text });
      throw new RelayHttpError(response.status, text || response.statusText);
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new RelayHttpError(response.status, 'relay returned non-JSON response');
    }
  }
}
