import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveRelayEndpoint, UNCONFIGURED_RELAY_URL } from './relay-config';
import type { RelaySettings } from './relay-settings-store';

/** A store stub returning fixed machine-local settings (or none). */
function stubStore(stored: RelaySettings | null) {
  return { get: async () => ({ success: true, data: stored }) };
}

describe('resolveRelayEndpoint', () => {
  const savedUrl = process.env.EMDASH_SYNC_RELAY_URL;
  const savedKey = process.env.EMDASH_SYNC_RELAY_KEY;

  beforeEach(() => {
    delete process.env.EMDASH_SYNC_RELAY_URL;
    delete process.env.EMDASH_SYNC_RELAY_KEY;
  });

  afterEach(() => {
    if (savedUrl === undefined) delete process.env.EMDASH_SYNC_RELAY_URL;
    else process.env.EMDASH_SYNC_RELAY_URL = savedUrl;
    if (savedKey === undefined) delete process.env.EMDASH_SYNC_RELAY_KEY;
    else process.env.EMDASH_SYNC_RELAY_KEY = savedKey;
  });

  it('falls back to the unresolvable .invalid host when nothing is configured', async () => {
    const resolved = await resolveRelayEndpoint(stubStore(null));
    expect(resolved.baseUrl).toBe(UNCONFIGURED_RELAY_URL);
    expect(resolved.relayKey).toBeUndefined();
    expect(resolved.configured).toBe(false);
    expect(resolved.envManaged).toBe(false);
  });

  it('uses the stored URL + key when present and reports configured', async () => {
    const resolved = await resolveRelayEndpoint(
      stubStore({ url: 'https://relay.example', key: 'stored-key' })
    );
    expect(resolved.baseUrl).toBe('https://relay.example');
    expect(resolved.relayKey).toBe('stored-key');
    expect(resolved.configured).toBe(true);
    expect(resolved.envManaged).toBe(false);
  });

  it('lets env vars override the stored settings and flags envManaged', async () => {
    process.env.EMDASH_SYNC_RELAY_URL = 'https://env.example';
    process.env.EMDASH_SYNC_RELAY_KEY = 'env-key';
    const resolved = await resolveRelayEndpoint(
      stubStore({ url: 'https://relay.example', key: 'stored-key' })
    );
    expect(resolved.baseUrl).toBe('https://env.example');
    expect(resolved.relayKey).toBe('env-key');
    expect(resolved.configured).toBe(true);
    expect(resolved.envManaged).toBe(true);
  });

  it('is not configured when a URL is set but no key is available', async () => {
    process.env.EMDASH_SYNC_RELAY_URL = 'https://env.example';
    const resolved = await resolveRelayEndpoint(stubStore(null));
    expect(resolved.baseUrl).toBe('https://env.example');
    expect(resolved.relayKey).toBeUndefined();
    expect(resolved.configured).toBe(false);
    expect(resolved.envManaged).toBe(true);
  });
});
