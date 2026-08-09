/**
 * Browser-mode tests for the Settings "Devices" card (spec #130, ticket #135).
 *
 * The card is a thin view over the sync RPC surface, so the relay behavior
 * itself is covered by the main-process `PairingService` tests; here we assert
 * the renderer flows: unpaired vs paired states, create-space surfacing the
 * pairing secret + deep link in a modal, minting a secret for an extra
 * device, and listing devices with self/revoked badges. Revocation goes
 * through the house confirmation dialog and `rpc.sync.revokeDevice`.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DevicesSettingsCard } from '@renderer/features/settings/components/DevicesSettingsCard';
import { SyncDeepLinkHandler } from '@renderer/features/settings/sync-deep-link-handler';
import { ModalRenderer } from '@renderer/lib/modal/modal-renderer';
import { modalStore } from '@renderer/lib/modal/modal-store';
import type { SyncDeviceInfo, SyncState } from '@shared/core/sync/pairing';

const mocks = vi.hoisted(() => {
  // The appState singleton (pulled in via the modal registry) boots at import
  // time, so the ssh RPC mocks need default implementations before any test
  // runs — `vi.clearAllMocks()` in beforeEach resets them per test, but the
  // import-time `load()` only happens once.
  const getConnections = vi.fn().mockResolvedValue([]);
  const getHealthStates = vi.fn().mockResolvedValue({});
  const getConnectionState = vi.fn().mockResolvedValue({});
  return {
    getState: vi.fn(),
    createSpace: vi.fn(),
    joinSpace: vi.fn(),
    mintSecret: vi.fn(),
    listDevices: vi.fn(),
    revokeDevice: vi.fn(),
    getConnections,
    getHealthStates,
    getConnectionState,
    toast: vi.fn(),
    onEvent: vi.fn((_channel: { name?: string }, _handler: unknown) => () => {}),
  };
});

vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    sync: {
      getState: mocks.getState,
      createSpace: mocks.createSpace,
      joinSpace: mocks.joinSpace,
      mintSecret: mocks.mintSecret,
      listDevices: mocks.listDevices,
      revokeDevice: mocks.revokeDevice,
    },
    // ModalRenderer imports every registered modal, and AddSshConnModal boots
    // the appState singleton, which loads SSH state on start.
    ssh: {
      getConnections: mocks.getConnections,
      getHealthStates: mocks.getHealthStates,
      getConnectionState: mocks.getConnectionState,
    },
  },
  events: { on: mocks.onEvent },
}));

vi.mock('@renderer/lib/hooks/use-toast', () => ({
  toast: mocks.toast,
  useToast: () => ({ toast: mocks.toast }),
}));

// The confirmation dialog's ConfirmButton reads keyboard settings.
vi.mock('@renderer/features/settings/use-app-settings-key', () => ({
  useAppSettingsKey: () => ({ value: undefined }),
}));

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    configurable: true,
  });
});

const UNPAIRED: SyncState = { paired: false, spaceId: null, deviceName: null };
const PAIRED: SyncState = { paired: true, spaceId: 'ABCDEFGHIJKLMNOPQRSTUV', deviceName: 'mac-a' };

const SELF_DEVICE: SyncDeviceInfo = {
  deviceId: 'device-a',
  name: 'mac-a',
  createdAt: 1_800_000_000_000,
  lastSeenAt: 1_800_000_000_100,
  revoked: false,
  revokedAt: null,
  self: true,
};

const OTHER_DEVICE: SyncDeviceInfo = {
  deviceId: 'device-b',
  name: 'mac-b',
  createdAt: 1_800_000_000_000,
  lastSeenAt: null,
  revoked: false,
  revokedAt: null,
  self: false,
};

const REVOKED_DEVICE: SyncDeviceInfo = {
  ...OTHER_DEVICE,
  deviceId: 'device-c',
  name: 'mac-c',
  revoked: true,
  revokedAt: 1_800_000_000_200,
};

describe('DevicesSettingsCard', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    modalStore.closeModal('dismissed');
    mocks.getState.mockResolvedValue(UNPAIRED);
    mocks.listDevices.mockResolvedValue({ success: true, devices: [] });
    mocks.getConnections.mockResolvedValue([]);

    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  async function renderCard() {
    await act(async () => {
      root.render(
        <>
          <DevicesSettingsCard />
          <ModalRenderer />
        </>
      );
    });
  }

  async function flush(): Promise<void> {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it('shows the not-paired state with create and join actions', async () => {
    await renderCard();
    await flush();

    expect(mocks.getState).toHaveBeenCalled();
    expect(document.body.textContent).toContain('Not paired with any device');
    expect(document.body.textContent).toContain('Create sync space');
    expect(document.body.textContent).toContain('Join a space');
  });

  it('creates a space and shows the single-use pairing secret with a deep link', async () => {
    mocks.createSpace.mockResolvedValue({
      success: true,
      spaceId: 'ABCDEFGHIJKLMNOPQRSTUV',
      secret: 'emdj1_ABCDEFGHIJKLMNOPQRSTUV_abcdefghijklmnopqrstuv_-aBcDeF',
      deepLink: 'emdash://join?secret=emdj1_ABCDEFGHIJKLMNOPQRSTUV_abcdefghijklmnopqrstuv_-aBcDeF',
    });

    await renderCard();
    await flush();

    const createButton = [...document.body.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Create sync space')
    );
    expect(createButton).toBeTruthy();
    await act(async () => {
      createButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(mocks.createSpace).toHaveBeenCalled();
    const text = document.body.textContent ?? '';
    expect(text).toContain('Pair this device');
    expect(text).toContain('emdj1_ABCDEFGHIJKLMNOPQRSTUV');
    expect(text).toContain('emdash://join?secret=');
    expect(text).toContain('single-use');
    expect(text).toContain('15 minutes');
  });

  it('lists paired devices with self and revoked badges', async () => {
    mocks.getState.mockResolvedValue(PAIRED);
    mocks.listDevices.mockResolvedValue({
      success: true,
      devices: [SELF_DEVICE, OTHER_DEVICE, REVOKED_DEVICE],
    });

    await renderCard();
    await flush();

    const text = document.body.textContent ?? '';
    expect(text).toContain('mac-a');
    expect(text).toContain('This device');
    expect(text).toContain('mac-b');
    expect(text).toContain('Never seen');
    expect(text).toContain('mac-c');
    expect(text).toContain('Revoked');
  });

  it('mints a fresh pairing secret for an additional device', async () => {
    mocks.getState.mockResolvedValue(PAIRED);
    mocks.listDevices.mockResolvedValue({ success: true, devices: [SELF_DEVICE] });
    mocks.mintSecret.mockResolvedValue({
      success: true,
      secret: 'emdj1_ABCDEFGHIJKLMNOPQRSTUV_zyxwvutsrqponmlkjihgfe_AbCdEf',
      deepLink: 'emdash://join?secret=emdj1_ABCDEFGHIJKLMNOPQRSTUV_zyxwvutsrqponmlkjihgfe_AbCdEf',
    });

    await renderCard();
    await flush();

    const buttons = [...document.body.querySelectorAll('button')];
    const addButton = buttons.find((button) => button.textContent?.includes('Add device'));
    expect(addButton).toBeTruthy();
    await act(async () => {
      addButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(mocks.mintSecret).toHaveBeenCalled();
    expect(document.body.textContent).toContain(
      'emdj1_ABCDEFGHIJKLMNOPQRSTUV_zyxwvutsrqponmlkjihgfe_AbCdEf'
    );
  });

  it('surfaces relay failures as user-facing toasts, never raw JSON', async () => {
    mocks.getState.mockResolvedValue(PAIRED);
    mocks.listDevices.mockResolvedValue({ success: true, devices: [SELF_DEVICE] });
    mocks.mintSecret.mockResolvedValue({
      success: false,
      code: 'invalid_join_secret',
      message: 'This pairing secret is invalid, already used, or expired.',
    });

    await renderCard();
    await flush();

    const addButton = [...document.body.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Add device')
    );
    await act(async () => {
      addButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(mocks.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'This pairing secret is invalid, already used, or expired.',
        variant: 'destructive',
      })
    );
  });

  it('revokes a device through the confirmation dialog', async () => {
    mocks.getState.mockResolvedValue(PAIRED);
    mocks.listDevices.mockResolvedValue({ success: true, devices: [SELF_DEVICE, OTHER_DEVICE] });
    mocks.revokeDevice.mockResolvedValue({ success: true });

    await renderCard();
    await flush();

    const revokeButtons = [...document.body.querySelectorAll('button')].filter((button) =>
      button.getAttribute('aria-label')?.startsWith('Revoke')
    );
    expect(revokeButtons).toHaveLength(2);

    // Revoke the second (non-self) device.
    await act(async () => {
      revokeButtons[1]!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    // Confirmation dialog asks first.
    expect(document.body.textContent).toContain('Revoke mac-b?');
    expect(mocks.revokeDevice).not.toHaveBeenCalled();

    const confirmButton = [...document.body.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Revoke')
    );
    await act(async () => {
      confirmButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(mocks.revokeDevice).toHaveBeenCalledWith('device-b');
  });

  it('shows the retry state when paired but the device list fails to load', async () => {
    mocks.getState.mockResolvedValue(PAIRED);
    mocks.listDevices.mockResolvedValue({
      success: false,
      code: 'network_error',
      message: 'Could not reach the sync relay. Check your connection and try again.',
    });

    await renderCard();
    await flush();

    const text = document.body.textContent ?? '';
    expect(text).toContain('Could not load sync devices');
    expect(text).toContain('Retry');
    // The paired machine must not be presented as unpaired.
    expect(text).not.toContain('Not paired with any device');
  });

  it('pre-fills the join modal from a deep link and only joins on confirmation', async () => {
    mocks.getState.mockResolvedValue(PAIRED);
    mocks.listDevices.mockResolvedValue({ success: true, devices: [SELF_DEVICE] });
    const secret = 'emdj1_ABCDEFGHIJKLMNOPQRSTUV_abcdefghijklmnopqrstuv_-aBcDeF';

    await act(async () => {
      root.render(
        <>
          <SyncDeepLinkHandler />
          <ModalRenderer />
        </>
      );
    });
    await flush();

    const handler = mocks.onEvent.mock.calls.find(
      ([channel]) => channel?.name === 'sync:join-secret'
    )?.[1] as ((payload: { secret: string }) => void) | undefined;
    expect(handler).toBeTypeOf('function');

    await act(async () => {
      handler?.({ secret });
    });
    await flush();

    // The modal opens pre-filled with the deep-link secret; nothing is sent
    // to the relay until the user confirms.
    const input = document.querySelector<HTMLInputElement>('#join-secret');
    expect(input?.value).toBe(secret);
    expect(mocks.joinSpace).not.toHaveBeenCalled();

    const joinButton = [...document.body.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('Join')
    );
    await act(async () => {
      joinButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();

    expect(mocks.joinSpace).toHaveBeenCalledWith(secret, undefined);
  });
});
