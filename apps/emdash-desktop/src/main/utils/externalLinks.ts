import { shell, type BrowserWindow } from 'electron';
import { APP_ORIGIN } from '@main/app/protocol';
import { getMainWindow } from '@main/app/window';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import { externalLinkOpenRequestedChannel } from '@shared/events/appEvents';

/**
 * Typed decision for a navigation requested on the main window's own
 * webContents (window.open/target="_blank" or a top-level `will-navigate`).
 * There is no permissive fallback: anything that isn't explicitly one of
 * `internal` or `external-http` is `denied`. This is the fail-closed
 * backstop behind chat-authored and other renderer-originated links; the
 * typed link-action classification for workspace files and local artifacts
 * (spec #18 tickets #20/#21) runs earlier, in the renderer, before a raw
 * anchor/window.open ever reaches this policy.
 */
export type MainWindowNavigationDecision =
  | { readonly kind: 'internal' }
  | { readonly kind: 'external-http'; readonly url: string }
  | { readonly kind: 'denied' };

/**
 * Classifies a navigation target against the registered set of app
 * behaviors: the app's own origin (dev server or the `app://` production
 * origin), and approved HTTP(S) handoff to the OS default browser. Every
 * other target — `file:`, relative paths that don't resolve to the app
 * origin, custom schemes, non-HTTP protocols, and malformed URLs — is
 * denied by default.
 */
export function classifyMainWindowNavigation(
  url: string,
  isDev: boolean
): MainWindowNavigationDecision {
  if (isInternalAppUrl(url, isDev)) {
    return { kind: 'internal' };
  }
  if (isExternalHttpUrl(url)) {
    return { kind: 'external-http', url };
  }
  return { kind: 'denied' };
}

function isInternalAppUrl(url: string, isDev: boolean): boolean {
  if (isDev) {
    const devServerUrl = process.env.ELECTRON_RENDERER_URL ?? '';
    return devServerUrl.length > 0 && url.startsWith(devServerUrl);
  }
  return url === APP_ORIGIN || url.startsWith(`${APP_ORIGIN}/`);
}

function isExternalHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Ensure any external HTTP(S) links open in the user's default browser
 * rather than inside the Electron window. Keeps app navigation scoped
 * to our renderer while preserving expected link behavior.
 */
function requestExternalLinkOpen(url: string) {
  const mainWindow = getMainWindow();
  if (mainWindow && !mainWindow.isDestroyed()) {
    events.emit(externalLinkOpenRequestedChannel, { url });
    return;
  }

  log.warn('External link request had no main window; opening directly', { url });
  shell.openExternal(url).catch((error: unknown) => {
    log.warn('Failed to open external link without main window', { url, error });
  });
}

/**
 * Fail-closed navigation policy for the main window. Every window-open
 * request and top-level navigation is classified via
 * `classifyMainWindowNavigation`; only the app's own origin is allowed to
 * navigate in place, only approved HTTP(S) targets are handed off to the
 * OS browser, and everything else — including `file:`, relative targets
 * that miss the app origin, custom schemes, and malformed URLs — is denied
 * without ever creating a child window.
 */
export function registerExternalLinkHandlers(win: BrowserWindow, isDev: boolean) {
  const wc = win.webContents;

  // Handle window.open and target="_blank"
  wc.setWindowOpenHandler(({ url }) => {
    const decision = classifyMainWindowNavigation(url, isDev);
    switch (decision.kind) {
      case 'internal':
        return { action: 'allow' };
      case 'external-http':
        requestExternalLinkOpen(decision.url);
        return { action: 'deny' };
      case 'denied':
        return { action: 'deny' };
    }
  });

  // Intercept top-level navigations away from the app's own content
  wc.on('will-navigate', (event, url) => {
    const decision = classifyMainWindowNavigation(url, isDev);
    if (decision.kind === 'internal') return;

    event.preventDefault();
    if (decision.kind === 'external-http') {
      requestExternalLinkOpen(decision.url);
    }
  });
}
