import { describe, expect, it } from 'vitest';
import type { ProviderUsageSnapshot } from '@shared/core/provider-usage';
import {
  formatResetTime,
  formatUpdatedAge,
  formatUsagePercent,
  getPrimaryUsageWindow,
  isUsageWarning,
} from './provider-usage-formatters';

describe('provider usage formatters', () => {
  it('selects the explicitly primary window', () => {
    const snapshot: ProviderUsageSnapshot = {
      provider: 'codex',
      lastUpdated: '2026-08-02T10:00:00.000Z',
      windows: [
        { id: 'weekly', label: 'Weekly', utilization: 10, resetsAt: null, primary: false },
        { id: 'session', label: 'Session', utilization: 20, resetsAt: null, primary: true },
      ],
    };
    expect(getPrimaryUsageWindow(snapshot)?.id).toBe('session');
  });

  it('uses the context usage warning threshold', () => {
    expect(isUsageWarning(89.9)).toBe(false);
    expect(isUsageWarning(90)).toBe(true);
  });

  it('rounds and clamps displayed utilization', () => {
    expect(formatUsagePercent(37.5)).toBe('38%');
    expect(formatUsagePercent(-1)).toBe('0%');
    expect(formatUsagePercent(101)).toBe('100%');
  });

  it('humanizes reset timestamps and stale ages', () => {
    const now = Date.parse('2026-08-02T10:00:00.000Z');
    expect(formatResetTime('2026-08-02T12:10:00.000Z', now)).toBe('resets in 2h 10m');
    expect(formatResetTime('2026-08-04T12:00:00.000Z', now)).toBe('resets in 2d 2h');
    expect(formatResetTime('2026-08-02T09:00:00.000Z', now)).toBe('reset due');
    expect(formatUpdatedAge('2026-08-02T07:45:00.000Z', now)).toBe('updated 2h ago');
  });
});
