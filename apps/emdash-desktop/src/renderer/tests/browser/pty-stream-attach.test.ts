import type { Terminal } from '@xterm/xterm';
/**
 * Regression: off-screen terminals must stop consuming the PTY stream.
 *
 * Hidden FronteendPtys used to stay subscribed to `pty:data` forever, so every
 * agent TUI keep-redrawing-while-hidden burned renderer CPU parsing output
 * nobody looked at (the constant-CPU investigation of Aug 2026). Now:
 *  - unmount() detaches the live listener and unsubscribes on the backend;
 *  - mount() re-subscribes with the renderer's replay cursor and fetches only
 *    the delta produced while hidden;
 *  - if the cursor can no longer be honored (ring-buffer gap), the terminal is
 *    reset and the full snapshot replayed instead.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FrontendPty as FrontendPtyType } from '@renderer/lib/pty/pty';

// Stable mock object: the ipc module captures window.electronAPI at import
// time and stays cached across tests in this file, so every beforeEach must
// re-stub the SAME object (see pty-color-scheme-notify.test.ts).
const electronAPIMock = {
  eventOn: vi.fn<(channel: string, cb: (data: unknown) => void) => () => void>(),
  eventSend: vi.fn(),
  invoke: vi.fn<(method: string, ...args: unknown[]) => Promise<unknown>>(),
};

type SubscribeResponse = {
  success: true;
  data: { buffer: string; totalBytes: number; truncated: boolean };
};

/** Minimal stand-in for the main-process registry contract. */
function makeFakeBackend() {
  let allData = '';
  let forcedTruncation: string | null = null; // when set, subscribe replies truncated with this buffer
  const consumers = new Set<string>();
  const dataListeners = new Map<string, Set<(data: string) => void>>();

  electronAPIMock.eventOn.mockImplementation((channel, cb) => {
    const sessionId = channel.slice('pty:data.'.length);
    if (!dataListeners.has(sessionId)) dataListeners.set(sessionId, new Set());
    dataListeners.get(sessionId)!.add(cb);
    return () => {
      dataListeners.get(sessionId)?.delete(cb);
    };
  });

  electronAPIMock.invoke.mockImplementation(async (method: string, ...args: unknown[]) => {
    if (method === 'pty.subscribe') {
      const [sessionId, sinceOffset] = args as [string, number | undefined];
      consumers.add(sessionId);
      if (forcedTruncation !== null) {
        return {
          success: true,
          data: { buffer: forcedTruncation, totalBytes: allData.length, truncated: true },
        } satisfies SubscribeResponse;
      }
      if (sinceOffset === undefined) {
        return {
          success: true,
          data: { buffer: allData, totalBytes: allData.length, truncated: false },
        } satisfies SubscribeResponse;
      }
      // Cursor still retained → delta; otherwise the caller asked for data
      // this incarnation never produced (stale cursor) → truncated.
      const stale = sinceOffset > allData.length;
      return {
        success: true,
        data: {
          buffer: stale ? allData : allData.slice(sinceOffset),
          totalBytes: allData.length,
          truncated: stale,
        },
      } satisfies SubscribeResponse;
    }
    if (method === 'pty.unsubscribe') {
      consumers.delete(args[0] as string);
      return { success: true };
    }
    return { success: true };
  });

  return {
    /** Simulate the PTY producing output (main-side accumulation + fan-out). */
    produce(sessionId: string, data: string): void {
      allData += data;
      for (const cb of dataListeners.get(sessionId) ?? []) cb(data);
    },
    /** Simulate output produced while NO consumer is attached (no fan-out). */
    produceWhileDetached(data: string): void {
      allData += data;
    },
    get allData(): string {
      return allData;
    },
    get consumers(): Set<string> {
      return consumers;
    },
    forceTruncation(buffer: string | null): void {
      forcedTruncation = buffer;
    },
    listenerCount(sessionId: string): number {
      return dataListeners.get(sessionId)?.size ?? 0;
    },
  };
}

function bufferText(terminal: Terminal): string {
  const buf = terminal.buffer.active;
  const lines: string[] = [];
  for (let i = 0; i < buf.length; i++) {
    lines.push(buf.getLine(i)?.translateToString(true) ?? '');
  }
  return lines.join('\n').replace(/\n+$/, '');
}

