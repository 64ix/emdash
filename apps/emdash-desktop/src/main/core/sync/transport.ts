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

export type SyncOp = 'upsert' | 'delete';

export interface SyncPatch {
  space: string;
  table: string;
  pk: string;
  version: number;
  op: SyncOp;
  deleted: boolean;
  /** Opaque encoded payload; `null` for tombstones. Never inspected by the relay. */
  body: string | null;
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
   * The client's last-known version of this row. Advisory: the relay ignores
   * it for ordering and applies last-write-wins by server receipt order.
   */
  version?: number;
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
  join(joinHash: string, name?: string): Promise<SyncJoinResult>;
  mintJoinSecret(): Promise<{ secret: string }>;
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
    private readonly baseUrl: string,
    private readonly getToken: () => Promise<string>
  ) {}

  async createSpace(name?: string): Promise<SyncSpaceCreated> {
    return this.post<SyncSpaceCreated>('/v1/space', { name }, false);
  }

  async join(joinHash: string, name?: string): Promise<SyncJoinResult> {
    return this.post<SyncJoinResult>('/v1/join', { join_hash: joinHash, name }, false);
  }

  async mintJoinSecret(): Promise<{ secret: string }> {
    return this.post<{ secret: string }>('/v1/devices/join-secret', {});
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
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (authenticated) {
      headers.authorization = `Bearer ${await this.getToken()}`;
    }
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
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
