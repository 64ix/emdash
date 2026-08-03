/**
 * Browser tests for the permission review surface (ticket #32, spec #18).
 *
 * Renders the real `PermissionBand` from `@emdash/ui/react/components` — the
 * exact component the composer mounts — fed with `operation` detail produced
 * by the real, non-DOM `describePermissionOperation` adapter, so command,
 * filesystem, and generic-tool cases exercise the full normalization
 * pipeline, not a hand-rolled fixture. Only the far side (resolve/retry/jump
 * callbacks) is mocked.
 *
 * Covers every scenario ticket #32's acceptance criteria call out: command,
 * filesystem, generic tool, batched (multiple requests), redacted secrets,
 * and failed resolution — plus the extra security guardrails: an
 * unrecognized option kind never becomes the auto-selected default, and
 * provider-authored content (including HTML-like strings and RTL-override
 * spoofing attempts) is always rendered as inert text, never markup.
 */
import type { ToolCallItem } from '@emdash/core/acp/client';
import { PermissionBand, type ComposerPermissionRequest } from '@emdash/ui/react/components';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { describePermissionOperation } from '@renderer/features/conversations/acp/acp-permission-presentation';

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

function toolCall(overrides: Record<string, unknown>): ToolCallItem {
  return {
    id: 'item-1',
    seq: 0,
    toolCallId: 'call-1',
    title: 'Default title',
    status: 'running',
    ...overrides,
  } as never;
}

