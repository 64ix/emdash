import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MarkdownRenderer } from '@renderer/lib/ui/markdown-renderer';

vi.mock('@renderer/lib/hooks/useTheme', () => ({
  useTheme: () => ({ effectiveTheme: 'emlight' }),
}));

vi.mock('@renderer/features/tasks/stores/task-selectors', () => ({
  getTaskView: vi.fn(),
}));

vi.mock('@renderer/lib/stores/app-state', () => ({
  appState: {
    navigation: {
      currentViewId: 'home',
      viewParamsStore: {},
    },
  },
}));

vi.mock('@renderer/lib/ipc', () => ({
  events: {
    on: vi.fn(() => () => {}),
  },
  rpc: {
    app: {
      openExternal: vi.fn(),
    },
  },
}));

describe('MarkdownRenderer', () => {
  let dom: JSDOM;
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
    vi.stubGlobal('MouseEvent', dom.window.MouseEvent);
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

    container = dom.window.document.getElementById('root') as HTMLDivElement;
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
    dom.window.close();
  });

  it('constrains markdown images in compact rendering', () => {
    const html = renderToStaticMarkup(
      React.createElement(MarkdownRenderer, {
        content: '![Screenshot](https://example.com/screenshot.png)',
        trust: 'trusted',
        variant: 'compact',
      })
    );

    expect(html).toContain('src="https://example.com/screenshot.png"');
    expect(html).toContain('alt="Screenshot"');
    expect(html).toContain('aria-label="Expand image"');
    expect(html).toContain('max-w-full');
    expect(html).toContain('max-h-80');
    expect(html).toContain('object-contain');
  });

  it('constrains allowed HTML images in compact rendering', () => {
    const html = renderToStaticMarkup(
      React.createElement(MarkdownRenderer, {
        content: '<img src="https://example.com/preview.png" alt="Preview">',
        trust: 'trusted',
        variant: 'compact',
      })
    );

    expect(html).toContain('src="https://example.com/preview.png"');
    expect(html).toContain('alt="Preview"');
    expect(html).toContain('aria-label="Expand image"');
    expect(html).toContain('max-w-full');
    expect(html).toContain('max-h-80');
    expect(html).toContain('object-contain');
  });

  it('renders compact markdown tables with visible structure', () => {
    const html = renderToStaticMarkup(
      React.createElement(MarkdownRenderer, {
        content:
          '| Layer | What | How |\n| --- | --- | --- |\n| Primary | Headline | Display size |',
        trust: 'untrusted',
        variant: 'compact',
      })
    );

    expect(html).toContain('<table');
    expect(html).toContain('border-collapse');
    expect(html).toContain('<th');
    expect(html).toContain('<td');
    expect(html).toContain('Primary');
  });

  it('uses the info accent for checked task list items', () => {
    const html = renderToStaticMarkup(
      React.createElement(MarkdownRenderer, {
        content: '- [ ] Pending\n- [x] Complete',
        trust: 'untrusted',
      })
    );

    expect(html).toContain('checked:accent-foreground-info');
    expect(html).toContain('checked=""');
    expect(html).toContain('aria-disabled="true"');
    expect(html).not.toContain('disabled=""');
  });

  it('prevents browser navigation when a link handler claims a relative href', () => {
    const onOpenLink = vi.fn(() => true);

    act(() => {
      root.render(
        React.createElement(MarkdownRenderer, {
          content: '[booking.read](packages/trpc/server/routers/viewer/bookings/get.handler.ts)',
          onOpenLink,
          trust: 'untrusted',
          variant: 'full',
        })
      );
    });

    const link = container.querySelector<HTMLAnchorElement>('a[href]');
    expect(link).not.toBeNull();

    const event = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
    act(() => {
      link?.dispatchEvent(event);
    });

    expect(onOpenLink).toHaveBeenCalledWith(
      'packages/trpc/server/routers/viewer/bookings/get.handler.ts'
    );
    expect(event.defaultPrevented).toBe(true);
  });

  // The default-deny above must not swallow same-document fragments: they cannot leave the
  // document or reach the network, and a rendered README's table of contents is only these.
  it.each(['untrusted', 'trusted'] as const)(
    'leaves same-document fragment links navigable in %s content',
    (trust) => {
      const onOpenLink = vi.fn(() => false);

      act(() => {
        root.render(
          React.createElement(MarkdownRenderer, {
            content: '[Install](#install)',
            onOpenLink,
            trust,
            variant: 'full',
          })
        );
      });

      const link = container.querySelector<HTMLAnchorElement>('a[href]');
      expect(link).not.toBeNull();

      const event = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
      act(() => {
        link?.dispatchEvent(event);
      });

      expect(event.defaultPrevented).toBe(false);
      expect(onOpenLink).not.toHaveBeenCalled();
    }
  );

  it('renders hostile untrusted markdown without active resources or elements', () => {
    const hostileMarkdown = [
      '![remote](https://evil.example/beacon.png)',
      '<img src="https://evil.example/raw.png" onerror="alert(1)">',
      '<script src="https://evil.example/payload.js">alert(1)</script>',
      '<iframe src="https://evil.example/frame"></iframe>',
      '<video src="https://evil.example/video.mp4"></video>',
      '<div style="background:url(https://evil.example/style.png)" onclick="alert(1)">x</div>',
      '[bad](javascript:alert(1))',
    ].join('\n\n');

    act(() => {
      root.render(
        React.createElement(MarkdownRenderer, {
          content: hostileMarkdown,
          trust: 'untrusted',
        })
      );
    });

    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.querySelector('video')).toBeNull();
    expect(container.querySelector('[style]')).toBeNull();
    expect(container.querySelector('[onclick]')).toBeNull();
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
  });

  it('prevents browser navigation when no typed link handler claims the href', () => {
    act(() => {
      root.render(
        React.createElement(MarkdownRenderer, {
          content: '[relative](unknown/path)',
          trust: 'untrusted',
        })
      );
    });

    const link = container.querySelector<HTMLAnchorElement>('a[href]');
    expect(link).not.toBeNull();
    const event = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true });
    act(() => {
      link?.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
  });
});
