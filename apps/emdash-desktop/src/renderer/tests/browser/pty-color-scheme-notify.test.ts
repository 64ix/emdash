/**
 * Regression: full-screen TUIs (e.g. opencode) must be told when the terminal
 * color scheme changes, or they keep painting their launch-time colors over
 * the flipped terminal background — the "half light, half dark" screen when
 * macOS switches appearance.
 *
 * opencode's TUI listens for exactly `ESC [ ? 997 ; 1 n` (dark) /
 * `ESC [ ? 997 ; 2 n` (light) and re-queries the terminal palette on receipt
 * (verified end-to-end against the real opencode binary). This suite pins the
 * emdash side: on theme change, the sequence is pushed into every live PTY
 * session's input.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FrontendPty as FrontendPtyType } from '@renderer/lib/pty/pty';

describe('PTY color-scheme change notification', () => {
  let pty: FrontendPtyType;
  let mountTarget: HTMLDivElement;
  let invoke: ReturnType<typeof vi.fn>;
  let FrontendPtyClass: typeof FrontendPtyType;
  let notifyPtyColorSchemeChange: (dark: boolean) => void;
  let disposeAllPtys: () => void;

  beforeEach(async () => {
    // The pty module captures `window.electronAPI.invoke` at import time and
    // the module stays cached across tests, so every test must stub with the
    // SAME mock object or calls land on a stale reference.
    invoke = invoke ?? vi.fn(() => Promise.resolve({ success: true }));
    invoke.mockClear();
    vi.stubGlobal('electronAPI', {
      eventOn: vi.fn(() => () => {}),
      eventSend: vi.fn(),
      invoke,
    });
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
    notifyPtyColorSchemeChange = ptyModule.notifyPtyColorSchemeChange;
    disposeAllPtys = ptyModule.disposeAllPtys;
    pty = new ptyModule.FrontendPty('scheme-notify-session');
    mountTarget = document.createElement('div');
    document.body.appendChild(mountTarget);
    pty.mount(mountTarget);
  });

  afterEach(() => {
    disposeAllPtys();
    mountTarget?.remove();
    document.querySelector('[data-terminal-host="true"]')?.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('pushes the dark color-scheme-changed report to every live session', () => {
    notifyPtyColorSchemeChange(true);
    expect(invoke).toHaveBeenCalledWith('pty.sendInput', 'scheme-notify-session', '\x1b[?997;1n');
  });

  it('pushes the light color-scheme-changed report to every live session', () => {
    notifyPtyColorSchemeChange(false);
    expect(invoke).toHaveBeenCalledWith('pty.sendInput', 'scheme-notify-session', '\x1b[?997;2n');
  });

  it('reaches every live session, not just one', () => {
    new FrontendPtyClass('scheme-notify-second');

    notifyPtyColorSchemeChange(true);

    expect(invoke).toHaveBeenCalledWith('pty.sendInput', 'scheme-notify-session', '\x1b[?997;1n');
    expect(invoke).toHaveBeenCalledWith('pty.sendInput', 'scheme-notify-second', '\x1b[?997;1n');
  });
});
