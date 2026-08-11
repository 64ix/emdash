import { beforeEach, describe, expect, it, vi } from 'vitest';

const emitMock = vi.hoisted(() => vi.fn());
vi.mock('@main/lib/events', () => ({ events: { emit: emitMock } }));
vi.mock('@main/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const appMock = vi.hoisted(() => ({
  setAsDefaultProtocolClient: vi.fn(() => true),
  on: vi.fn(),
}));
vi.mock('electron', () => ({ app: appMock }));

import {
  argvJoinDeepLink,
  DEEP_LINK_SCHEME,
  handleJoinDeepLink,
  parseJoinDeepLink,
  registerDeepLinkHandler,
} from './deep-link';

const JOIN_URL = 'emdash://join?secret=emdj1_AB12-34_CD56-78_-aBcDeF';

describe('parseJoinDeepLink', () => {
  it('extracts the secret from an emdash://join URL', () => {
    expect(parseJoinDeepLink(JOIN_URL)).toBe('emdj1_AB12-34_CD56-78_-aBcDeF');
  });

  it('decodes percent-encoded secret characters', () => {
    expect(parseJoinDeepLink('emdash://join?secret=emdj1_a%2Bb%2Fc')).toBe('emdj1_a+b/c');
  });

  it('tolerates extra query parameters', () => {
    expect(parseJoinDeepLink(`${JOIN_URL}&utm_source=test`)).toBe('emdj1_AB12-34_CD56-78_-aBcDeF');
  });

  it('rejects non-join hosts, missing or empty secrets, and other schemes', () => {
    expect(parseJoinDeepLink('emdash://open?secret=abc')).toBeNull();
    expect(parseJoinDeepLink('emdash://join')).toBeNull();
    expect(parseJoinDeepLink('emdash://join?secret=')).toBeNull();
    expect(parseJoinDeepLink('https://join?secret=abc')).toBeNull();
    expect(parseJoinDeepLink('not a url')).toBeNull();
  });
});

describe('handleJoinDeepLink', () => {
  beforeEach(() => {
    emitMock.mockReset();
  });

  it('emits the sync:join-secret event with the parsed secret', () => {
    const handled = handleJoinDeepLink(JOIN_URL);

    expect(handled).toBe(true);
    expect(emitMock).toHaveBeenCalledTimes(1);
    expect(emitMock.mock.calls[0]?.[0]?.name).toBe('sync:join-secret');
    expect(emitMock.mock.calls[0]?.[1]).toEqual({ secret: 'emdj1_AB12-34_CD56-78_-aBcDeF' });
  });

  it('ignores URLs that are not join deep links', () => {
    expect(handleJoinDeepLink('emdash://open?secret=abc')).toBe(false);
    expect(handleJoinDeepLink('https://emdash.sh')).toBe(false);
    expect(emitMock).not.toHaveBeenCalled();
  });
});

describe('argvJoinDeepLink', () => {
  it('finds the deep link among second-instance arguments', () => {
    const argv = ['/Applications/Emdash.app', '--flag', JOIN_URL, '--other'];
    expect(argvJoinDeepLink(argv)).toBe(JOIN_URL);
  });

  it('returns null when no deep link is present', () => {
    expect(argvJoinDeepLink(['/Applications/Emdash.app', '--flag'])).toBeNull();
  });
});

describe('registerDeepLinkHandler', () => {
  beforeEach(() => {
    appMock.on.mockReset();
    emitMock.mockReset();
  });

  it('registers the emdash scheme and an open-url listener', () => {
    registerDeepLinkHandler();

    expect(appMock.setAsDefaultProtocolClient).toHaveBeenCalledWith(DEEP_LINK_SCHEME);
    expect(appMock.on).toHaveBeenCalledWith('open-url', expect.any(Function));
  });

  it('forwards a macOS open-url join link to the renderer', () => {
    registerDeepLinkHandler();
    const openUrlHandler = appMock.on.mock.calls.find(([name]) => name === 'open-url')?.[1] as
      | ((event: { preventDefault: () => void }, url: string) => void)
      | undefined;
    expect(openUrlHandler).toBeTypeOf('function');

    openUrlHandler?.({ preventDefault: vi.fn() }, JOIN_URL);

    expect(emitMock).toHaveBeenCalledTimes(1);
    expect(emitMock.mock.calls[0]?.[1]).toEqual({ secret: 'emdj1_AB12-34_CD56-78_-aBcDeF' });
  });

  it('ignores non-join open-url events', () => {
    registerDeepLinkHandler();
    const openUrlHandler = appMock.on.mock.calls.find(([name]) => name === 'open-url')?.[1] as
      | ((event: { preventDefault: () => void }, url: string) => void)
      | undefined;
    openUrlHandler?.({ preventDefault: vi.fn() }, 'emdash://settings');

    expect(emitMock).not.toHaveBeenCalled();
  });
});
