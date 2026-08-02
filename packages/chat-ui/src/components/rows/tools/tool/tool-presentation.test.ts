import { describe, expect, it } from 'vitest';
import {
  boundCodePoints,
  buildCopyText,
  buildToolParams,
  buildToolResources,
  computeHasResult,
  deriveToolPresentationStatus,
  firstLine,
  MAX_PARAM_VALUE_CHARS,
  MAX_RESULT_CHARS,
  safeToolName,
  summarizeToolText,
} from './tool-presentation';
import type { ChatToolCall } from '@/model';

// ── boundCodePoints ───────────────────────────────────────────────────────────

describe('boundCodePoints', () => {
  it('returns untouched text under the limit', () => {
    expect(boundCodePoints('hello', 10)).toEqual({ text: 'hello', truncated: false, omittedChars: 0 });
  });

  it('truncates and reports the omitted count', () => {
    expect(boundCodePoints('abcdefghij', 4)).toEqual({
      text: 'abcd',
      truncated: true,
      omittedChars: 6,
    });
  });

  it('handles empty and non-string input without throwing', () => {
    expect(boundCodePoints('', 10)).toEqual({ text: '', truncated: false, omittedChars: 0 });
    // @ts-expect-error — exercising genuinely malformed input on purpose.
    expect(boundCodePoints(null, 10)).toEqual({ text: '', truncated: false, omittedChars: 0 });
  });

  it('never bisects a surrogate pair (astral-plane characters)', () => {
    // Each of these is a single code point, encoded as a UTF-16 surrogate pair.
    const emoji = '😀😀😀😀😀';
    const result = boundCodePoints(emoji, 2);
    expect(result.truncated).toBe(true);
    expect(result.text).toBe('😀😀');
    // No lone surrogate: the kept text round-trips through Array.from with the
    // same code-point count it was built from.
    expect(Array.from(result.text)).toHaveLength(2);
  });

  it('treats a lone (unpaired) surrogate as its own code point without throwing', () => {
    const lone = '\uD800abc'; // unpaired high surrogate + ascii
    expect(() => boundCodePoints(lone, 2)).not.toThrow();
    const result = boundCodePoints(lone, 2);
    expect(result.truncated).toBe(true);
  });

  it('handles a zero/negative max defensively', () => {
    expect(boundCodePoints('abc', 0)).toEqual({ text: '', truncated: true, omittedChars: 3 });
    expect(boundCodePoints('abc', -5)).toEqual({ text: '', truncated: true, omittedChars: 3 });
  });
});

// ── summarizeToolText ─────────────────────────────────────────────────────────

describe('summarizeToolText', () => {
  it('returns undefined for absent input', () => {
    expect(summarizeToolText(undefined)).toBeUndefined();
    expect(summarizeToolText(null)).toBeUndefined();
  });

  it('returns undefined for an empty string', () => {
    expect(summarizeToolText('')).toBeUndefined();
  });

  it('bounds huge payloads to MAX_RESULT_CHARS by default', () => {
    const huge = 'x'.repeat(MAX_RESULT_CHARS + 500);
    const result = summarizeToolText(huge);
    expect(result?.truncated).toBe(true);
    expect(result?.text.length).toBe(MAX_RESULT_CHARS);
    expect(result?.omittedChars).toBe(500);
  });

  it('redacts a secret before truncation so a boundary split cannot leak a fragment', () => {
    const key = 'sk-ant-abcdefghijklmnopqrstuvwxyz0123456789';
    // No "token"/"key"/etc. keyword nearby — isolates the vendor-specific
    // pattern match rather than the more general key-name pattern.
    const result = summarizeToolText(`Authenticated with ${key} successfully`, 10_000);
    expect(result?.text).not.toContain(key);
    expect(result?.text).toContain('[REDACTED_ANTHROPIC_KEY]');
  });

  it('coerces non-string values defensively instead of throwing', () => {
    expect(() => summarizeToolText({ nested: { deeply: ['weird', 1, null] } })).not.toThrow();
    const result = summarizeToolText({ a: 1 });
    expect(result?.text.length).toBeGreaterThan(0);
  });
});

