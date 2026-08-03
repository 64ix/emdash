/**
 * Browser contract tests for the generic tool inspector (ticket #30).
 *
 * Runs the full pipeline — TranscriptTurn -> flatten -> toolFromItem -> Tool.tsx
 * -> CollapsibleCard — in real Chromium DOM, so a regression in any seam
 * between the adapter and the renderer shows up here even though each piece
 * also has isolated unit coverage (tool-presentation.test.ts, tool.def.test.ts).
 */

import { DEFAULT_THEME } from '@core/theme';
import { describe, expect, it } from 'vitest';
import { createChatContext } from '@/chat-context';
import { createChatView } from '@/chat-view';
import type { AcpPermissionRequest, ToolNode, TranscriptTurn } from '@/model';
import { createChatState } from '@/state/chat-state';

// ── Helpers ───────────────────────────────────────────────────────────────────

const nextPaint = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

async function waitFor<T>(fn: () => T | null, frames = 10): Promise<T | null> {
  for (let i = 0; i < frames; i++) {
    const value = fn();
    if (value) return value;
    await nextPaint();
  }
  return null;
}

function mount(items: ToolNode[], outcome?: TranscriptTurn['outcome']) {
  const ctx = createChatContext({ theme: DEFAULT_THEME });
  const state = createChatState(ctx);
  const turn: TranscriptTurn = {
    id: 'turn-1',
    seq: 0,
    initiator: 'agent',
    items: items as TranscriptTurn['items'],
    ...(outcome ? { outcome } : {}),
  };
  state.transcript.history.seed([turn]);

  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;top:0;left:0;width:800px;height:600px;';
  document.body.appendChild(host);

  const view = createChatView({ context: ctx, state, parent: host });

  return {
    host,
    dispose: () => {
      view.dispose();
      ctx.dispose();
      state.dispose();
      document.body.removeChild(host);
    },
  };
}

async function expandById(host: HTMLElement, id: string): Promise<HTMLElement> {
  const header = await waitFor(
    () => host.querySelector(`[data-collapse-id="${id}"]`) as HTMLElement | null
  );
  expect(header).not.toBeNull();
  header!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await nextPaint();
  return header!;
}

function searchNode(overrides: Partial<Extract<ToolNode, { kind: 'search-tool-call' }>> = {}) {
  return {
    kind: 'search-tool-call',
    id: 'search-1',
    seq: 0,
    toolCallId: 'search-1',
    title: 'Search',
    status: 'done',
    query: 'virtualized list patterns',
    matchCount: 4,
    ...overrides,
  } satisfies Extract<ToolNode, { kind: 'search-tool-call' }>;
}

function mcpNode(overrides: Partial<Extract<ToolNode, { kind: 'mcp-tool-call' }>> = {}) {
  return {
    kind: 'mcp-tool-call',
    id: 'mcp-1',
    seq: 0,
    toolCallId: 'mcp-1',
    title: 'linear.searchIssues',
    status: 'done',
    tool: 'linear.searchIssues',
    server: 'linear',
    ...overrides,
  } satisfies Extract<ToolNode, { kind: 'mcp-tool-call' }>;
}

function fetchNode(overrides: Partial<Extract<ToolNode, { kind: 'web-fetch-tool-call' }>> = {}) {
  return {
    kind: 'web-fetch-tool-call',
    id: 'fetch-1',
    seq: 0,
    toolCallId: 'fetch-1',
    title: 'https://example.test',
    status: 'done',
    url: 'https://example.test',
    pageTitle: 'Example Domain',
    ...overrides,
  } satisfies Extract<ToolNode, { kind: 'web-fetch-tool-call' }>;
}

