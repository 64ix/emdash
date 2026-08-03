/**
 * Browser-mode test for `ArtifactPreviewDialog` (spec #18 ticket #21).
 *
 * The dialog only ever displays bytes the main process already read and
 * policy-checked (`previewArtifact` RPC) — but that content is still
 * agent-authored and untrusted. This test asserts the rendering itself never
 * becomes a second attack surface: no remote `http(s)` resource is ever
 * requested from previewed text/markdown content, and no raw HTML embedded in
 * that content is ever parsed/executed — it renders as literal text.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ArtifactPreviewDialog,
  type ArtifactPreviewArtifact,
} from '@renderer/lib/components/artifact-preview-dialog';
import { Dialog } from '@renderer/lib/ui/dialog';

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

describe('ArtifactPreviewDialog', () => {
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

  async function renderDialog(name: string, path: string, artifact: ArtifactPreviewArtifact) {
    await act(async () => {
      root.render(
        <Dialog open modal={false}>
          <ArtifactPreviewDialog
            name={name}
            path={path}
            artifact={artifact}
            onSuccess={() => {}}
            onClose={() => {}}
          />
        </Dialog>
      );
    });
  }

  it('renders an image artifact from its data: URL only — never a remote src', async () => {
    await renderDialog('chart.png', '/Users/dev/workspace/chart.png', {
      kind: 'image',
      dataUrl: 'data:image/png;base64,AAAA',
      mimeType: 'image/png',
    });

    const img = host.querySelector('img');
    expect(img).not.toBeNull();
    expect(img!.getAttribute('src')).toBe('data:image/png;base64,AAAA');
  });

  it('renders plain text content verbatim', async () => {
    await renderDialog('notes.txt', '/tmp/notes.txt', {
      kind: 'text',
      content: 'hello, world',
      contentType: 'text',
    });

    expect(host.querySelector('pre')?.textContent).toBe('hello, world');
  });

  it('renders markdown as literal text — never fetches a remote image the content references', async () => {
    const evilMarkdown =
      '# Report\n\n![tracker](https://evil.example.com/track.png)\n\n<img src="https://evil.example.com/track2.png">';

    await renderDialog('report.md', '/tmp/report.md', {
      kind: 'text',
      content: evilMarkdown,
      contentType: 'markdown',
    });

    // No <img> element was created anywhere in the rendered output — the
    // remote sources above were never turned into a live network request.
    expect(host.querySelectorAll('img').length).toBe(0);
    // The markdown/HTML syntax is shown to the user as literal text, not
    // parsed away by a markdown/HTML renderer.
    const pre = host.querySelector('pre');
    expect(pre?.textContent).toBe(evilMarkdown);
  });

  it('renders markdown containing a raw script tag as inert literal text', async () => {
    const evilMarkdown = '<script>window.__pwned = true;</script>';

    await renderDialog('report.md', '/tmp/report.md', {
      kind: 'text',
      content: evilMarkdown,
      contentType: 'markdown',
    });

    expect(host.querySelector('script')).toBeNull();
    expect((window as typeof window & { __pwned?: boolean }).__pwned).toBeUndefined();
    expect(host.querySelector('pre')?.textContent).toBe(evilMarkdown);
  });

  it('renders CSV content as a table without executing cell content', async () => {
    await renderDialog('data.csv', '/tmp/data.csv', {
      kind: 'text',
      content: 'name,note\nalice,<script>window.__pwned = true;</script>',
      contentType: 'csv',
    });

    expect(host.querySelector('table')).not.toBeNull();
    expect(host.querySelector('script')).toBeNull();
    expect((window as typeof window & { __pwned?: boolean }).__pwned).toBeUndefined();
    const cells = Array.from(host.querySelectorAll('td')).map((cell) => cell.textContent);
    expect(cells).toContain('<script>window.__pwned = true;</script>');
  });

  it('shows an empty-state message for an empty CSV file', async () => {
    await renderDialog('empty.csv', '/tmp/empty.csv', {
      kind: 'text',
      content: '',
      contentType: 'csv',
    });

    expect(host.querySelector('table')).toBeNull();
    expect(host.textContent).toContain('This CSV file is empty.');
  });

  it('shows the resolved path as a caption', async () => {
    await renderDialog('notes.txt', '/Users/dev/workspace/notes.txt', {
      kind: 'text',
      content: 'hi',
      contentType: 'text',
    });

    expect(host.textContent).toContain('/Users/dev/workspace/notes.txt');
  });
});
