/**
 * Browser-mode tests for the sync status widget (spec #130, ticket #137):
 * the four widget states (syncing / up-to-date / offline-with-pending /
 * error), the always-visible "Sync now" action, the pending badge, the
 * popover detail (last successful sync + errors), and the two pre-pairing
 * surfaces: the relay-unconfigured row (redirect to Settings → Devices) and
 * the onboarding actions (Join / Start from scratch) inside the idle popover.
 * The store is driven by pushing `SyncStatus` snapshots through the mocked
 * `sync:status` event — the same contract the main-process SyncService emits.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SyncStatusWidget } from '@renderer/features/sync/sync-status-widget';
import type { SyncStatus } from '@shared/core/sync/status';

const mocks = vi.hoisted(() => ({
  getSyncStatus: vi.fn(),
  syncNow: vi.fn(),
  createSpace: vi.fn(),
  onEvent: vi.fn((_channel: { name?: string }, _handler: unknown) => () => {}),
  showModal: vi.fn(),
  modalIds: [] as string[],
  navigate: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    sync: {
      getSyncStatus: mocks.getSyncStatus,
      syncNow: mocks.syncNow,
      createSpace: mocks.createSpace,
    },
  },
  events: { on: mocks.onEvent },
}));

vi.mock('@renderer/lib/modal/modal-provider', () => ({
  useShowModal: (id: string) => {
    mocks.modalIds.push(id);
    return mocks.showModal;
  },
}));

vi.mock('@renderer/lib/layout/navigation-provider', () => ({
  useNavigate: () => ({ navigate: mocks.navigate }),
}));

vi.mock('@renderer/lib/hooks/use-toast', () => ({
  toast: mocks.toast,
  useToast: () => ({ toast: mocks.toast }),
}));

const UP_TO_DATE: SyncStatus = {
  state: 'up-to-date',
  paired: true,
  lastSyncAt: 1_800_000_000_000,
  lastError: null,
  pendingCount: 0,
  relayConfigured: true,
};

const SYNCING: SyncStatus = { ...UP_TO_DATE, state: 'syncing' };

const OFFLINE: SyncStatus = {
  state: 'offline-with-pending',
  paired: true,
  lastSyncAt: 1_700_000_000_000,
  lastError: null,
  pendingCount: 3,
  relayConfigured: true,
};

const ERROR: SyncStatus = {
  state: 'error',
  paired: true,
  lastSyncAt: 1_700_000_000_000,
  lastError: 'The sync relay returned an error. Try again in a moment.',
  pendingCount: 1,
  relayConfigured: true,
};

const IDLE: SyncStatus = {
  state: 'idle',
  paired: false,
  lastSyncAt: null,
  lastError: null,
  pendingCount: 0,
  relayConfigured: true,
};

const NOT_SET_UP: SyncStatus = {
  ...IDLE,
  relayConfigured: false,
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

describe('SyncStatusWidget', () => {
  let host: HTMLDivElement;
  let root: Root;
  // The sync-store singleton registers its event listener once per file; the
  // registered handler outlives per-test mock clearing, so capture it on the
  // first render and reuse it to push status snapshots.
  let pushStatus: ((status: SyncStatus) => void) | undefined;

  let currentStatus: SyncStatus = UP_TO_DATE;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.modalIds.length = 0;
    // The widget refreshes on popover open, so getSyncStatus must echo the
    // status the test pushed last (same contract as the main service).
    mocks.getSyncStatus.mockImplementation(() => Promise.resolve(currentStatus));
    mocks.syncNow.mockResolvedValue(UP_TO_DATE);
    currentStatus = UP_TO_DATE;

    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  async function renderWidget() {
    await act(async () => {
      root.render(<SyncStatusWidget />);
    });
    await act(async () => settle());
    if (!pushStatus) {
      pushStatus = mocks.onEvent.mock.calls.find(
        ([channel]) => channel?.name === 'sync:status'
      )?.[1] as ((status: SyncStatus) => void) | undefined;
    }
  }

  function setStatus(status: SyncStatus): void {
    currentStatus = status;
    expect(pushStatus).toBeTypeOf('function');
    act(() => {
      pushStatus?.(status);
    });
  }

  it('shows the up-to-date state with last-sync detail in the popover', async () => {
    await renderWidget();

    const trigger = host.querySelector<HTMLButtonElement>('[aria-label^="Sync status:"]');
    expect(trigger?.getAttribute('aria-label')).toContain('Everything is synced');
    expect(host.querySelector('[data-testid="sync-pending-badge"]')).toBeNull();

    await act(async () => {
      trigger?.click();
      await settle();
    });

    const text = document.body.textContent ?? '';
    expect(text).toContain('Everything is synced');
    expect(text).toContain('Last sync');
    expect(text).toContain('ago');
  });

  it('shows the syncing state and disables the sync action', async () => {
    await renderWidget();
    setStatus(SYNCING);

    expect(
      host.querySelector('[aria-label^="Sync status:"]')?.getAttribute('aria-label')
    ).toContain('Syncing…');
    const button = host.querySelector<HTMLButtonElement>('[data-testid="sync-now-button"]');
    expect(button?.disabled).toBe(true);
  });

  it('shows the offline-with-pending badge with the pending count', async () => {
    await renderWidget();
    setStatus(OFFLINE);

    const badge = host.querySelector('[data-testid="sync-pending-badge"]');
    expect(badge?.textContent).toBe('3');

    const trigger = host.querySelector<HTMLButtonElement>('[aria-label^="Sync status:"]');
    await act(async () => {
      trigger?.click();
      await settle();
    });

    expect(document.body.textContent).toContain('3 changes waiting to sync');
  });

  it('shows the error state with the error message in the popover', async () => {
    await renderWidget();
    setStatus(ERROR);

    expect(
      host.querySelector('[aria-label^="Sync status:"]')?.getAttribute('aria-label')
    ).toContain('Sync error');

    const trigger = host.querySelector<HTMLButtonElement>('[aria-label^="Sync status:"]');
    await act(async () => {
      trigger?.click();
      await settle();
    });

    expect(document.body.textContent).toContain('The sync relay returned an error.');
  });

  it('runs a sync through the always-visible Sync now action', async () => {
    await renderWidget();

    const button = host.querySelector<HTMLButtonElement>('[data-testid="sync-now-button"]');
    await act(async () => {
      button?.click();
    });
    await act(async () => settle());

    expect(mocks.syncNow).toHaveBeenCalled();
  });

  it('surfaces the join modal (primary onboarding action) when not paired', async () => {
    await renderWidget();
    setStatus(IDLE);

    const button = host.querySelector<HTMLButtonElement>('[data-testid="sync-now-button"]');
    await act(async () => {
      button?.click();
    });

    expect(mocks.syncNow).not.toHaveBeenCalled();
    expect(mocks.modalIds).toContain('joinSyncSpaceModal');
    expect(mocks.showModal).toHaveBeenCalledWith({});
  });

  it('shows the onboarding actions (Join / Start from scratch) in the idle popover', async () => {
    await renderWidget();
    setStatus(IDLE);

    const trigger = host.querySelector<HTMLButtonElement>('[aria-label^="Sync status:"]');
    await act(async () => {
      trigger?.click();
      await settle();
    });

    const text = document.body.textContent ?? '';
    expect(text).toContain('Not paired with a sync space');
    expect(text).toContain('Join an existing space');
    expect(text).toContain('Start from scratch');

    const join = document.querySelector<HTMLButtonElement>('[data-testid="sync-popover-join"]');
    await act(async () => {
      join?.click();
      await settle();
    });

    expect(mocks.modalIds).toContain('joinSyncSpaceModal');
    expect(mocks.showModal).toHaveBeenCalledWith({});
  });

  it('creates a space from the idle popover and surfaces the pairing secret', async () => {
    mocks.createSpace.mockResolvedValue({
      success: true,
      spaceId: 'ABCDEFGHIJKLMNOPQRSTUV',
      secret: 'emdj1_ABCDEFGHIJKLMNOPQRSTUV_abcdefghijklmnopqrstuv_-aBcDeF',
      deepLink: 'emdash://join?secret=emdj1_ABCDEFGHIJKLMNOPQRSTUV_abcdefghijklmnopqrstuv_-aBcDeF',
    });
    await renderWidget();
    setStatus(IDLE);

    const trigger = host.querySelector<HTMLButtonElement>('[aria-label^="Sync status:"]');
    await act(async () => {
      trigger?.click();
      await settle();
    });

    const create = document.querySelector<HTMLButtonElement>('[data-testid="sync-popover-create"]');
    await act(async () => {
      create?.click();
      await settle();
    });

    expect(mocks.createSpace).toHaveBeenCalled();
    expect(mocks.modalIds).toContain('pairingSecretModal');
    expect(mocks.showModal).toHaveBeenCalledWith(
      expect.objectContaining({ secret: expect.stringContaining('emdj1_') })
    );
  });

  it('surfaces create-space failures as toasts, never raw JSON', async () => {
    mocks.createSpace.mockResolvedValue({
      success: false,
      code: 'network_error',
      message: 'Could not reach the sync relay. Check your connection and try again.',
    });
    await renderWidget();
    setStatus(IDLE);

    const trigger = host.querySelector<HTMLButtonElement>('[aria-label^="Sync status:"]');
    await act(async () => {
      trigger?.click();
      await settle();
    });

    const create = document.querySelector<HTMLButtonElement>('[data-testid="sync-popover-create"]');
    await act(async () => {
      create?.click();
      await settle();
    });

    expect(mocks.toast).toHaveBeenCalledWith({
      title: 'Could not reach the sync relay. Check your connection and try again.',
      variant: 'destructive',
    });
    // The pairing-secret modal must not open: the failure stays a toast.
    expect(mocks.showModal).not.toHaveBeenCalled();
  });

  it('shows "Sync isn\'t set up" and navigates to the relay settings when unconfigured', async () => {
    await renderWidget();
    setStatus(NOT_SET_UP);

    const row = host.querySelector<HTMLButtonElement>('[data-testid="sync-setup-required"]');
    expect(row).not.toBeNull();
    expect(row?.textContent).toContain('Sync isn');
    expect(row?.textContent).toContain('set up');
    // The sync actions are gone in this state: no join button, no popover.
    expect(host.querySelector('[data-testid="sync-now-button"]')).toBeNull();

    await act(async () => {
      row?.click();
    });

    expect(mocks.navigate).toHaveBeenCalledWith('settings', { tab: 'devices' });
    expect(mocks.syncNow).not.toHaveBeenCalled();
    expect(mocks.showModal).not.toHaveBeenCalled();
  });

  it('hides the not-set-up row once the relay is configured', async () => {
    await renderWidget();
    setStatus(NOT_SET_UP);
    expect(host.querySelector('[data-testid="sync-setup-required"]')).not.toBeNull();

    setStatus(IDLE);

    expect(host.querySelector('[data-testid="sync-setup-required"]')).toBeNull();
    expect(host.querySelector('[data-testid="sync-now-button"]')).not.toBeNull();
  });
});
