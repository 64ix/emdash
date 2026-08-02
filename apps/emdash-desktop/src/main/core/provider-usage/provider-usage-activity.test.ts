import { describe, expect, it } from 'vitest';
import { providerUsageProviderForActivityEvent } from './provider-usage-activity-event';
import { isLocalProviderUsageActivity } from './provider-usage-activity-locality';

describe('provider usage activity locality', () => {
  it('accepts modern and legacy local workspaces', () => {
    expect(
      isLocalProviderUsageActivity({ location: 'local', type: 'local', legacyProvider: null })
    ).toBe(true);
    expect(
      isLocalProviderUsageActivity({ location: null, type: 'local', legacyProvider: 'local' })
    ).toBe(true);
  });

  it('rejects every modern and legacy representation of an SSH workspace', () => {
    expect(
      isLocalProviderUsageActivity({ location: 'remote', type: 'byoi', legacyProvider: null })
    ).toBe(false);
    expect(
      isLocalProviderUsageActivity({ location: null, type: 'project-ssh', legacyProvider: null })
    ).toBe(false);
    expect(
      isLocalProviderUsageActivity({ location: null, type: 'byoi', legacyProvider: 'ssh' })
    ).toBe(false);
    expect(
      isLocalProviderUsageActivity({ location: null, type: 'byoi', legacyProvider: null })
    ).toBe(false);
    expect(
      isLocalProviderUsageActivity({ location: null, type: 'local', legacyProvider: 'byoi' })
    ).toBe(false);
  });

  it('does not assume an unresolved activity belongs to the local machine', () => {
    expect(isLocalProviderUsageActivity(undefined)).toBe(false);
  });

  it('refreshes supported providers at both ends of a turn', () => {
    expect(providerUsageProviderForActivityEvent({ type: 'start', providerId: 'claude' })).toBe(
      'claude'
    );
    expect(providerUsageProviderForActivityEvent({ type: 'stop', providerId: 'codex' })).toBe(
      'codex'
    );
    expect(
      providerUsageProviderForActivityEvent({ type: 'notification', providerId: 'codex' })
    ).toBeNull();
    expect(
      providerUsageProviderForActivityEvent({ type: 'stop', providerId: 'gemini' })
    ).toBeNull();
  });
});