function unknownNode(overrides: Partial<Extract<ToolNode, { kind: 'unknown-tool-call' }>> = {}) {
  return {
    kind: 'unknown-tool-call',
    id: 'unknown-1',
    seq: 0,
    toolCallId: 'unknown-1',
    title: 'vendor_widget',
    status: 'done',
    toolKind: 'vendor-specific',
    name: 'vendor_widget',
    ...overrides,
  } satisfies Extract<ToolNode, { kind: 'unknown-tool-call' }>;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Tool — semantic kinds render distinctly', () => {
  it('search, mcp, fetch, and unknown calls mount and show their display name', async () => {
    const { host, dispose } = mount([searchNode(), mcpNode(), fetchNode(), unknownNode()]);
    await nextPaint();

    expect(host.querySelector('[data-collapse-id="search-1"]')?.textContent).toContain('Search');
    expect(host.querySelector('[data-collapse-id="mcp-1"]')?.textContent).toContain('MCP');
    expect(host.querySelector('[data-collapse-id="fetch-1"]')?.textContent).toContain('Fetch');
    expect(host.querySelector('[data-collapse-id="unknown-1"]')?.textContent).toContain(
      'vendor_widget'
    );

    dispose();
  });

  it('expanding a call reveals normalized params and a result preview', async () => {
    const { host, dispose } = mount([fetchNode({ outputText: 'fetched body text' })]);
    await nextPaint();

    const header = await expandById(host, 'fetch-1');
    expect(header.getAttribute('aria-expanded')).toBe('true');
    expect(host.textContent).toContain('https://example.test');
    expect(host.textContent).toContain('Example Domain');
    expect(host.textContent).toContain('fetched body text');

    dispose();
  });

  it('an error call marks the header errored and shows the error detail when expanded', async () => {
    const { host, dispose } = mount([
      unknownNode({ status: 'error', outputText: 'boom: connection refused' }),
    ]);
    await nextPaint();

    expect(host.querySelector('[aria-label="error"]')).not.toBeNull();

    await expandById(host, 'unknown-1');
    expect(host.textContent).toContain('boom: connection refused');

    dispose();
  });

  it('empty and cancelled calls show a distinguishing badge without expanding', async () => {
    const empty = mount([searchNode({ status: 'done', matchCount: 0 })]);
    await nextPaint();
    expect(empty.host.textContent).toContain('No results');
    empty.dispose();

    const cancelled = mount([fetchNode({ status: 'done', outputText: undefined })], {
      kind: 'cancelled',
    });
    await nextPaint();
    expect(cancelled.host.textContent).toContain('Cancelled');
    cancelled.dispose();
  });

  it('redacts a secret end-to-end in the rendered result', async () => {
    const secret = 'sk-ant-abcdefghijklmnopqrstuvwxyz0123456789';
    const { host, dispose } = mount([
      fetchNode({ outputText: `Authenticated with ${secret} successfully` }),
    ]);
    await nextPaint();
    await expandById(host, 'fetch-1');

    expect(host.textContent).not.toContain(secret);
    expect(host.textContent).toContain('[REDACTED_ANTHROPIC_KEY]');

    dispose();
  });

  it('a genuinely malformed unknown tool call renders without throwing or blanking', async () => {
    const malformed = {
      kind: 'unknown-tool-call',
      id: 'bad-1',
      seq: 0,
      toolCallId: 'bad-1',
      title: undefined,
      status: 'done',
      toolKind: { unexpected: 'object' },
      name: 12345,
      outputText: 'x'.repeat(50_000),
    } as unknown as ToolNode;

    const { host, dispose } = mount([malformed]);
    await expect(nextPaint()).resolves.toBeUndefined();

    const header = host.querySelector('[data-collapse-id="bad-1"]');
    expect(header).not.toBeNull();
    expect(header!.textContent!.length).toBeGreaterThan(0);

    await expandById(host, 'bad-1');
    expect(host.textContent).toContain('truncated');

    dispose();
  });
});

describe('Tool — permission-pending state', () => {
  it('shows the awaiting-permission affordance once a permission request references the call', async () => {
    const item = searchNode({ status: 'running', matchCount: undefined });
    const ctx = createChatContext({ theme: DEFAULT_THEME });
    const state = createChatState(ctx);
    const turn: TranscriptTurn = {
      id: 'turn-1',
      seq: 0,
      initiator: 'agent',
      items: [item] as TranscriptTurn['items'],
    };
    state.transcript.history.seed([turn]);

    const permission: AcpPermissionRequest = {
      requestId: 'req-1',
      toolCall: item,
      options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
    };
    state.session.setPermissions([permission]);

    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;top:0;left:0;width:800px;height:600px;';
    document.body.appendChild(host);
    const view = createChatView({ context: ctx, state, parent: host });
    await nextPaint();

    expect(host.querySelector('[aria-label="awaiting permission"]')).not.toBeNull();

    view.dispose();
    ctx.dispose();
    state.dispose();
    document.body.removeChild(host);
  });
});
