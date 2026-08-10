/**
 * Shared pairing types for multi-machine sync (spec #130, ticket #135).
 *
 * These are the serializable DTOs and error vocabulary shared between the
 * main-process `PairingService` (via the sync RPC controller) and the renderer
 * Devices settings screen. The wire protocol itself is defined by the relay
 * (`apps/sync-relay/src/types.ts`); this file only carries what the app needs
 * to talk about pairing, plus the user-facing error messages so the renderer
 * never has to render raw relay JSON.
 */

/** 15-minute TTL and 5-attempt budget enforced by the relay (see apps/sync-relay/src/service.ts). */
export const PAIRING_SECRET_TTL_MINUTES = 15;
export const MAX_PAIRING_ATTEMPTS = 5;

/**
 * Prefix of every relay pairing secret (spec #130, ticket #134).
 *
 * The secret carries the two halves of the space pairing material:
 * `emdj1_<space id 22>_<join half b32 26>_<k0 b32 52>` (108 chars). The join
 * half is the only half that ever transits to the relay (and only as
 * SHA-256); K0 — the space data key for AES-256-GCM row encryption — travels
 * only inside the pasted secret, machine to machine.
 */
export const JOIN_SECRET_PREFIX = 'emdj1_';

/**
 * The machine-local relay connection state surfaced to the Settings form.
 * This fork ships no default relay: the user enters the URL + pre-shared key
 * per machine (or overrides them with env vars). The key is never sent back to
 * the renderer — only whether one is set.
 */
export type RelaySettingsView = {
  /** The configured relay URL (env or stored), or null when unconfigured. */
  url: string | null;
  /** Whether a pre-shared key is set (the value itself never leaves the main process). */
  hasKey: boolean;
  /** Both URL and key present — sync can run. */
  configured: boolean;
  /** Managed by env vars, so the in-app form is read-only. */
  envManaged: boolean;
};

/** A device as listed by the relay (`GET /v1/devices`). */
export type SyncDeviceInfo = {
  deviceId: string;
  name: string;
  createdAt: number;
  lastSeenAt: number | null;
  revoked: boolean;
  revokedAt: number | null;
  /** Whether this is the device whose token is stored on this machine. */
  self: boolean;
};

/** The machine-local pairing state surfaced to the renderer. */
export type SyncState = {
  /** Whether this machine holds a device token for a sync space. */
  paired: boolean;
  /** The space id, when paired. */
  spaceId: string | null;
  /** The human device name registered with the relay, when paired. */
  deviceName: string | null;
};

/**
 * Machine-readable pairing error codes. The relay deliberately returns the
 * same 401 for every stale/invalid secret (single-use, TTL, attempt budget are
 * indistinguishable on purpose), so `invalid_join_secret` covers all three;
 * the granular codes exist for test doubles and for errors the client can
 * detect itself.
 */
export type PairingErrorCode =
  | 'invalid_secret_format'
  | 'invalid_join_secret'
  | 'unauthorized'
  | 'device_not_found'
  | 'not_paired'
  | 'persistence_failed'
  | 'relay_error'
  | 'network_error';

/** Human-readable explanation for a pairing error code. Never raw JSON. */
export function userFacingPairingMessage(code: PairingErrorCode, status?: number): string {
  switch (code) {
    case 'invalid_secret_format':
      return `That doesn't look like a pairing secret. Copy the full secret (it starts with \u201c${JOIN_SECRET_PREFIX}\u201d) from the other device.`;
    case 'invalid_join_secret':
      return `This pairing secret is invalid, already used, or expired. Secrets are single-use and expire ${PAIRING_SECRET_TTL_MINUTES} minutes after they are created \u2014 ask the device owner to generate a new one.`;
    case 'unauthorized':
      return 'This device is no longer authorized to access the sync space (its token was revoked or is invalid). Create a new space or join again with a fresh pairing secret.';
    case 'device_not_found':
      return 'That device was not found in this sync space. It may have been removed already.';
    case 'not_paired':
      return 'This machine is not paired with a sync space yet.';
    case 'persistence_failed':
      return 'Could not save the device credentials securely on this machine.';
    case 'relay_error':
      return `The sync relay returned an error (HTTP ${status ?? 'unknown'}). Try again in a moment.`;
    case 'network_error':
      return 'Could not reach the sync relay. Check your connection and try again.';
  }
}
