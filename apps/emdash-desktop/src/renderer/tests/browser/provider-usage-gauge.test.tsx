import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderUsageGauge } from '@renderer/features/provider-usage/provider-usage-gauges';
import type { ProviderUsageSnapshot } from '@shared/core/provider-usage';

const snapshot: ProviderUsageSnapshot = {
  provider: 'claude',
  windows: [
    {
      id: 'five-hour',
      label: '5-hour session',
      utilization: 42,
      resetsAt: '2026-08-06T12:00:00.000Z',
      primary: true,
    },
  ],
  lastUpdated: '2026-08-06T10:00:00.000Z',
};

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

async function settle(frames = 2) {
  for (let i = 0; i < frames; i++) await frame();
}

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

describe('ProviderUsageGauge', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it('closes its details without hiding the usage gauge', async () => {
    await act(async () => {
      root.render(
        <ProviderUsageGauge
          snapshot={snapshot}
          refreshing={false}
          onRefresh={vi.fn().mockResolvedValue(undefined)}
        />
      );
    });

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[aria-label^="Claude usage:"]')!.click();
      await settle();
    });
    expect(document.body.textContent).toContain('Claude usageLocal account');

    await act(async () => {
      document
        .querySelector<HTMLButtonElement>('[aria-label="Close Claude usage details"]')!
        .click();
      await settle();
    });

    expect(document.body.textContent).not.toContain('Claude usageLocal account');
    expect(host.querySelector('[aria-label^="Claude usage:"]')).not.toBeNull();
  });
});