describe('FrontendPty stream attach/detach', () => {
  let backend: ReturnType<typeof makeFakeBackend>;
  let FrontendPtyClass: typeof FrontendPtyType;
  let disposeAllPtys: () => void;
  const live: FrontendPtyType[] = [];

  beforeEach(async () => {
    vi.stubGlobal('electronAPI', electronAPIMock);
    backend = makeFakeBackend();
    for (const v of [
      '--xterm-bg',
      '--xterm-fg',
      '--xterm-cursor',
      '--xterm-cursor-accent',
      '--xterm-selection-bg',
      '--xterm-selection-fg',
    ]) {
      document.documentElement.style.setProperty(v, v.includes('bg') ? '#101010' : '#f0f0f0');
    }
    const ptyModule = await import('@renderer/lib/pty/pty');
    FrontendPtyClass = ptyModule.FrontendPty;
    disposeAllPtys = ptyModule.disposeAllPtys;
  });

  afterEach(() => {
    disposeAllPtys();
    document.querySelector('[data-terminal-host="true"]')?.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function makeConnected(sessionId: string): Promise<FrontendPtyType> {
    const pty = new FrontendPtyClass(sessionId);
    live.push(pty);
    await pty.connect();
    return pty;
  }

  it('delivers live data to a connected terminal', async () => {
    backend.produce('s1', 'init');
    const pty = await makeConnected('s1');

    expect(backend.consumers.has('s1')).toBe(true);
    backend.produce('s1', '+live');
    await vi.waitFor(() => {
      expect(bufferText(pty.terminal)).toBe('init+live');
    });
  });

  it('stops writing to a hidden terminal and unsubscribes on the backend', async () => {
    const pty = await makeConnected('s2');
    const mountTarget = document.createElement('div');
    document.body.appendChild(mountTarget);
    pty.mount(mountTarget);
    await vi.waitFor(() => expect(bufferText(pty.terminal)).toBe(''));

    pty.unmount();

    expect(backend.consumers.has('s2')).toBe(false);
    expect(backend.listenerCount('s2')).toBe(0);

    backend.produceWhileDetached('+hidden');
    await new Promise((r) => setTimeout(r, 50));
    expect(bufferText(pty.terminal)).toBe('');
  });

  it('remount fetches exactly the missed delta, without duplication', async () => {
    backend.produce('s3', 'one');
    const pty = await makeConnected('s3');
    const mountTarget = document.createElement('div');
    document.body.appendChild(mountTarget);
    pty.mount(mountTarget);
    await vi.waitFor(() => expect(bufferText(pty.terminal)).toBe('one'));

    pty.unmount();
    backend.produceWhileDetached('TWO');
    expect(bufferText(pty.terminal)).toBe('one');

    pty.mount(mountTarget);

    await vi.waitFor(() => {
      expect(electronAPIMock.invoke).toHaveBeenCalledWith('pty.subscribe', 's3', 'one'.length);
    });
    await vi.waitFor(() => {
      expect(bufferText(pty.terminal)).toBe('oneTWO');
    });
    expect(backend.consumers.has('s3')).toBe(true);
    // Live delivery works again after remount.
    backend.produce('s3', '+three');
    await vi.waitFor(() => {
      expect(bufferText(pty.terminal)).toBe('oneTWO+three');
    });
  });

  it('resets and replays the full snapshot when the cursor has a gap', async () => {
    backend.produce('s4', 'ancient');
    const pty = await makeConnected('s4');
    const mountTarget = document.createElement('div');
    document.body.appendChild(mountTarget);
    pty.mount(mountTarget);
    await vi.waitFor(() => expect(bufferText(pty.terminal)).toBe('ancient'));

    pty.unmount();
    // The session respawned while hidden: everything ever streamed is gone.
    backend.forceTruncation('fresh-incarnation');
    const resetSpy = vi.spyOn(pty.terminal, 'reset');

    pty.mount(mountTarget);

    await vi.waitFor(() => {
      expect(resetSpy).toHaveBeenCalled();
      expect(bufferText(pty.terminal)).toBe('fresh-incarnation');
    });
    backend.forceTruncation(null);
  });

  it('an unmount during an in-flight remount never resurrects the listener', async () => {
    backend.produce('s5', 'base');
    const pty = await makeConnected('s5');
    const mountTarget = document.createElement('div');
    document.body.appendChild(mountTarget);
    pty.mount(mountTarget);
    await vi.waitFor(() => expect(bufferText(pty.terminal)).toBe('base'));

    pty.unmount();
    backend.produceWhileDetached('-missed');

    // Remount but detach again before the subscribe round-trip resolves.
    let releaseSubscribe: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseSubscribe = resolve;
    });
    electronAPIMock.invoke.mockImplementationOnce(async (method: string, ...args: unknown[]) => {
      if (method !== 'pty.subscribe') return { success: true };
      // Main processes the subscribe immediately; only the reply is delayed.
      backend.consumers.add(args[0] as string);
      await gate;
      return {
        success: true,
        data: { buffer: '-missed', totalBytes: backend.allData.length, truncated: false },
      } satisfies SubscribeResponse;
    });
    pty.mount(mountTarget);
    pty.unmount();
    releaseSubscribe();
    await new Promise((r) => setTimeout(r, 50));

    expect(backend.listenerCount('s5')).toBe(0);
    expect(backend.consumers.has('s5')).toBe(false);
    backend.produceWhileDetached('-more');
    await new Promise((r) => setTimeout(r, 50));
    expect(bufferText(pty.terminal)).toBe('base');
  });
});
