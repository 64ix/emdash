/**
 * Relay authentication/space API (spec #130, ticket #135).
 *
 * A narrow interface over the relay's space, pairing, and device endpoints
 * (`POST /v1/space`, `POST /v1/join`, `POST /v1/devices/join-secret`,
 * `GET /v1/devices`, `POST /v1/devices/revoke`). The sync endpoints
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
import { SYNC_RELAY_CONFIG } from './relay-config';

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
}

const JSON_HEADERS = { 'content-type': 'application/json' };

export class HttpRelayAuthApi implements RelayAuthApi {
  constructor(
    private readonly baseUrl = SYNC_RELAY_CONFIG.baseUrl,
    private readonly timeoutMs = SYNC_RELAY_CONFIG.requestTimeoutMs,
    private readonly relayKey = SYNC_RELAY_CONFIG.relayKey
  ) {}

  async createSpace(name: string): Promise<Result<RelaySpaceCreated, RelayApiError>> {
    return this.post<RelaySpaceCreated, { name?: string }>('/v1/space', { name });
  }

  async joinSpace(
    joinHash: string,
    spaceId: string,
    name: string
  ): Promise<Result<RelayJoinResult, RelayApiError>> {
    return this.post<RelayJoinResult, { join_hash: string; space_id: string; name?: string }>(
      '/v1/join',
      { join_hash: joinHash, space_id: spaceId, name }
    );
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
    const result = await this.request<{ devices: RelayDeviceInfo[] }>('/v1/devices', {
      method: 'GET',
      token,
    });
    return result.success ? ok(result.data.devices) : result;
  }

  async revokeDevice(token: string, deviceId: string): Promise<Result<void, RelayApiError>> {
    const result = await this.post<{ device_id: string; revoked: boolean }, { device_id: string }>(
      '/v1/devices/revoke',
      { device_id: deviceId },
      token
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
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: options.method,
        headers: {
          ...JSON_HEADERS,
          ...(this.relayKey !== undefined ? { 'X-Relay-Key': this.relayKey } : {}),
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
        return err({ type: 'device_not_found', message });
      default:
        return err({ type: 'relay_error', status: response.status, message });
    }
  }
}
