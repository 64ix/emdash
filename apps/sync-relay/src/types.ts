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
  /**
   * The join credential presented by the joining device: the base32 join
   * half extracted from the pairing secret (26 chars). The relay compares
   * SHA-256 of this value against the stored digests of the named space.
   */
  join_hash: string;
  /** The space to join, extracted from the pairing secret by the client. */
  space_id: string;
  name?: string;
}

export interface JoinResult {
  device_id: string;
  device_token: string;
  space_id: string;
}

export interface JoinSecretResult {
  /** Echo of the registered SHA-256 digest of the join credential. */
  join_hash: string;
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
  /** The per-space monotonic version stamped by the relay at write time. */
  version: number;
  /**
   * The version the client encrypted the body under (its last-known version
   * of the row, or 0). Stored verbatim; decrypting clients bind it into the
   * AES-GCM AAD, so replaying an old body under newer metadata fails.
   */
  client_version: number;
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
   * The client's last-known version of this row. Stored verbatim as
   * `client_version` and returned on pull; the relay ignores it for ordering
   * and applies last-write-wins by server receipt order.
   */
  client_version?: number;
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
