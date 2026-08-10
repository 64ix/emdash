/**
 * Relay endpoint configuration for multi-machine sync (spec #130).
 *
 * The relay is a self-operated Cloudflare Worker (see apps/sync-relay/); it has
 * no repo-owned deployment, so the operator MUST set `EMDASH_SYNC_RELAY_URL` to
 * their own relay. When it is unset we deliberately fall back to a reserved,
 * unresolvable `.invalid` host (RFC 6761) rather than a plausible real domain:
 * `emdash.sh` is upstream product infrastructure the fork explicitly does not
 * use for sync identity, and silently defaulting there would send device tokens
 * and pairing traffic to a host the user never chose to trust. The `.invalid`
 * default fails fast at pairing time instead; `configured` lets callers surface
 * a clear "set EMDASH_SYNC_RELAY_URL" message.
 */
export const SYNC_RELAY_CONFIG = {
  configured: process.env.EMDASH_SYNC_RELAY_URL != null,
  baseUrl: process.env.EMDASH_SYNC_RELAY_URL ?? 'https://sync-relay.unconfigured.invalid',
  requestTimeoutMs: 10_000,
};
