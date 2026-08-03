/**
 * Unit tests for `searchTranscript` — pure and DOM-free, so this runs in the
 * `node` Vitest project without any special environment setup (mirrors
 * `state/outline.test.ts`).
 */

import { describe, expect, it } from 'vitest';
import type { TranscriptItem, TranscriptTurn } from '@/model';
import type { PendingPrompt } from './session-state';
import {
  advanceSearchResultIndex,
  searchTranscript,
  splitSnippetAtMatch,
} from './transcript-search';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function userMessage(id: string, text: string): TranscriptItem {
  return { kind: 'message', id, seq: 0, role: 'user', text };
}

function assistantMessage(id: string, text: string, seq = 1): TranscriptItem {
  return { kind: 'message', id, seq, role: 'assistant', text };
}

function thinking(id: string, text: string, seq = 1): TranscriptItem {
  return { kind: 'thinking', id, seq, segmentId: id, text, status: 'done', startedAt: 0 };
}

function readTool(
  id: string,
  opts: { path?: string; resource?: string; title?: string; inputSummary?: string } = {},
  seq = 1
): TranscriptItem {
  return {
    kind: 'read-tool-call',
    id,
    seq,
    toolCallId: id,
    title: opts.title ?? 'Read file',
    status: 'done',
    path: opts.path,
    resource: opts.resource,
    inputSummary: opts.inputSummary,
  };
}

function executeTool(
  id: string,
  opts: { command?: string; outputText?: string; status?: 'done' | 'error' | 'running' } = {},
  seq = 1
): TranscriptItem {
  return {
    kind: 'execute-tool-call',
    id,
    seq,
    toolCallId: id,
    title: 'Run command',
    status: opts.status ?? 'done',
    command: opts.command,
    outputText: opts.outputText,
  };
}

function searchTool(
  id: string,
  opts: { query?: string; outputText?: string; status?: 'done' | 'error' } = {},
  seq = 1
): TranscriptItem {
  return {
    kind: 'search-tool-call',
    id,
    seq,
    toolCallId: id,
    title: 'Search',
    status: opts.status ?? 'done',
    query: opts.query ?? '',
    outputText: opts.outputText,
  };
}

function mcpTool(
  id: string,
  opts: { server?: string; tool?: string; outputText?: string; status?: 'done' | 'error' } = {},
  seq = 1
): TranscriptItem {
  return {
    kind: 'mcp-tool-call',
    id,
    seq,
    toolCallId: id,
    title: 'MCP call',
    status: opts.status ?? 'done',
    server: opts.server,
    tool: opts.tool ?? 'unknown',
    outputText: opts.outputText,
  };
}

function resourceLink(
  id: string,
  opts: { uri: string; name: string; title?: string; description?: string },
  seq = 1
): TranscriptItem {
  return { kind: 'resource-link', id, seq, ...opts };
}

function turn(opts: {
  id: string;
  seq: number;
  items: TranscriptItem[];
  initiator?: 'user' | 'agent';
}): TranscriptTurn {
  return {
    id: opts.id,
    seq: opts.seq,
    initiator: opts.initiator ?? 'user',
    items: opts.items,
    outcome: { kind: 'done' },
  };
}

// ── Empty / no-op query ───────────────────────────────────────────────────────

describe('searchTranscript — empty query', () => {
  it('returns no results for a blank query rather than matching everything', () => {
    const t = turn({ id: 't1', seq: 0, items: [userMessage('u1', 'hello world')] });
    expect(searchTranscript([t], null, null, '')).toEqual([]);
    expect(searchTranscript([t], null, null, '   ')).toEqual([]);
  });
});

// ── Field coverage ────────────────────────────────────────────────────────────

