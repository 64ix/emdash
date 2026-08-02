import type { BrowserWindow, WebContents } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_ORIGIN } from '@main/app/protocol';

const mocks = vi.hoisted(() => ({
  openExternal: vi.fn(() => Promise.resolve()),
  eventEmit: vi.fn(),
  getMainWindow: vi.fn(),
  logWarn: vi.fn(),
}));

vi.mock('electron', () => ({
  shell: { openExternal: mocks.openExternal },
}));

vi.mock('@main/app/window', () => ({
  getMainWindow: mocks.getMainWindow,
}));

vi.mock('@main/lib/events', () => ({
  events: { emit: mocks.eventEmit },
}));

vi.mock('@main/lib/logger', () => ({
  log: { warn: mocks.logWarn },
}));

import { externalLinkOpenRequestedChannel } from '@shared/events/appEvents';
import { classifyMainWindowNavigation, registerExternalLinkHandlers } from './externalLinks';

const DEV_SERVER_URL = 'http://localhost:5173/';

describe('classifyMainWindowNavigation', () => {
  describe('production (isDev = false)', () => {
    const isDev = false;

    it.each<[string, string]>([
      ['the app origin itself', APP_ORIGIN],
      ['a path under the app origin', `${APP_ORIGIN}/index.html`],
      ['a nested path under the app origin', `${APP_ORIGIN}/assets/app.js`],
    ])('classifies %s as internal', (_label, url) => {
      expect(classifyMainWindowNavigation(url, isDev)).toEqual({ kind: 'internal' });
    });

    it.each<[string, string]>([
      ['a plain http(s) URL', 'http://example.com'],
      ['an https URL with a path and query', 'https://example.com/docs?x=1'],
      ['an http URL missing one slash (WHATWG-normalized)', 'http:/example.com'],
      ['a localhost preview URL (no longer implicitly internal)', 'http://localhost:5173/'],
      ['a 127.0.0.1 preview URL (no longer implicitly internal)', 'http://127.0.0.1:5173/'],
    ])('classifies %s as external-http', (_label, url) => {
      const decision = classifyMainWindowNavigation(url, isDev);
      expect(decision.kind).toBe('external-http');
    });

    it.each<[string, string]>([
      ['a file: URL', 'file:///etc/passwd'],
      ['a file: URL with an authority', 'file://localhost/etc/passwd'],
      ['a relative path with no scheme', 'foo/bar.html'],
      ['a dot-relative path', './relative/path'],
      ['a traversal-shaped relative path', '../../etc/passwd'],
      ['a custom scheme', 'myapp://action/open'],
      ['a javascript: URL', 'javascript:alert(1)'],
      ['a data: URL', 'data:text/html,<script>alert(1)</script>'],
      ['a Windows drive-letter path', 'C:\\Users\\foo\\bar.txt'],
      ['a Windows UNC path', '\\\\server\\share\\file.txt'],
      ['a malformed http URL with no host', 'http://'],
      ['an empty string', ''],
      ['a whitespace-only string', '   '],
      ['an app-origin path with the wrong case', `${APP_ORIGIN.toUpperCase()}/index.html`],
      ['an unrelated custom app-like origin', 'app://not-emdash/index.html'],
    ])('denies %s', (_label, url) => {
      expect(classifyMainWindowNavigation(url, isDev)).toEqual({ kind: 'denied' });
    });
  });

  describe('development (isDev = true)', () => {
    const isDev = true;

    beforeEach(() => {
      vi.stubEnv('ELECTRON_RENDERER_URL', DEV_SERVER_URL);
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('classifies the dev server origin as internal', () => {
      expect(classifyMainWindowNavigation(DEV_SERVER_URL, isDev)).toEqual({ kind: 'internal' });
      expect(classifyMainWindowNavigation(`${DEV_SERVER_URL}some/page`, isDev)).toEqual({
        kind: 'internal',
      });
    });

    it('still denies unregistered targets even when a dev server is configured', () => {
      expect(classifyMainWindowNavigation('file:///etc/passwd', isDev)).toEqual({
        kind: 'denied',
      });
      expect(classifyMainWindowNavigation('myapp://action', isDev)).toEqual({ kind: 'denied' });
    });

    it('still hands off approved http(s) targets that are not the dev server', () => {
      const decision = classifyMainWindowNavigation('https://example.com', isDev);
      expect(decision.kind).toBe('external-http');
    });
  });
});

type FakeWebContents = WebContents & {
  windowOpenHandler: Parameters<WebContents['setWindowOpenHandler']>[0] | null;
  emitWillNavigate(url: string): { preventDefault: ReturnType<typeof vi.fn> };
};

function fakeWindow(): { win: BrowserWindow; webContents: FakeWebContents } {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const webContents = {
    windowOpenHandler: null as FakeWebContents['windowOpenHandler'],
    setWindowOpenHandler(handler: FakeWebContents['windowOpenHandler']) {
      webContents.windowOpenHandler = handler;
    },
    on(event: string, listener: (...args: unknown[]) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return webContents;
    },
    emitWillNavigate(url: string) {
      const event = { preventDefault: vi.fn() };
      for (const listener of listeners.get('will-navigate') ?? []) {
        listener(event, url);
      }
      return event;
    },
  };
  const win = { webContents } as unknown as BrowserWindow;
  return { win, webContents: webContents as unknown as FakeWebContents };
}

const HOSTILE_TARGETS: Array<[string, string]> = [
  ['a file: URL', 'file:///etc/passwd'],
  ['a relative path', 'foo/bar.html'],
  ['a custom scheme', 'myapp://action/open'],
  ['a javascript: URL', 'javascript:alert(1)'],
  ['a data: URL', 'data:text/html,<script>alert(1)</script>'],
  ['a malformed URL', 'http://'],
  ['a Windows drive-letter path', 'C:\\Users\\foo\\bar.txt'],
];

describe('registerExternalLinkHandlers (Electron-level regression)', () => {
  beforeEach(() => {
    mocks.openExternal.mockClear();
    mocks.eventEmit.mockClear();
    mocks.logWarn.mockClear();
    mocks.getMainWindow.mockReset();
    mocks.getMainWindow.mockReturnValue({ isDestroyed: () => false });
  });

  it.each(HOSTILE_TARGETS)(
    'denies window-open for %s and creates no child window',
    (_label, url) => {
      const { webContents } = fakeWindow();
      registerExternalLinkHandlers({ webContents } as unknown as BrowserWindow, false);

      const handler = webContents.windowOpenHandler;
      if (!handler) throw new Error('windowOpenHandler was not registered');
      const result = handler({ url, disposition: 'new-window' } as Parameters<typeof handler>[0]);

      // Electron only creates a child window when the handler returns
      // { action: 'allow' }; asserting 'deny' here is the proof no window
      // is created for any of these unregistered targets.
      expect(result).toEqual({ action: 'deny' });
      expect(mocks.eventEmit).not.toHaveBeenCalled();
      expect(mocks.openExternal).not.toHaveBeenCalled();
    }
  );

  it.each(HOSTILE_TARGETS)('prevents top-level navigation for %s', (_label, url) => {
    const { webContents } = fakeWindow();
    registerExternalLinkHandlers({ webContents } as unknown as BrowserWindow, false);

    const event = webContents.emitWillNavigate(url);

    expect(event.preventDefault).toHaveBeenCalled();
    expect(mocks.eventEmit).not.toHaveBeenCalled();
  });

  it('allows registered application navigation to proceed in place', () => {
    const { webContents } = fakeWindow();
    registerExternalLinkHandlers({ webContents } as unknown as BrowserWindow, false);

    const handler = webContents.windowOpenHandler;
    if (!handler) throw new Error('windowOpenHandler was not registered');
    const opened = handler({
      url: `${APP_ORIGIN}/index.html`,
      disposition: 'new-window',
    } as Parameters<typeof handler>[0]);
    expect(opened).toEqual({ action: 'allow' });

    const event = webContents.emitWillNavigate(`${APP_ORIGIN}/index.html`);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('hands approved http(s) links to the confirmation flow without opening a child window', () => {
    const { webContents } = fakeWindow();
    registerExternalLinkHandlers({ webContents } as unknown as BrowserWindow, false);

    const handler = webContents.windowOpenHandler;
    if (!handler) throw new Error('windowOpenHandler was not registered');
    const result = handler({
      url: 'https://example.com/docs',
      disposition: 'new-window',
    } as Parameters<typeof handler>[0]);

    expect(result).toEqual({ action: 'deny' });
    expect(mocks.eventEmit).toHaveBeenCalledWith(externalLinkOpenRequestedChannel, {
      url: 'https://example.com/docs',
    });
    expect(mocks.openExternal).not.toHaveBeenCalled();
  });

  it('prevents in-place navigation for approved http(s) links but still requests the handoff', () => {
    const { webContents } = fakeWindow();
    registerExternalLinkHandlers({ webContents } as unknown as BrowserWindow, false);

    const event = webContents.emitWillNavigate('https://example.com/docs');

    expect(event.preventDefault).toHaveBeenCalled();
    expect(mocks.eventEmit).toHaveBeenCalledWith(externalLinkOpenRequestedChannel, {
      url: 'https://example.com/docs',
    });
  });

  it('falls back to opening directly when there is no main window for the handoff', () => {
    mocks.getMainWindow.mockReturnValue(null);
    const { webContents } = fakeWindow();
    registerExternalLinkHandlers({ webContents } as unknown as BrowserWindow, false);

    const handler = webContents.windowOpenHandler;
    if (!handler) throw new Error('windowOpenHandler was not registered');
    handler({
      url: 'https://example.com/docs',
      disposition: 'new-window',
    } as Parameters<typeof handler>[0]);

    expect(mocks.eventEmit).not.toHaveBeenCalled();
    expect(mocks.openExternal).toHaveBeenCalledWith('https://example.com/docs');
  });
});
