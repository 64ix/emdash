/**
 * Relay endpoint resolution for multi-machine sync (spec #130).
 *
 * This fork ships NO default relay: the sync relay is a self-operated
 * Cloudflare Worker (see apps/sync-relay/README.md), and the repo is public, so
 * baking in a URL or key would (a) be worthless as a secret and (b) point every
 * build at the maintainer's personal relay. Each machine is configured by hand:
 *
 * - **In the app** (Settings → Devices): URL + pre-shared key, stored
 *   machine-locally in `app_secrets` via `RelaySettingsStore` (never synced).
 * - **Or by environment** (dev / power users): `EMDASH_SYNC_RELAY_URL` and
 *   `EMDASH_SYNC_RELAY_KEY` — these OVERRIDE the stored values when set.
 *
 * The key is a gate on the operator's own infrastructure and free-tier quota,
 * not a data secret (row bodies are already E2E-encrypted); it travels only
 * over TLS as `X-Relay-Key`. When neither source supplies a URL we resolve a
 * reserved, unresolvable `.invalid` host (RFC 6761) so sync fails fast and
 * loudly instead of reaching some real domain.
 */
import type { RelaySettings } from './relay-settings-store';

export const UNCONFIGURED_RELAY_URL = 'https://sync-relay.unconfigured.invalid';
export const RELAY_REQUEST_TIMEOUT_MS = 10_000;

/** The relay connection details a transport needs for a single request. */
export type RelayEndpoint = { baseUrl: string; relayKey?: string };

/** The resolved endpoint plus what the UI needs to explain the current state. */
export type ResolvedRelayEndpoint = RelayEndpoint & {
  /** Both a URL and a key are available — sync can actually run. */
  configured: boolean;
  /** At least one value comes from an env var, so the app UI is read-only. */
  envManaged: boolean;
};

type RelaySettingsReader = {
  get: () => Promise<{ success: boolean; data?: RelaySettings | null }>;
};

/**
 * Resolves the effective relay endpoint: env vars win, then the machine-local
 * stored settings, then the unconfigured `.invalid` fallback.
 */
export async function resolveRelayEndpoint(
  store: RelaySettingsReader
): Promise<ResolvedRelayEndpoint> {
  const result = await store.get();
  const stored = result.success ? (result.data ?? null) : null;

  const envUrl = process.env.EMDASH_SYNC_RELAY_URL;
  const envKey = process.env.EMDASH_SYNC_RELAY_KEY;
  const url = envUrl ?? stored?.url ?? null;
  const relayKey = envKey ?? stored?.key ?? undefined;

  return {
    baseUrl: url ?? UNCONFIGURED_RELAY_URL,
    relayKey,
    configured: url !== null && relayKey !== undefined,
    envManaged: envUrl != null || envKey != null,
  };
}
