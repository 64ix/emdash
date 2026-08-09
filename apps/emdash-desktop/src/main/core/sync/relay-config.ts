/**
 * Relay endpoint configuration for multi-machine sync (spec #130).
 *
 * The relay is a self-operated Cloudflare Worker (see apps/sync-relay/); its
 * public URL is not fixed by any repo-owned deployment, so the operator sets
 * `EMDASH_SYNC_RELAY_URL` and the app falls back to the conventional host.
 */
export const SYNC_RELAY_CONFIG = {
  baseUrl: process.env.EMDASH_SYNC_RELAY_URL ?? 'https://sync-relay.emdash.sh',
  requestTimeoutMs: 10_000,
};
