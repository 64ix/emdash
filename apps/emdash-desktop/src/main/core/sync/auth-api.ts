/**
 * Relay authentication/space API (spec #130, ticket #135).
 *
 * A narrow interface over the relay's space, pairing, and device endpoints
 * (`POST /v1/space`, `POST /v1/space/delete`, `POST /v1/join`,
 * `POST /v1/devices/join-secret`, `GET /v1/devices`,
 * `POST /v1/devices/revoke`). The sync endpoints
 * (`/v1/sync/pull|push|poll`) are owned by the parallel ticket #133
 * (`src/main/core/sync/transport.ts`); this module deliberately does not cover
 * them so the two tickets stay independent. `PairingService` depends on this
 * interface, which the integration pass can back with #133's `RelayTransport`
 * once both land.
 *
 * Wire shapes mirror the relay exactly (apps/sync-relay/src/types.ts). Errors
 * are `Result<…, RelayApiError>`; the HTTP implementation translates relay
 * `{error}` JSON bodies into typed errors, never raw strings.
 */
import { err, ok, toSerializedError, type Result } from '@emdash/shared';
import { log } from '@main/lib/logger';
import { RELAY_REQUEST_TIMEOUT_MS, type RelayEndpoint } from './relay-config';

/** `POST /v1/space` response: the first device's own token plus a pairing secret. */
export interface RelaySpaceCreated {
  spaceId: string;
  deviceId: string;
  deviceToken: string;
  secret: string;
}

/** `POST /v1/join` response. */
export interface RelayJoinResult {
  deviceId: string;
  deviceToken: string;
  spaceId: string;
}

/** One entry of `GET /v1/devices`. */
export interface RelayDeviceInfo {
  deviceId: string;
  name: string;
  createdAt: number;
  lastSeenAt: number | null;
  revoked: boolean;
  revokedAt: number | null;
  self: boolean;
}

/**
 * Wire shapes (the relay speaks snake_case): used only to read raw JSON,
 * then mapped to the camelCase DTOs above at the API boundary.
 */
interface RelayWireSpaceCreated {
  space_id: string;
  device_id: string;
  device_token: string;
  secret: string;
}

interface RelayWireJoinResult {
  device_id: string;
  device_token: string;
  space_id: string;
}

interface RelayWireDeviceInfo {
  device_id: string;
  name: string;
  created_at: number;
  last_seen_at: number | null;
  revoked: boolean;
  revoked_at: number | null;
  self: boolean;
}

function toSpaceCreated(wire: RelayWireSpaceCreated): RelaySpaceCreated {
  return {
    spaceId: wire.space_id,
    deviceId: wire.device_id,
    deviceToken: wire.device_token,
    secret: wire.secret,
  };
}

function toJoinResult(wire: RelayWireJoinResult): RelayJoinResult {
  return {
    deviceId: wire.device_id,
    deviceToken: wire.device_token,
    spaceId: wire.space_id,
  };
}

function toDeviceInfo(wire: RelayWireDeviceInfo): RelayDeviceInfo {
  return {
    deviceId: wire.device_id,
    name: wire.name,
    createdAt: wire.created_at,
    lastSeenAt: wire.last_seen_at,
    revoked: wire.revoked,
    revokedAt: wire.revoked_at,
    self: wire.self,
  };
}

/**
 * `POST /v1/devices/join-secret` response: the echo of the registered
 * SHA-256 digest of the join credential. The secret itself is composed
 * client-side (fresh join half + the stored K0) and never sent.
 */
export interface RelaySecretResult {
  join_hash: string;
}

export type RelayApiError =
  | { type: 'invalid_join_secret'; message: string }
  | { type: 'unauthorized'; message: string }
  | { type: 'device_not_found'; message: string }
  | { type: 'relay_error'; status: number; message: string }
  | { type: 'network_error'; message: string };

/** The pairing surface of the relay, as seen by the app. */
export interface RelayAuthApi {
  createSpace(name: string): Promise<Result<RelaySpaceCreated, RelayApiError>>;
  joinSpace(
    joinHash: string,
    spaceId: string,
    name: string
  ): Promise<Result<RelayJoinResult, RelayApiError>>;
  mintJoinSecret(
    token: string,
    joinHash: string
  ): Promise<Result<RelaySecretResult, RelayApiError>>;
  listDevices(token: string): Promise<Result<RelayDeviceInfo[], RelayApiError>>;
  revokeDevice(token: string, deviceId: string): Promise<Result<void, RelayApiError>>;
  /** `POST /v1/space/delete` ("delete my data"): deletes the whole space. */
  deleteSpace(token: string): Promise<Result<void, RelayApiError>>;
}