describe('searchTranscript — field coverage', () => {
  it('matches user message text as a prompt result', () => {
    const t = turn({ id: 't1', seq: 0, items: [userMessage('u1', 'What does parseConfig do?')] });
    const [result] = searchTranscript([t], null, null, 'parseconfig');
    expect(result).toMatchObject({ itemId: 'u1', turnId: 't1', kind: 'prompt' });
    expect(result.snippet).toContain('parseConfig');
  });

  it('matches assistant message text as a response result', () => {
    const t = turn({
      id: 't1',
      seq: 0,
      items: [assistantMessage('a1', 'The function sums two numbers.')],
    });
    const [result] = searchTranscript([t], null, null, 'sums two');
    expect(result).toMatchObject({ itemId: 'a1', kind: 'response' });
  });

  it('matches thinking text', () => {
    const t = turn({ id: 't1', seq: 0, items: [thinking('th1', 'Let me check the stack trace')] });
    const [result] = searchTranscript([t], null, null, 'stack trace');
    expect(result).toMatchObject({ itemId: 'th1', kind: 'thinking' });
  });

  it('matches a workspace path on a read tool call', () => {
    const t = turn({
      id: 't1',
      seq: 0,
      items: [readTool('r1', { path: 'src/features/tasks/task-store.ts' })],
    });
    const [result] = searchTranscript([t], null, null, 'task-store');
    expect(result).toMatchObject({ itemId: 'r1', kind: 'path' });
    expect(result.snippet).toContain('task-store.ts');
  });

  it('matches a read tool resource field as a path result', () => {
    const t = turn({
      id: 't1',
      seq: 0,
      items: [readTool('r1', { resource: 'resource://config/app' })],
    });
    const [result] = searchTranscript([t], null, null, 'config/app');
    expect(result).toMatchObject({ itemId: 'r1', kind: 'path' });
  });

  it('falls back to title/inputSummary when no type-specific field matches', () => {
    const t = turn({
      id: 't1',
      seq: 0,
      items: [readTool('r1', { path: 'a.ts', inputSummary: 'Read the AGENTS guardrails file' })],
    });
    const [result] = searchTranscript([t], null, null, 'guardrails');
    expect(result).toMatchObject({ itemId: 'r1', kind: 'tool' });
  });

  it('matches an execute tool call command', () => {
    const t = turn({
      id: 't1',
      seq: 0,
      items: [executeTool('e1', { command: 'pnpm run typecheck' })],
    });
    const [result] = searchTranscript([t], null, null, 'typecheck');
    expect(result).toMatchObject({ itemId: 'e1', kind: 'tool' });
  });

  it('matches a search tool call query', () => {
    const t = turn({
      id: 't1',
      seq: 0,
      items: [searchTool('s1', { query: 'scrollToTranscriptItem' })],
    });
    const [result] = searchTranscript([t], null, null, 'scrolltotranscript');
    expect(result).toMatchObject({ itemId: 's1', kind: 'tool' });
  });

  it('matches an mcp tool call server/tool identity', () => {
    const t = turn({
      id: 't1',
      seq: 0,
      items: [mcpTool('m1', { server: 'github', tool: 'search_issues' })],
    });
    const [result] = searchTranscript([t], null, null, 'search_issues');
    expect(result).toMatchObject({ itemId: 'm1', kind: 'tool' });
  });

  it('matches successful tool output as a tool-result', () => {
    const t = turn({
      id: 't1',
      seq: 0,
      items: [
        executeTool('e1', { command: 'ls', outputText: 'index.ts\npackage.json', status: 'done' }),
      ],
    });
    const [result] = searchTranscript([t], null, null, 'package.json');
    expect(result).toMatchObject({ itemId: 'e1', kind: 'tool-result' });
  });

  it('matches failed tool output as a tool-error', () => {
    const t = turn({
      id: 't1',
      seq: 0,
      items: [
        executeTool('e1', { command: 'ls', outputText: 'permission denied', status: 'error' }),
      ],
    });
    const [result] = searchTranscript([t], null, null, 'permission denied');
    expect(result).toMatchObject({ itemId: 'e1', kind: 'tool-error' });
  });

  it('matches a resource-link title/name/description/uri', () => {
    const t = turn({
      id: 't1',
      seq: 0,
      items: [
        resourceLink('rl1', {
          uri: 'file:///workspace/src/foo.ts',
          name: 'foo.ts',
          title: 'Generated diagram',
          description: 'An architecture overview',
        }),
      ],
    });
    expect(searchTranscript([t], null, null, 'diagram')[0]).toMatchObject({
      itemId: 'rl1',
      kind: 'resource',
    });
    expect(searchTranscript([t], null, null, 'architecture overview')[0]).toMatchObject({
      itemId: 'rl1',
      kind: 'resource',
    });
    expect(searchTranscript([t], null, null, 'workspace/src/foo')[0]).toMatchObject({
      itemId: 'rl1',
      kind: 'path',
    });
  });
});

// ── Case sensitivity ──────────────────────────────────────────────────────────

describe('searchTranscript — case sensitivity', () => {
  it('matches regardless of query/content case', () => {
    const t = turn({ id: 't1', seq: 0, items: [userMessage('u1', 'Fix the OAuth Redirect Bug')] });
    expect(searchTranscript([t], null, null, 'oauth redirect')).toHaveLength(1);
    expect(searchTranscript([t], null, null, 'OAUTH REDIRECT')).toHaveLength(1);
  });
});

// ── Redaction ─────────────────────────────────────────────────────────────────