// ── deriveToolPresentationStatus ──────────────────────────────────────────────

describe('deriveToolPresentationStatus', () => {
  it('permission-pending takes precedence over everything else', () => {
    expect(
      deriveToolPresentationStatus({
        status: 'running',
        awaitingPermission: true,
        hasResult: true,
        turnCancelled: true,
      })
    ).toBe('permission-pending');
  });

  it('running when not awaiting permission', () => {
    expect(
      deriveToolPresentationStatus({
        status: 'running',
        awaitingPermission: false,
        hasResult: false,
        turnCancelled: false,
      })
    ).toBe('running');
  });

  it('error when status is error, regardless of turn outcome', () => {
    expect(
      deriveToolPresentationStatus({
        status: 'error',
        awaitingPermission: false,
        hasResult: false,
        turnCancelled: true,
      })
    ).toBe('error');
  });

  it('cancelled only when done, cancelled turn, and no result', () => {
    expect(
      deriveToolPresentationStatus({
        status: 'done',
        awaitingPermission: false,
        hasResult: false,
        turnCancelled: true,
      })
    ).toBe('cancelled');
  });

  it('a done call that produced a result is success even in a cancelled turn', () => {
    expect(
      deriveToolPresentationStatus({
        status: 'done',
        awaitingPermission: false,
        hasResult: true,
        turnCancelled: true,
      })
    ).toBe('success');
  });

  it('empty when done, not cancelled, and no result', () => {
    expect(
      deriveToolPresentationStatus({
        status: 'done',
        awaitingPermission: false,
        hasResult: false,
        turnCancelled: false,
      })
    ).toBe('empty');
  });

  it('success when done with a result', () => {
    expect(
      deriveToolPresentationStatus({
        status: 'done',
        awaitingPermission: false,
        hasResult: true,
        turnCancelled: false,
      })
    ).toBe('success');
  });
});

// ── buildToolParams / buildToolResources / computeHasResult ───────────────────

describe('buildToolParams', () => {
  it('search: query + match count', () => {
    expect(buildToolParams({ kind: 'search-tool-call', query: 'foo', matchCount: 3 })).toEqual([
      { label: 'Query', value: 'foo' },
      { label: 'Matches', value: '3' },
    ]);
  });

  it('search: omits Matches when matchCount is absent', () => {
    expect(buildToolParams({ kind: 'search-tool-call', query: 'foo' })).toEqual([
      { label: 'Query', value: 'foo' },
    ]);
  });

  it('mcp: tool + server', () => {
    expect(buildToolParams({ kind: 'mcp-tool-call', tool: 'searchIssues', server: 'linear' })).toEqual([
      { label: 'Tool', value: 'searchIssues' },
      { label: 'Server', value: 'linear' },
    ]);
  });

  it('web-fetch: url + page title', () => {
    expect(
      buildToolParams({
        kind: 'web-fetch-tool-call',
        url: 'https://example.test',
        pageTitle: 'Example',
      })
    ).toEqual([
      { label: 'URL', value: 'https://example.test' },
      { label: 'Page title', value: 'Example' },
    ]);
  });

  it('unknown: tool name + raw kind', () => {
    expect(buildToolParams({ kind: 'unknown-tool-call', name: 'vendor_tool', toolKind: 'custom' })).toEqual([
      { label: 'Tool', value: 'vendor_tool' },
      { label: 'Raw kind', value: 'custom' },
    ]);
  });

  it('degrades to an empty list for an unrecognized kind rather than throwing', () => {
    expect(buildToolParams({ kind: 'tool-group' })).toEqual([]);
  });

  it('redacts and bounds a huge/secret param value', () => {
    const huge = `key=${'y'.repeat(MAX_PARAM_VALUE_CHARS + 50)}`;
    const params = buildToolParams({ kind: 'unknown-tool-call', name: huge });
    expect(params[0].value.length).toBeLessThanOrEqual(MAX_PARAM_VALUE_CHARS);
  });

  it('never throws on deeply malformed/wrong-typed fields', () => {
    expect(() =>
      // ToolCallLike's fields are typed `unknown` so callers can pass genuinely
      // malformed provider payloads (wrong types, deep nesting) without a cast.
      buildToolParams({
        kind: 'search-tool-call',
        query: { nested: { a: [1, 2, { b: null }] } },
        matchCount: 'not-a-number',
      })
    ).not.toThrow();
  });
});

