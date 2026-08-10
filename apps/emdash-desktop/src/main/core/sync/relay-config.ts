/**
 * Relay endpoint configuration for multi-machine sync (spec #130).
 *
 * This fork ships NO default relay: the sync relay is a self-operated
 * Cloudflare Worker (see apps/sync-relay/README.md), and the repo is public, so
 * baking in a URL or key would (a) be worthless as a secret and (b) point every
 * build at the maintainer's personal relay. Instead each machine is configured
 * by hand — today via env vars, per the README:
 *
 * - `EMDASH_SYNC_RELAY_URL` — the operator's own relay origin. Unset ⇒ a
 *   reserved, unresolvable `.invalid` host (RFC 6761) so pairing fails fast and
 *   loudly instead of silently reaching some real domain.
 * - `EMDASH_SYNC_RELAY_KEY` — the pre-shared relay key. The relay rejects every
 *   request without a matching `X-Relay-Key` header (see the Worker), so a
 *   stranger who discovers the (public) URL still cannot create spaces or push
 *   data and burn the operator's free-tier quota. The key is a gate on the
 *   operator's infrastructure, not a data secret (row bodies are already E2E
 *   encrypted); it is sent only over TLS and never persisted server-side in
 *   the clear.
 *
 * `configured` is true only when both are set, so callers can surface a clear
 * "configure your relay" state rather than failing cryptically.
 */
export const SYNC_RELAY_CONFIG = {
  baseUrl: process.env.EMDASH_SYNC_RELAY_URL ?? 'https://sync-relay.unconfigured.invalid',
  relayKey: process.env.EMDASH_SYNC_RELAY_KEY,
  requestTimeoutMs: 10_000,
  configured:
    process.env.EMDASH_SYNC_RELAY_URL != null && process.env.EMDASH_SYNC_RELAY_KEY != null,
};