function requestFor(
  toolCallOverrides: Record<string, unknown>,
  requestOverrides: Partial<ComposerPermissionRequest> = {}
): ComposerPermissionRequest {
  const call = toolCall(toolCallOverrides);
  return {
    requestId: 'req-1',
    title: (toolCallOverrides.title as string) ?? 'Default title',
    itemId: call.id,
    operation: describePermissionOperation(call),
    options: [
      { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'allow-always', name: 'Allow always', kind: 'allow_always' },
      { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
    ],
    ...requestOverrides,
  };
}

describe('PermissionBand — full-context permission review', () => {
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

  async function renderBand(props: Partial<React.ComponentProps<typeof PermissionBand>>) {
    const onResolve = props.onResolve ?? vi.fn();
    await act(async () => {
      root.render(
        <PermissionBand
          request={props.request ?? requestFor({ kind: 'execute-tool-call', command: 'ls' })}
          queueCount={props.queueCount}
          onResolve={onResolve}
          resolution={props.resolution}
          onRetry={props.onRetry}
          onJumpToOrigin={props.onJumpToOrigin}
        />
      );
    });
    return { onResolve };
  }

  // ── Command ─────────────────────────────────────────────────────────────────

  it('shows the exact normalized command before approval', async () => {
    const request = requestFor({
      kind: 'execute-tool-call',
      title: 'Execute a Shell Command',
      command: 'rm -rf ./build',
    });
    await renderBand({ request });

    expect(host.textContent).toContain('Execute a Shell Command');
    expect(host.textContent).toContain('Execute command'); // operationLabel
    expect(host.textContent).toContain('rm -rf ./build');
    // Details is expanded by default — the command is visible without an
    // extra click, not hidden behind a collapsed disclosure.
    const trigger = host.querySelector('[data-slot="collapsible-trigger"]');
    expect(trigger?.getAttribute('aria-expanded')).toBe('true');
  });

  it('resolves the recognized allow_once default under its exact provider label', async () => {
    const request = requestFor({ kind: 'execute-tool-call', command: 'ls' });
    const { onResolve } = await renderBand({ request });

    // Split-button primary face defaults to the recognized allow_once option,
    // labeled with the provider's exact text.
    const primaryFace = host.querySelector('button[title="Allow once"]');
    expect(primaryFace).not.toBeNull();
    await act(async () => primaryFace!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(onResolve).toHaveBeenCalledWith('allow-once');
  });

  it('exposes every other option under its exact provider label and once/always semantics', async () => {
    const request = requestFor({ kind: 'execute-tool-call', command: 'ls' });
    const { onResolve } = await renderBand({ request });

    // The non-default options (exact provider labels, once/always semantics
    // intact) live in the split-button's dropdown, portaled to the document
    // body rather than under `host` — open it to assert they are present.
    const moreOptions = host.querySelector<HTMLButtonElement>('button[aria-label="More options"]');
    expect(moreOptions).not.toBeNull();
    await act(async () => moreOptions!.click());

    expect(document.body.textContent).toContain('Allow always');
    expect(document.body.textContent).toContain('Reject');

    const rejectItem = Array.from(document.querySelectorAll('[role="menuitem"]')).find((item) =>
      item.textContent?.includes('Reject')
    );
    expect(rejectItem).toBeDefined();
    await act(async () => (rejectItem as HTMLElement).click());
    expect(onResolve).toHaveBeenCalledWith('reject-once');
  });

  // ── Filesystem ────────────────────────────────────────────────────────────────

  it('shows both sides of a file modification and the affected path', async () => {
    const request = requestFor({
      kind: 'modify-file-tool-call',
      title: 'Edit src/config.ts',
      path: 'src/config.ts',
      oldText: 'const debug = false;',
      newText: 'const debug = true;',
    });
    await renderBand({ request });

    expect(host.textContent).toContain('Modify file');
    expect(host.textContent).toContain('src/config.ts');
    expect(host.textContent).toContain('const debug = false;');
    expect(host.textContent).toContain('const debug = true;');
    expect(host.textContent).toMatch(/does not provide an undo|Overwrites/i);
  });

  it('is explicit that a delete cannot be undone by Emdash', async () => {
    const request = requestFor({
      kind: 'delete-file-tool-call',
      title: 'Delete src/old.ts',
      path: 'src/old.ts',
    });
    await renderBand({ request });

    expect(host.textContent).toContain('Delete file');
    expect(host.textContent).toContain('src/old.ts');
    expect(host.textContent).toMatch(/does not provide an undo/i);
  });

  // ── Generic tool ──────────────────────────────────────────────────────────────

  it('shows generic MCP tool params and an honest "cannot verify" risk cue', async () => {
    const request = requestFor({
      kind: 'mcp-tool-call',
      title: 'Call an MCP tool',
      tool: 'run_query',
      server: 'postgres-mcp',
    });
    await renderBand({ request });

    expect(host.textContent).toContain('Call MCP tool');
    expect(host.textContent).toContain('run_query');
    expect(host.textContent).toContain('postgres-mcp');
    expect(host.textContent).toMatch(/cannot verify/i);
  });

  it('flags an unrecognized tool request for careful review', async () => {
    const request = requestFor({
      kind: 'unknown-tool-call',
      title: 'Run a custom tool',
      name: 'vendor_custom_tool',
      toolKind: 'vendor.custom',
    });
    await renderBand({ request });

    expect(host.textContent).toContain('Unrecognized tool request');
    expect(host.textContent).toContain('vendor_custom_tool');
    expect(host.textContent).toMatch(/does not recognize/i);
  });

  // ── Batched (multiple requests) ───────────────────────────────────────────────

  it('exposes current position and remaining count across a batch of requests', async () => {
    const first = requestFor(
      { kind: 'execute-tool-call', title: 'First command', command: 'echo one' },
      { requestId: 'req-1' }
    );
    await renderBand({ request: first, queueCount: 3 });

    expect(host.textContent).toContain('(1 of 3)');

    // Resolving the first request hands the next one to the same band —
    // simulating the composer swapping `permissionRequest` as the queue
    // advances. Selection and the details disclosure must reset for the new
    // request rather than carrying over stale state.
    const second = requestFor(
      { kind: 'execute-tool-call', title: 'Second command', command: 'echo two' },
      { requestId: 'req-2' }
    );
    await renderBand({ request: second, queueCount: 2 });

    expect(host.textContent).toContain('(1 of 2)');
    expect(host.textContent).toContain('echo two');
    expect(host.textContent).not.toContain('echo one');
  });

  it('does not show a counter for a single pending request', async () => {
    await renderBand({ request: requestFor({ kind: 'execute-tool-call', command: 'ls' }) });

    expect(host.textContent).not.toContain('of 1');
  });

  // ── Redacted ──────────────────────────────────────────────────────────────────

  it('redacts a secret embedded in a command before it ever reaches the DOM', async () => {
    const secret = 'sk-ant-abcdef0123456789ABCDEFGHIJ';
    const request = requestFor({
      kind: 'execute-tool-call',
      title: 'Execute a Shell Command',
      command: `curl -H "Authorization: Bearer ${secret}" https://api.example.com`,
    });
    await renderBand({ request });

    expect(host.textContent).not.toContain(secret);
    expect(host.textContent).toContain('[REDACTED');
  });

  it('redacts a secret embedded in a URL query parameter', async () => {
    const secret = 'super-secret-api-key-value';
    const request = requestFor({
      kind: 'web-fetch-tool-call',
      title: 'Fetch a URL',
      url: `https://api.example.com/v1?api_key=${secret}`,
    });
    await renderBand({ request });

    expect(host.textContent).not.toContain(secret);
  });

  // ── Failed resolution ─────────────────────────────────────────────────────────

  it('disables the decision while resolving and shows a resolving indicator', async () => {
    const request = requestFor({ kind: 'execute-tool-call', command: 'ls' });
    await renderBand({ request, resolution: { status: 'resolving' } });

    expect(host.textContent).toContain('Resolving');
    const primaryFace = host.querySelector('button[title="Allow once"]') as HTMLButtonElement;
    expect(primaryFace.disabled).toBe(true);
  });

  it('shows a retryable error and lets the user retry without re-selecting', async () => {
    const request = requestFor({ kind: 'execute-tool-call', command: 'ls' });
    const onRetry = vi.fn();
    await renderBand({
      request,
      resolution: { status: 'error', message: 'transport hiccup' },
      onRetry,
    });

    expect(host.textContent).toContain('transport hiccup');
    const retryButton = Array.from(host.querySelectorAll('button')).find(
      (b) => b.textContent === 'Retry'
    );
    expect(retryButton).toBeDefined();

    await act(async () => retryButton!.click());
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  // ── Jump to origin ────────────────────────────────────────────────────────────

  it('jumps to the originating tool call and the band remains available to resolve', async () => {
    const request = requestFor({ kind: 'execute-tool-call', command: 'ls' });
    const onJumpToOrigin = vi.fn();
    await renderBand({ request, onJumpToOrigin });

    const jumpButton = Array.from(host.querySelectorAll('button')).find(
      (b) => b.textContent === 'View in transcript'
    );
    expect(jumpButton).toBeDefined();

    await act(async () => jumpButton!.click());
    expect(onJumpToOrigin).toHaveBeenCalledWith('item-1');

    // The band itself never scrolls away — it stays mounted and interactive
    // (a real "return to the permission surface" is a no-op because the band
    // never left).
    expect(host.querySelector('button[title="Allow once"]')).not.toBeNull();
  });

  // ── Security: unrecognized kind never auto-selects an unsafe default ────────

  it('prefers a recognized reject_* option as the default when no allow_* kind is present', async () => {
    const request = requestFor(
      { kind: 'execute-tool-call', command: 'ls' },
      {
        options: [
          { optionId: 'custom-mystery', name: 'Do something unclear', kind: 'vendor_custom' },
          { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
        ],
      }
    );
    const { onResolve } = await renderBand({ request });

    // The primary (prominent) face must show the recognized safe option, not
    // the unclassified one, and mounting must never itself fire a decision.
    const primaryFace = host.querySelector('button[title="Reject"]');
    expect(primaryFace).not.toBeNull();
    expect(host.querySelector('button[title="Do something unclear"]')).toBeNull();
    expect(onResolve).not.toHaveBeenCalled();
  });

  // ── Security: content is never markup, never fakes UI chrome ────────────────

  it('renders HTML-like command content as inert text, never as markup', async () => {
    const request = requestFor({
      kind: 'execute-tool-call',
      command: 'echo "<img src=x onerror=alert(1)>"',
    });
    await renderBand({ request });

    expect(host.querySelector('img')).toBeNull();
    expect(host.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('renders an option label containing markup-like text as inert text, never as a real control', async () => {
    const request = requestFor(
      { kind: 'execute-tool-call', command: 'ls' },
      {
        options: [
          { optionId: 'allow-once', name: '<button>Cancel</button> Allow', kind: 'allow_once' },
          { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
        ],
      }
    );
    await renderBand({ request });

    // Exactly the real controls exist — the label text never manufactured an
    // extra interactive element.
    expect(host.querySelectorAll('button').length).toBeGreaterThan(0);
    expect(
      Array.from(host.querySelectorAll('button')).filter((b) => b.textContent === 'Cancel')
    ).toHaveLength(0);
    expect(host.textContent).toContain('<button>Cancel</button> Allow');
  });

  it('strips an RTL-override spoofing attempt from the title before it reaches the DOM', async () => {
    // U+202E (RTL override) is the classic filename/label spoofing trick.
    const request: ComposerPermissionRequest = {
      requestId: 'req-1',
      title: 'Allow\u202Etxt.exe',
      itemId: 'item-1',
      options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
    };
    // Simulate the sanitization AcpChatStore.permissionQueue applies to
    // title/option labels before they ever reach this component (see
    // acp-permission-presentation.ts#sanitizeSingleLineText) — PermissionBand
    // itself renders title verbatim, so the guarantee lives at that seam.
    const { sanitizeSingleLineText } =
      await import('@renderer/features/conversations/acp/acp-permission-presentation');
    const sanitized = { ...request, title: sanitizeSingleLineText(request.title) };
    await renderBand({ request: sanitized });

    expect(host.textContent).not.toContain('\u202E');
  });
});