describe('searchTranscript — redaction', () => {
  it('never surfaces a secret pattern hidden inside tool output', () => {
    const t = turn({
      id: 't1',
      seq: 0,
      items: [
        executeTool('e1', { command: 'env', outputText: 'token=sk-livesecretvalue1234567890' }),
      ],
    });

    // The raw secret value is not found post-redaction.
    expect(searchTranscript([t], null, null, 'sk-livesecretvalue')).toEqual([]);

    // But the redaction placeholder itself, and the surrounding text, are searchable.
    const [result] = searchTranscript([t], null, null, 'REDACTED');
    expect(result).toMatchObject({ itemId: 'e1', kind: 'tool-result' });
    expect(result.snippet).not.toContain('sk-livesecretvalue');
  });
});

// ── Truncation honesty ────────────────────────────────────────────────────────

describe('searchTranscript — matches beyond the tool inspector display bound', () => {
  it('still finds and returns a match far past the 4000-char display bound', () => {
    const filler = 'x'.repeat(5000);
    const outputText = `${filler} needle-far-past-display-bound ${filler}`;
    const t = turn({
      id: 't1',
      seq: 0,
      items: [executeTool('e1', { command: 'cat file', outputText })],
    });

    const [result] = searchTranscript([t], null, null, 'needle-far-past-display-bound');
    expect(result).toBeDefined();
    expect(result.itemId).toBe('e1');
    expect(result.snippet).toContain('needle-far-past-display-bound');
    // The snippet is a small window, not the whole 10K+ char field.
    expect(result.snippet.length).toBeLessThan(200);
  });

  it('windows the snippet around the match rather than truncating from the start', () => {
    const t = turn({
      id: 't1',
      seq: 0,
      items: [
        executeTool('e1', {
          command: 'cat',
          outputText: `${'a'.repeat(100)} MATCHME ${'b'.repeat(100)}`,
        }),
      ],
    });

    const [result] = searchTranscript([t], null, null, 'matchme', { contextCodePoints: 5 });
    expect(result.snippet.toLowerCase()).toContain('matchme');
    expect(result.snippet.startsWith('…')).toBe(true);
    expect(result.snippet.endsWith('…')).toBe(true);
  });
});

// ── Grapheme safety ───────────────────────────────────────────────────────────

describe('searchTranscript — grapheme-safe snippets', () => {
  it('never splits a surrogate pair when windowing near an emoji', () => {
    const emoji = '🎉'.repeat(60); // astral-plane codepoints, 2 UTF-16 units each
    const t = turn({
      id: 't1',
      seq: 0,
      items: [assistantMessage('a1', `${emoji} the target phrase ${emoji}`)],
    });

    const [result] = searchTranscript([t], null, null, 'target phrase');
    expect(result).toBeDefined();
    // No lone surrogate anywhere in the produced snippet.
    // eslint-disable-next-line no-control-regex
    expect(
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]/.test(
        result.snippet
      )
    ).toBe(false);
  });
});

// ── Ordering, active turn, pending prompt ────────────────────────────────────

describe('searchTranscript — chronological ordering', () => {
  it('orders results by turn, then item order within a turn', () => {
    const t1 = turn({
      id: 't1',
      seq: 0,
      items: [userMessage('u1', 'find alpha'), assistantMessage('a1', 'alpha found here')],
    });
    const t2 = turn({
      id: 't2',
      seq: 1,
      items: [userMessage('u2', 'another alpha question')],
    });

    const results = searchTranscript([t1, t2], null, null, 'alpha');
    expect(results.map((r) => r.itemId)).toEqual(['u1', 'a1', 'u2']);
  });

  it('includes the active turn after committed turns', () => {
    const committed = turn({ id: 't1', seq: 0, items: [userMessage('u1', 'alpha in history')] });
    const active = turn({ id: 't2', seq: 1, items: [userMessage('u2', 'alpha live')] });

    const results = searchTranscript([committed], active, null, 'alpha');
    expect(results.map((r) => r.itemId)).toEqual(['u1', 'u2']);
  });

  it('includes a matching pendingPrompt only when there is no activeTurn yet', () => {
    const pendingPrompt: PendingPrompt = { id: 'pending-1', text: 'alpha pending' };
    const results = searchTranscript([], null, pendingPrompt, 'alpha');
    expect(results).toEqual([
      expect.objectContaining({
        itemId: 'pending-1',
        turnId: 'pending:pending-1:turn',
        kind: 'prompt',
      }),
    ]);
  });

  it('prefers the activeTurn over a stale non-matching pendingPrompt', () => {
    const active = turn({
      id: 't-active',
      seq: 5,
      items: [userMessage('pending-1', 'alpha now active')],
    });
    const pendingPrompt: PendingPrompt = { id: 'pending-1', text: 'alpha now active' };

    const results = searchTranscript([], active, pendingPrompt, 'alpha');
    expect(results).toHaveLength(1);
    expect(results[0].itemId).toBe('pending-1');
  });
});

