import type { SegmentCtx } from '@core/units';
import { describe, expect, it } from 'vitest';
import type { ToolNode } from '@/model';
import { toolFromItem } from './tool-presentation';

function searchItem(overrides: Partial<Extract<ToolNode, { kind: 'search-tool-call' }>> = {}) {
  return {
    kind: 'search-tool-call',
    id: 'search-1',
    seq: 0,
    toolCallId: 'call-1',
    title: 'Search',
    status: 'done',
    query: 'default query',
    ...overrides,
  } satisfies Extract<ToolNode, { kind: 'search-tool-call' }>;
}

function fetchItem(overrides: Partial<Extract<ToolNode, { kind: 'web-fetch-tool-call' }>> = {}) {
  return {
    kind: 'web-fetch-tool-call',
    id: 'fetch-1',
    seq: 0,
    toolCallId: 'call-2',
    title: 'https://example.test',
    status: 'done',
    url: 'https://example.test',
    ...overrides,
  } satisfies Extract<ToolNode, { kind: 'web-fetch-tool-call' }>;
}

function unknownItem(overrides: Partial<Extract<ToolNode, { kind: 'unknown-tool-call' }>> = {}) {
  return {
    kind: 'unknown-tool-call',
    id: 'unknown-1',
    seq: 0,
    toolCallId: 'call-3',
    title: 'vendor_widget',
    status: 'done',
    toolKind: 'vendor-specific',
    name: 'vendor_widget',
    ...overrides,
  } satisfies Extract<ToolNode, { kind: 'unknown-tool-call' }>;
}

function baseCtx(overrides: Partial<SegmentCtx> = {}): SegmentCtx {
  return {
    caches: {} as SegmentCtx['caches'],
    expanded: () => false,
    active: false,
    plan: () => null,
    pendingToolCallIds: () => new Set<string>(),
    terminalOutputText: () => null,
    ...overrides,
  };
}

