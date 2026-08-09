/**
 * Browser-mode tests for the first-run sync onboarding prompt (spec #130,
 * ticket #137): shown while this machine has no sync space, with "Join an
 * existing space" (paste the secret) as the PRIMARY action and "Start from
 * scratch" (create a space) as secondary. Dismissible for the session; it
 * resurfaces on the next launch while no space exists.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { SyncOnboardingPrompt } from '@renderer/features/sync/sync-onboarding-prompt';
import type { SyncStatus } from '@shared/core/sync/status';

const mocks = vi.hoisted(() => ({
  getSyncStatus: vi.fn(),
  createSpace: vi.fn(),
  onEvent: vi.fn((_channel: { name?: string }, _handler: unknown) => () => {}),
  showModal: vi.fn(),
  modalIds: [] as string[],
  toast: vi.fn(),
}));

vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    sync: {
      getSyncStatus: mocks.getSyncStatus,
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

vi.mock('@renderer/lib/hooks/use-toast', () => ({
  toast: mocks.toast,
  useToast: () => ({ toast: mocks.toast }),
}));

const IDLE: SyncStatus = {
  state: 'idle',
  paired: false,
  lastSyncAt: null,
  lastError: null,
  pendingCount: 0,
};

const PAIRED: SyncStatus = {
  state: 'up-to-date',
  paired: true,
  lastSyncAt: 1_800_000_000_000,
  lastError: null,
  pendingCount: 0,
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

describe('SyncOnboardingPrompt', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.modalIds.length = 0;
    mocks.getSyncStatus.mockResolvedValue(IDLE);

    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  // The sync-store singleton registers its event listener once per file; the
  // registered handler outlives per-test mock clearing, so capture it on the
  // first render and reuse it to push status snapshots.
  let pushStatus: ((status: SyncStatus) => void) | undefined;

  async function renderPrompt() {
    await act(async () => {
      root.render(<SyncOnboardingPrompt />);
    });
    await act(async () => settle());
    if (!pushStatus) {
      pushStatus = mocks.onEvent.mock.calls.find(
        ([channel]) => channel?.name === 'sync:status'
      )?.[1] as ((status: SyncStatus) => void) | undefined;
    }
  }

  it('shows Join (primary) vs Start from scratch (secondary) when not paired', async () => {
    await renderPrompt();

    const prompt = host.querySelector('[data-testid="sync-onboarding-prompt"]');
    expect(prompt).not.toBeNull();
    expect(prompt?.textContent).toContain('Sync this machine');
    expect(prompt?.textContent).toContain('Join an existing space');
    expect(prompt?.textContent).toContain('Start from scratch');
  });

  it('opens the join modal from the primary action', async () => {
    await renderPrompt();

    const join = host.querySelector<HTMLButtonElement>('[data-testid="sync-onboarding-join"]');
    await act(async () => {
      join?.click();
    });

    expect(mocks.modalIds).toContain('joinSyncSpaceModal');
    expect(mocks.showModal).toHaveBeenCalledWith({});
  });

  it('creates a space from the secondary action and surfaces the pairing secret', async () => {
    mocks.createSpace.mockResolvedValue({
      success: true,
      spaceId: 'ABCDEFGHIJKLMNOPQRSTUV',
      secret: 'emdj1_ABCDEFGHIJKLMNOPQRSTUV_abcdefghijklmnopqrstuv_-aBcDeF',
      deepLink: 'emdash://join?secret=emdj1_ABCDEFGHIJKLMNOPQRSTUV_abcdefghijklmnopqrstuv_-aBcDeF',
    });
    await renderPrompt();

    const create = host.querySelector<HTMLButtonElement>('[data-testid="sync-onboarding-create"]');
    await act(async () => {
      create?.click();
    });
    await act(async () => settle());

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
    await renderPrompt();

    const create = host.querySelector<HTMLButtonElement>('[data-testid="sync-onboarding-create"]');
    await act(async () => {
      create?.click();
    });
    await act(async () => settle());

    expect(mocks.toast).toHaveBeenCalledWith({
      title: 'Could not reach the sync relay. Check your connection and try again.',
      variant: 'destructive',
    });
    // The pairing-secret modal must not open: the failure stays a toast.
    expect(mocks.showModal).not.toHaveBeenCalled();
  });

  it('is dismissible for the session', async () => {
    await renderPrompt();
    expect(host.querySelector('[data-testid="sync-onboarding-prompt"]')).not.toBeNull();

    const dismiss = host.querySelector<HTMLButtonElement>('[aria-label="Dismiss sync onboarding"]');
    await act(async () => {
      dismiss?.click();
    });
    await act(async () => settle());

    expect(host.querySelector('[data-testid="sync-onboarding-prompt"]')).toBeNull();
  });

  it('hides entirely once the machine is paired', async () => {
    await renderPrompt();
    expect(host.querySelector('[data-testid="sync-onboarding-prompt"]')).not.toBeNull();

    expect(pushStatus).toBeTypeOf('function');
    await act(async () => {
      pushStatus?.(PAIRED);
    });
    await act(async () => settle());

    expect(host.querySelector('[data-testid="sync-onboarding-prompt"]')).toBeNull();
  });
});
