import type { RpcRouter } from '@main/rpc';
import { createEventEmitter, type EmitterAdapter } from '@shared/lib/ipc/events';
import { createRPCClient } from '@shared/lib/ipc/rpc';

// The bridge is absent whenever renderer code is loaded outside Electron — browser-mode
// tests, Storybook — and there `window` exists while `window.electronAPI` does not. Guarding
// on `window` alone left `electronAPI` undefined and the `createRPCClient` call below threw
// at *import* time, so any module transitively importing this one failed to load at all.
// Fall back on the bridge itself, so the unavailable-channel errors below are what callers
// actually get.
const electronAPI = (typeof window !== 'undefined' ? window.electronAPI : undefined) ?? {
  invoke: (channel: string) => {
    throw new Error(`electronAPI.invoke is unavailable for ${channel}`);
  },
  eventSend: (channel: string) => {
    throw new Error(`electronAPI.eventSend is unavailable for ${channel}`);
  },
  eventOn: () => () => {},
  getPathForFile: () => '',
};

export const rpc = createRPCClient<RpcRouter>(electronAPI.invoke);

function createRendererAdapter(): EmitterAdapter {
  return {
    emit: (eventName: string, data: unknown, topic?: string) => {
      const channel = topic ? `${eventName}.${topic}` : eventName;
      electronAPI.eventSend(channel, data);
    },
    on: (eventName: string, cb: (data: unknown) => void, topic?: string) => {
      const channel = topic ? `${eventName}.${topic}` : eventName;
      return electronAPI.eventOn(channel, cb);
    },
  };
}

export const events = createEventEmitter(createRendererAdapter());