describe('buildToolResources', () => {
  it('web-fetch produces one url resource, preferring the page title as label', () => {
    expect(
      buildToolResources({
        kind: 'web-fetch-tool-call',
        url: 'https://example.test/a',
        pageTitle: 'A page',
      })
    ).toEqual([{ kind: 'url', url: 'https://example.test/a', label: 'A page' }]);
  });

  it('web-fetch falls back to the url itself as the label', () => {
    expect(buildToolResources({ kind: 'web-fetch-tool-call', url: 'https://example.test/a' })).toEqual([
      { kind: 'url', url: 'https://example.test/a', label: 'https://example.test/a' },
    ]);
  });

  it('search/mcp/unknown have no resolvable resources today', () => {
    expect(buildToolResources({ kind: 'search-tool-call', query: 'x' })).toEqual([]);
    expect(buildToolResources({ kind: 'mcp-tool-call', tool: 'x' })).toEqual([]);
    expect(buildToolResources({ kind: 'unknown-tool-call', name: 'x' })).toEqual([]);
  });
});

describe('computeHasResult', () => {
  it('true when matchCount is a positive number', () => {
    expect(computeHasResult({ kind: 'search-tool-call', matchCount: 2 }, undefined)).toBe(true);
  });

  it('false when matchCount is exactly zero, even with stray output text', () => {
    expect(
      computeHasResult(
        { kind: 'search-tool-call', matchCount: 0 },
        { text: 'noise', truncated: false, omittedChars: 0 }
      )
    ).toBe(false);
  });

  it('falls back to non-empty output text when matchCount is absent', () => {
    expect(
      computeHasResult(
        { kind: 'web-fetch-tool-call' },
        { text: 'fetched body', truncated: false, omittedChars: 0 }
      )
    ).toBe(true);
    expect(computeHasResult({ kind: 'web-fetch-tool-call' }, undefined)).toBe(false);
  });
});

// ── safeToolName ──────────────────────────────────────────────────────────────

describe('safeToolName', () => {
  it('passes a real name through', () => {
    expect(safeToolName('vendor_tool')).toBe('vendor_tool');
  });

  it('falls back for blank/whitespace-only names', () => {
    expect(safeToolName('   ')).toBe('Tool');
    expect(safeToolName('')).toBe('Tool');
  });

  it('falls back for non-string/missing names without throwing', () => {
    expect(safeToolName(undefined)).toBe('Tool');
    expect(safeToolName(null)).toBe('Tool');
    expect(safeToolName(42)).toBe('Tool');
  });
});

// ── firstLine ─────────────────────────────────────────────────────────────────

describe('firstLine', () => {
  it('returns undefined for an absent block', () => {
    expect(firstLine(undefined)).toBeUndefined();
  });

  it('returns only the first line, bounded', () => {
    expect(firstLine({ text: 'line one\nline two', truncated: false, omittedChars: 0 })).toBe(
      'line one'
    );
  });
});

// ── buildCopyText ─────────────────────────────────────────────────────────────

describe('buildCopyText', () => {
  it('includes name, params, result, and resources', () => {
    const item: ChatToolCall = {
      kind: 'tool',
      id: 't1',
      name: 'Fetch',
      status: 'done',
      params: [{ label: 'URL', value: 'https://example.test' }],
      result: { text: 'ok', truncated: false, omittedChars: 0 },
      resources: [{ kind: 'url', url: 'https://example.test', label: 'https://example.test' }],
    };
    const text = buildCopyText(item);
    expect(text).toContain('Tool: Fetch');
    expect(text).toContain('URL: https://example.test');
    expect(text).toContain('Result:');
    expect(text).toContain('ok');
    expect(text).toContain('Resource: https://example.test');
  });

  it('never throws for a minimal item with no optional fields', () => {
    const item: ChatToolCall = { kind: 'tool', id: 't2', name: 'Tool', status: 'running' };
    expect(() => buildCopyText(item)).not.toThrow();
  });
});
