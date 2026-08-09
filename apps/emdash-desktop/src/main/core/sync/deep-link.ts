/**
 * `emdash://` deep-link handling for pairing (spec #130, ticket #135).
 *
 * The app registers itself as the handler for the `emdash` URL scheme; a
 * pairing deep link (`emdash://join?secret=…`) is turned into a
 * `syncJoinSecretChannel` event for the renderer, which surfaces the secret
 * into the Devices settings flow (pre-filled join modal — the user confirms
 * before anything is sent to the relay).
 *
 * Only the `join` action with a `secret` query parameter is recognized;
 * anything else is ignored. On macOS the link arrives via the `open-url`
 * event; on Windows/Linux it arrives as a command-line argument of a second
 * instance, which the single-instance lock funnels into `second-instance`.
 */
import { app } from 'electron';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import { syncJoinSecretChannel } from '@shared/events/syncEvents';

export const DEEP_LINK_SCHEME = 'emdash';

/** The secret carried by an `emdash://join?secret=…` URL, or null. */
export function parseJoinDeepLink(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== `${DEEP_LINK_SCHEME}:` || url.hostname !== 'join') {
    return null;
  }
  const secret = url.searchParams.get('secret');
  if (secret === null || secret === '') {
    return null;
  }
  return secret;
}

/** Parses a join deep link and forwards the secret to the renderer. */
export function handleJoinDeepLink(rawUrl: string): boolean {
  const secret = parseJoinDeepLink(rawUrl);
  if (secret === null) {
    return false;
  }
  log.info('sync join deep link received');
  events.emit(syncJoinSecretChannel, { secret });
  return true;
}

/** The last command-line URL of a second instance (Windows/Linux). */
export function argvJoinDeepLink(argv: string[]): string | null {
  return argv.find((arg) => arg.startsWith(`${DEEP_LINK_SCHEME}://`)) ?? null;
}

/** Registers the app as handler for `emdash://` and wires the OS events. */
export function registerDeepLinkHandler(): void {
  if (process.defaultApp) {
    // In dev the executable is Electron itself; registering the scheme would
    // hijack `emdash://` for the bundled Electron app. Keep the parsing
    // handlers active (tests + manual `open` with arguments), skip the OS
    // registration.
    if (process.argv.length > 1) {
      const url = argvJoinDeepLink(process.argv.slice(1));
      if (url !== null) handleJoinDeepLink(url);
    }
  } else {
    try {
      app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME);
    } catch (error) {
      log.warn('Failed to register emdash:// protocol client:', error);
    }
  }

  app.on('open-url', (event, url) => {
    event.preventDefault();
    handleJoinDeepLink(url);
  });
}