describe('toolFromItem', () => {
  it('preserves raw search queries that begin with search', () => {
    expect(
      toolFromItem(searchItem({ query: 'search engine optimization' }), baseCtx())
    ).toMatchObject({
      name: 'Search',
      inputSummary: 'search engine optimization',
    });
  });

  it('preserves search summaries without the redundant prefix', () => {
    expect(
      toolFromItem(searchItem({ query: 'SolidJS virtualized list patterns' }), baseCtx())
    ).toMatchObject({
      name: 'Search',
      inputSummary: 'SolidJS virtualized list patterns',
    });
  });

  // ── Presentation model shape ────────────────────────────────────────────────

  it('builds normalized params for a search call', () => {
    const result = toolFromItem(searchItem({ query: 'foo', matchCount: 5 }), baseCtx());
    expect(result.params).toEqual([
      { label: 'Query', value: 'foo' },
      { label: 'Matches', value: '5' },
    ]);
  });

  it('builds a resource for a fetch call using the page title as label', () => {
    const result = toolFromItem(fetchItem({ pageTitle: 'Example Domain' }), baseCtx());
    expect(result.resources).toEqual([
      { kind: 'url', url: 'https://example.test', label: 'Example Domain' },
    ]);
  });

  it('does not enrich tool-group headers with the generic-inspector fields', () => {
    const group: ToolNode = {
      kind: 'tool-group',
      id: 'group-1',
      seq: 0,
      label: '2 file reads',
      groupKind: 'read-batch',
      status: 'done',
      children: [],
    };
    const result = toolFromItem(group, baseCtx());
    expect(result.name).toBe('2 file reads');
    expect(result.params).toBeUndefined();
    expect(result.presentationStatus).toBeUndefined();
  });

  // ── Status derivation end-to-end ────────────────────────────────────────────

  it('running status with no output', () => {
    const result = toolFromItem(fetchItem({ status: 'running' }), baseCtx());
    expect(result.presentationStatus).toBe('running');
  });

  it('permission-pending overrides running when awaiting permission', () => {
    const item = fetchItem({ status: 'running', toolCallId: 'call-pending' });
    const ctx = baseCtx({ pendingToolCallIds: () => new Set(['call-pending']) });
    expect(toolFromItem(item, ctx).presentationStatus).toBe('permission-pending');
  });

  it('error status carries the output text as errorDetail + a bounded one-line error', () => {
    const item = unknownItem({ status: 'error', outputText: 'boom\nmore detail' });
    const result = toolFromItem(item, baseCtx());
    expect(result.presentationStatus).toBe('error');
    expect(result.errorDetail?.text).toBe('boom\nmore detail');
    expect(result.error).toBe('boom');
    expect(result.result).toBeUndefined();
  });

  it('empty status when done with no matches and no output', () => {
    const result = toolFromItem(searchItem({ status: 'done', matchCount: 0 }), baseCtx());
    expect(result.presentationStatus).toBe('empty');
  });

  it('success status when done with matches', () => {
    const result = toolFromItem(searchItem({ status: 'done', matchCount: 3 }), baseCtx());
    expect(result.presentationStatus).toBe('success');
  });

  it('cancelled status when done, no result, and the owning turn was cancelled', () => {
    const ctx = baseCtx({ turnOutcome: () => ({ kind: 'cancelled' }) });
    const result = toolFromItem(fetchItem({ status: 'done' }), ctx);
    expect(result.presentationStatus).toBe('cancelled');
  });

  it('a cancelled turn does not demote a call that produced a real result', () => {
    const ctx = baseCtx({ turnOutcome: () => ({ kind: 'cancelled' }) });
    const result = toolFromItem(fetchItem({ status: 'done', outputText: 'fetched body' }), ctx);
    expect(result.presentationStatus).toBe('success');
  });

  // ── Safe fallback for unknown tool calls ────────────────────────────────────

  it('falls back to a safe display name for a blank unknown tool name', () => {
    const result = toolFromItem(unknownItem({ name: '   ' }), baseCtx());
    expect(result.name).toBe('Tool');
  });

  it('keeps the raw provider kind as a secondary diagnostic, never the display name', () => {
    const result = toolFromItem(unknownItem({ toolKind: 'weird_vendor_kind' }), baseCtx());
    expect(result.rawToolKind).toBe('weird_vendor_kind');
    expect(result.name).not.toBe('weird_vendor_kind');
  });

  // ── Redaction ────────────────────────────────────────────────────────────────

  it('redacts a secret inside the result text', () => {
    const result = toolFromItem(
      fetchItem({ outputText: 'Authenticated with sk-ant-abcdefghijklmnopqrstuvwxyz01 done' }),
      baseCtx()
    );
    expect(result.result?.text).not.toContain('sk-ant-abcdefghijklmnopqrstuvwxyz01');
    expect(result.result?.text).toContain('[REDACTED_ANTHROPIC_KEY]');
  });

  // ── Malformed input never crashes ────────────────────────────────────────────

  it('degrades gracefully for a genuinely malformed unknown-tool-call payload', () => {
    const malformed = {
      kind: 'unknown-tool-call',
      id: 'bad-1',
      seq: 0,
      toolCallId: 'bad-call',
      title: undefined,
      status: 'done',
      toolKind: { unexpected: 'object' },
      name: 12345,
      outputText: { deeply: { nested: ['x', null, undefined] } },
    } as unknown as ToolNode;

    expect(() => toolFromItem(malformed, baseCtx())).not.toThrow();
    const result = toolFromItem(malformed, baseCtx());
    expect(typeof result.name).toBe('string');
    expect(result.name.length).toBeGreaterThan(0);
  });

  it('degrades gracefully for a huge result payload without throwing or blowing past bounds', () => {
    const huge = 'x'.repeat(50_000);
    const result = toolFromItem(unknownItem({ outputText: huge }), baseCtx());
    expect(result.result?.truncated).toBe(true);
    expect(result.result?.text.length).toBeLessThan(huge.length);
  });
});
