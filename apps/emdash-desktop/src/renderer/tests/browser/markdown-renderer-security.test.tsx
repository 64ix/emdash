import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarkdownRenderer } from '@renderer/lib/ui/markdown-renderer';

vi.mock('@renderer/lib/hooks/useTheme', () => ({
  useTheme: () => ({ effectiveTheme: 'emlight' }),
}));

// Importing the renderer transitively constructs the SSH connection store, whose Resources
// call RPC from their constructor. Without a bridge those calls reject as unhandled errors
// and fail the file even though every assertion passed, so stub the boundary — the same
// stub the node-project tests and the other browser suites install.
vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    app: { openExternal: vi.fn(() => Promise.resolve()) },
    ssh: {
      getConnections: async () => [],
      getConnectionState: async () => ({}),
      getHealthStates: async () => ({}),
    },
  },
  events: { on: vi.fn(() => () => {}) },
}));

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

describe('MarkdownRenderer untrusted posture', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it('creates no active element or request from hostile markdown', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const hostileMarkdown = [
      '![remote](https://evil.example/beacon.png)',
      '<img src="https://evil.example/raw.png" onerror="alert(1)">',
      '<script src="https://evil.example/payload.js">alert(1)</script>',
      '<iframe src="https://evil.example/frame"></iframe>',
      '<video src="https://evil.example/video.mp4"></video>',
      '<div style="background:url(https://evil.example/style.png)" onclick="alert(1)">x</div>',
      '[bad](javascript:alert(1))',
    ].join('\n\n');

    await act(async () => {
      root.render(<MarkdownRenderer content={hostileMarkdown} trust="untrusted" />);
    });

    expect(host.querySelector('img')).toBeNull();
    expect(host.querySelector('script')).toBeNull();
    expect(host.querySelector('iframe')).toBeNull();
    expect(host.querySelector('video')).toBeNull();
    expect(host.querySelector('[style]')).toBeNull();
    expect(host.querySelector('[onclick]')).toBeNull();
    expect(host.querySelector('a[href^="javascript:"]')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();

    fetchSpy.mockRestore();
  });

  it('prevents navigation for links not claimed by typed routing', async () => {
    await act(async () => {
      root.render(<MarkdownRenderer content="[relative](unknown/path)" trust="untrusted" />);
    });

    const link = host.querySelector<HTMLAnchorElement>('a');
    expect(link).not.toBeNull();
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    link?.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });
});