const JSON_HEADERS = { 'content-type': 'application/json' };

export class HttpRelayAuthApi implements RelayAuthApi {
  constructor(
    /** Resolves the base URL + pre-shared key per request (env override →
     * machine-local settings), so config entered in the app takes effect
     * without a restart. */
    private readonly getEndpoint: () => Promise<RelayEndpoint>,
    private readonly timeoutMs = RELAY_REQUEST_TIMEOUT_MS
  ) {}

  async createSpace(name: string): Promise<Result<RelaySpaceCreated, RelayApiError>> {
    const result = await this.post<RelayWireSpaceCreated, { name?: string }>('/v1/space', { name });
    if (!result.success) return result;
    return ok(toSpaceCreated(result.data));
  }

  async joinSpace(
    joinHash: string,
    spaceId: string,
    name: string
  ): Promise<Result<RelayJoinResult, RelayApiError>> {
    const result = await this.post<
      RelayWireJoinResult,
      { join_hash: string; space_id: string; name?: string }
    >('/v1/join', { join_hash: joinHash, space_id: spaceId, name });
    if (!result.success) return result;
    return ok(toJoinResult(result.data));
  }

  async mintJoinSecret(
    token: string,
    joinHash: string
  ): Promise<Result<RelaySecretResult, RelayApiError>> {
    return this.post<RelaySecretResult, { join_hash: string }>(
      '/v1/devices/join-secret',
      {
        join_hash: joinHash,
      },
      token
    );
  }

  async listDevices(token: string): Promise<Result<RelayDeviceInfo[], RelayApiError>> {
    const result = await this.request<{ devices: RelayWireDeviceInfo[] }>('/v1/devices', {
      method: 'GET',
      token,
    });
    return result.success ? ok(result.data.devices.map(toDeviceInfo)) : result;
  }

  async revokeDevice(token: string, deviceId: string): Promise<Result<void, RelayApiError>> {
    const result = await this.post<{ device_id: string; revoked: boolean }, { device_id: string }>(
      '/v1/devices/revoke',
      { device_id: deviceId },
      token
    );
    return result.success ? ok() : result;
  }

  async deleteSpace(token: string): Promise<Result<void, RelayApiError>> {
    const result = await this.request<{ space_id: string; deleted: boolean; deleted_at: number }>(
      '/v1/space/delete',
      { method: 'POST', token }
    );
    return result.success ? ok() : result;
  }

  private post<TData, TBody extends Record<string, unknown> = Record<string, never>>(
    path: string,
    body: TBody,
    token?: string
  ): Promise<Result<TData, RelayApiError>> {
    return this.request<TData>(path, { method: 'POST', body, token });
  }

  private async request<TData>(
    path: string,
    options: { method: 'GET' | 'POST'; body?: unknown; token?: string }
  ): Promise<Result<TData, RelayApiError>> {
    const { baseUrl, relayKey } = await this.getEndpoint();
    let response: Response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        method: options.method,
        headers: {
          ...JSON_HEADERS,
          ...(relayKey !== undefined ? { 'X-Relay-Key': relayKey } : {}),
          ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      log.warn('sync relay request failed', { path, error });
      return err({
        type: 'network_error',
        message: toSerializedError(error).message,
      });
    }

    if (!response.ok) {
      return this.mapError(response);
    }

    try {
      return ok((await response.json()) as TData);
    } catch (error) {
      log.warn('sync relay returned a non-JSON success body', { path, error });
      return err({
        type: 'relay_error',
        status: response.status,
        message: 'The sync relay returned an unparseable response.',
      });
    }
  }

  private async mapError(response: Response): Promise<Result<never, RelayApiError>> {
    const payload = (await response.json().catch(() => null)) as { error?: string } | null;
    const message = payload?.error ?? `relay error (HTTP ${response.status})`;
    switch (response.status) {
      case 401:
        return err({
          type: message === 'invalid join secret' ? 'invalid_join_secret' : 'unauthorized',
          message,
        });
      case 404:
        // The relay 404s with `device not found in this space` only when a
        // token revokes a device of a *different* space. A bare 404 (unknown
        // route, wrong base URL, or a web page that is not the relay — e.g.
        // an unreachable/unconfigured worker behind a catch-all site) must
        // not masquerade as a removed device: surface it as a relay error so
        // the UI points at the relay configuration instead of telling the
        // user their device was deleted.
        if (message === 'device not found in this space') {
          return err({ type: 'device_not_found', message });
        }
        return err({ type: 'relay_error', status: response.status, message });
      default:
        return err({ type: 'relay_error', status: response.status, message });
    }
  }
}