// ── Pagination stability (no duplicates, no reordering) ──────────────────────

describe('searchTranscript — pagination stability', () => {
  it('prepending an older page never duplicates or reorders already-derived results', () => {
    const recent = [
      turn({ id: 't10', seq: 10, items: [userMessage('u10', 'alpha recent')] }),
      turn({ id: 't11', seq: 11, items: [userMessage('u11', 'alpha newest')] }),
    ];
    const before = searchTranscript(recent, null, null, 'alpha');

    const olderPage = [
      turn({ id: 't8', seq: 8, items: [userMessage('u8', 'alpha older')] }),
      turn({ id: 't9', seq: 9, items: [userMessage('u9', 'alpha older 2')] }),
    ];
    const after = searchTranscript([...olderPage, ...recent], null, null, 'alpha');

    expect(after.slice(-before.length)).toEqual(before);
    const ids = after.map((r) => r.itemId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.slice(0, 2)).toEqual(['u8', 'u9']);
  });
});

// ── One result per item ───────────────────────────────────────────────────────

describe('searchTranscript — one result per item', () => {
  it('never emits two results for the same item even when multiple fields match', () => {
    const t = turn({
      id: 't1',
      seq: 0,
      items: [readTool('r1', { path: 'src/alpha.ts', inputSummary: 'Read alpha configuration' })],
    });
    const results = searchTranscript([t], null, null, 'alpha');
    expect(results).toHaveLength(1);
    expect(results[0].kind).toBe('path'); // path is checked before the tool fallback
  });
});

// ── advanceSearchResultIndex ──────────────────────────────────────────────────

describe('advanceSearchResultIndex', () => {
  it('returns null when there are no results', () => {
    expect(advanceSearchResultIndex(0, null, 1)).toBeNull();
    expect(advanceSearchResultIndex(0, null, -1)).toBeNull();
  });

  it('starts at the first result going forward, last result going backward', () => {
    expect(advanceSearchResultIndex(3, null, 1)).toBe(0);
    expect(advanceSearchResultIndex(3, null, -1)).toBe(2);
  });

  it('wraps around forward past the last result', () => {
    expect(advanceSearchResultIndex(3, 2, 1)).toBe(0);
  });

  it('wraps around backward past the first result', () => {
    expect(advanceSearchResultIndex(3, 0, -1)).toBe(2);
  });

  it('steps forward/backward within bounds', () => {
    expect(advanceSearchResultIndex(3, 0, 1)).toBe(1);
    expect(advanceSearchResultIndex(3, 1, -1)).toBe(0);
  });
});

// ── splitSnippetAtMatch ────────────────────────────────────────────────────────

describe('splitSnippetAtMatch', () => {
  it('splits a plain-ASCII snippet into before/match/after', () => {
    expect(
      splitSnippetAtMatch({ snippet: 'the quick brown fox', matchStart: 4, matchLength: 5 })
    ).toEqual({ before: 'the ', match: 'quick', after: ' brown fox' });
  });

  it('splits using code-point offsets, never bisecting a surrogate pair', () => {
    // '🎉' is one code point but two UTF-16 code units; matchStart counts code
    // points, so index 1 must land right after the emoji, not mid-surrogate.
    const snippet = '🎉MATCH tail';
    const { before, match, after } = splitSnippetAtMatch({
      snippet,
      matchStart: 1,
      matchLength: 5,
    });
    expect(before).toBe('🎉');
    expect(match).toBe('MATCH');
    expect(after).toBe(' tail');
    // No lone surrogate in any piece.
    for (const piece of [before, match, after]) {
      // eslint-disable-next-line no-control-regex
      expect(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]/.test(piece)
      ).toBe(false);
    }
  });

  it('clamps an out-of-range matchStart/matchLength instead of throwing', () => {
    expect(splitSnippetAtMatch({ snippet: 'short', matchStart: 100, matchLength: 5 })).toEqual({
      before: 'short',
      match: '',
      after: '',
    });
    expect(splitSnippetAtMatch({ snippet: 'short', matchStart: -5, matchLength: 3 })).toEqual({
      before: '',
      match: 'sho',
      after: 'rt',
    });
  });

  it('round-trips: before + match + after reconstructs the snippet', () => {
    const snippet = 'redacted [REDACTED] value here';
    const matchStart = snippet.indexOf('REDACTED');
    const { before, match, after } = splitSnippetAtMatch({
      snippet,
      matchStart,
      matchLength: 'REDACTED'.length,
    });
    expect(before + match + after).toBe(snippet);
    expect(match).toBe('REDACTED');
  });
});
