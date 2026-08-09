/**
 * Wire protocol types for the sync relay.
 *
 * The relay is an ordering relay: it receives opaque, client-encrypted row
 * bodies plus plaintext metadata, stores them verbatim, and orders them by a
 * per-space monotonic version. It never parses or interprets `body`.
 */

export interface SpaceCreated {
  space_id: string;
  device_id: string;
  device_token: string;
  /** Single-use, TTL-bounded pairing secret for a second device. */
  secret: string;
}

export interface CreateSpaceRequest {
  /** Optional display name for the first device. Defaults to "default". */
  name?: string;
}

export interface JoinRequest {
  /** The pairing secret presented by the joining device. */
  join_hash: string;
  name?: string;
}

export interface JoinResult {
  device_id: string;
  device_token: string;
}

export interface JoinSecretResult {
  secret: string;
}

export interface DeviceInfo {
  device_id: string;
  name: string;
  created_at: number;
  last_seen_at: number | null;
  revoked: boolean;
  revoked_at: number | null;
  self: boolean;
}

export interface DevicesResult {
  devices: DeviceInfo[];
}

export interface RevokeRequest {
  device_id: string;
}

export interface RevokeResult {
  device_id: string;
  revoked: boolean;
}

export interface PullRequest {
  /** Return only rows with version > cursor. Defaults to 0. */
  cursor?: number;
  /** Maximum number of patches to return. Defaults to the relay limit. */
  limit?: number;
}

export type PatchOp = 'upsert' | 'delete';

export interface Patch {
  space: string;
  table: string;
  pk: string;
  version: number;
  op: PatchOp;
  deleted: boolean;
  /** Opaque encrypted payload; `null` for tombstones. Never inspected. */
  body: string | null;
}

export interface PullResult {
  /** Next cursor: the last returned version, or the request cursor if none. */
  cursor: number;
  patches: Patch[];
}

export interface Mutation {
  table: string;
  pk: string;
  /**
   * The client's last-known version of this row. Advisory: the relay ignores
   * it for ordering and applies last-write-wins by server receipt order.
   */
  version?: number;
  /** Opaque encrypted payload; required for `upsert`, optional for `delete`. */
  body?: string | null;
  op: PatchOp;
}

export interface PushRequest {
  mutations: Mutation[];
}

export interface PushResult {
  results: Array<{
    table: string;
    pk: string;
    /** The server-assigned per-space version of the written row. */
    version: number;
  }>;
}

export interface PollRequest {
  /** Return only rows with version > cursor. Defaults to 0. */
  cursor?: number;
  /**
   * How long the relay should hold the request before answering empty.
   * Clamped to [0, 25000]; clients should reconnect with backoff.
   */
  timeout_ms?: number;
}

export interface ErrorResult {
  error: string;
}
