import type { TranscriptItem, TranscriptTurn } from '@emdash/core/acp/client';
import { describe, expect, it } from 'vitest';
import {
  buildAttentionQueue,
  deriveErrorAttentionSources,
  isAttentionTargetVisible,
  type AttentionQueueSources,
} from './acp-attention-queue';

function emptySources(): AttentionQueueSources {
  return { permissions: [], failedSubmissions: [], errors: [] };
}

// ── buildAttentionQueue ───────────────────────────────────────────────────────

describe('buildAttentionQueue', () => {
  it('returns an empty queue for empty sources', () => {
    expect(buildAttentionQueue(emptySources())).toEqual([]);
  });

  it('orders permission, question, failed-submission, error deterministically — even when items arrive in the same recomputation', () => {
    const queue = buildAttentionQueue({
      // Deliberately listed out of priority order in the input to prove the
      // output order is not simply "whatever order the caller passed things".
      errors: [{ id: 'e1', itemId: 'item-e1', summary: 'Tool failed: ls' }],
      failedSubmissions: [{ localId: 'sub-1', summary: 'Hello' }],
      questions: [{ id: 'q1', itemId: 'item-q1', summary: 'Which branch?' }],
      permissions: [{ requestId: 'req-1', itemId: 'item-p1', summary: 'Execute a Shell Command' }],
    });

    expect(queue.map((item) => item.kind)).toEqual([
      'permission',
      'question',
      'failed-submission',
      'error',
    ]);
    expect(queue.map((item) => item.id)).toEqual([
      'permission:req-1',
      'question:q1',
      'failed-submission:sub-1',
      'error:e1',
    ]);
  });

  it('preserves each source’s own order within its priority group', () => {
    const queue = buildAttentionQueue({
      ...emptySources(),
      permissions: [
        { requestId: 'req-1', itemId: 'a', summary: 'first' },
        { requestId: 'req-2', itemId: 'b', summary: 'second' },
      ],
    });
    expect(queue.map((item) => item.id)).toEqual(['permission:req-1', 'permission:req-2']);
  });

  it('deduplicates a repeated id, keeping only the first occurrence', () => {
    const queue = buildAttentionQueue({
      ...emptySources(),
      permissions: [
        { requestId: 'req-1', itemId: 'a', summary: 'first' },
        { requestId: 'req-1', itemId: 'a-again', summary: 'stale duplicate' },
      ],
    });
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ id: 'permission:req-1', summary: 'first' });
  });

  it('sets composer targets for failed submissions and transcript targets for everything else', () => {
    const queue = buildAttentionQueue({
      permissions: [{ requestId: 'req-1', itemId: 'item-1', summary: 'p' }],
      questions: [{ id: 'q1', itemId: 'item-2', summary: 'q' }],
      failedSubmissions: [{ localId: 'sub-1', summary: 'f' }],
      errors: [{ id: 'e1', itemId: 'item-3', summary: 'e' }],
    });
    expect(queue.find((i) => i.kind === 'permission')?.target).toEqual({
      kind: 'transcript',
      itemId: 'item-1',
    });
    expect(queue.find((i) => i.kind === 'question')?.target).toEqual({
      kind: 'transcript',
      itemId: 'item-2',
    });
    expect(queue.find((i) => i.kind === 'failed-submission')?.target).toEqual({ kind: 'composer' });
    expect(queue.find((i) => i.kind === 'error')?.target).toEqual({
      kind: 'transcript',
      itemId: 'item-3',
    });
  });
});

// ── isAttentionTargetVisible ──────────────────────────────────────────────────

describe('isAttentionTargetVisible', () => {
  it('is always visible for a composer target, regardless of atBottom', () => {
    expect(isAttentionTargetVisible({ kind: 'composer' }, false)).toBe(true);
    expect(isAttentionTargetVisible({ kind: 'composer' }, true)).toBe(true);
  });

  it('is visible for a transcript target only when the transcript is at the tail', () => {
    const target = { kind: 'transcript' as const, itemId: 'item-1' };
    expect(isAttentionTargetVisible(target, true)).toBe(true);
    expect(isAttentionTargetVisible(target, false)).toBe(false);
  });
});

// ── deriveErrorAttentionSources ───────────────────────────────────────────────

function message(
  id: string,
  seq: number,
  role: 'user' | 'assistant',
  text: string
): TranscriptItem {
  return { kind: 'message', id, seq, role, text };
}

function toolCall(overrides: Record<string, unknown>): TranscriptItem {
  return {
    kind: 'execute-tool-call',
    id: 'tool-1',
    seq: 1,
    toolCallId: 'call-1',
    title: 'Run the build',
    status: 'done',
    ...overrides,
  } as TranscriptItem;
}

function turn(overrides: Partial<TranscriptTurn>): TranscriptTurn {
  return {
    id: 'turn-1',
    seq: 1,
    initiator: 'agent',
    items: [],
    ...overrides,
  };
}

describe('deriveErrorAttentionSources', () => {
  it('returns nothing when there is no committed or active turn', () => {
    expect(deriveErrorAttentionSources(null, null)).toEqual([]);
  });

  it('returns nothing for a successfully completed last turn with no tool errors', () => {
    const t = turn({ outcome: { kind: 'done' }, items: [toolCall({ status: 'done' })] });
    expect(deriveErrorAttentionSources(t, null)).toEqual([]);
  });

  it('flags a turn that settled with an error outcome, anchored on the turn’s first item', () => {
    const t = turn({
      outcome: { kind: 'error', reason: 'prompt_failed' },
      items: [message('msg-1', 1, 'assistant', 'partial reply')],
    });
    expect(deriveErrorAttentionSources(t, null)).toEqual([
      { id: 'turn:turn-1', itemId: 'msg-1', summary: 'Turn failed (prompt_failed)' },
    ]);
  });

  it('omits the reason suffix when the outcome carries none', () => {
    const t = turn({ outcome: { kind: 'error' }, items: [message('msg-1', 1, 'assistant', 'x')] });
    expect(deriveErrorAttentionSources(t, null)).toEqual([
      { id: 'turn:turn-1', itemId: 'msg-1', summary: 'Turn failed' },
    ]);
  });

  it('labels an interrupted outcome distinctly from a failed one, mirroring the turn footer', () => {
    const t = turn({
      outcome: { kind: 'interrupted', reason: 'process_closed' },
      items: [message('msg-1', 1, 'assistant', 'x')],
    });
    expect(deriveErrorAttentionSources(t, null)).toEqual([
      { id: 'turn:turn-1', itemId: 'msg-1', summary: 'Turn interrupted (process_closed)' },
    ]);
  });

  it.each(['cancelled', 'done'] as const)(
    'does not flag a turn-level error for a %s outcome',
    (kind) => {
      const t = turn({ outcome: { kind }, items: [message('msg-1', 1, 'assistant', 'x')] });
      expect(deriveErrorAttentionSources(t, null)).toEqual([]);
    }
  );

  it.each(['end_turn', 'max_turn_requests', 'refusal', 'quiesced'] as const)(
    'does not flag a done outcome with a normal stop reason (%s)',
    (reason) => {
      const t = turn({
        outcome: { kind: 'done', reason },
        items: [message('msg-1', 1, 'assistant', 'x')],
      });
      expect(deriveErrorAttentionSources(t, null)).toEqual([]);
    }
  );

  it('flags a done turn that hit the context/token limit (ticket #39), anchored on the turn’s first item', () => {
    const t = turn({
      outcome: { kind: 'done', reason: 'max_tokens' },
      items: [message('msg-1', 1, 'assistant', 'partial reply')],
    });
    expect(deriveErrorAttentionSources(t, null)).toEqual([
      { id: 'turn:turn-1', itemId: 'msg-1', summary: 'Context limit reached' },
    ]);
  });

  it('does not flag a turn-level error when the errored turn has no items to anchor on', () => {
    const t = turn({ outcome: { kind: 'error' }, items: [] });
    expect(deriveErrorAttentionSources(t, null)).toEqual([]);
  });

  it('flags a top-level tool call that errored even though the turn overall succeeded', () => {
    const t = turn({
      outcome: { kind: 'done' },
      items: [toolCall({ id: 'tool-1', status: 'error', title: 'Run the build' })],
    });
    expect(deriveErrorAttentionSources(t, null)).toEqual([
      { id: 'tool:tool-1', itemId: 'tool-1', summary: 'Tool failed: Run the build' },
    ]);
  });

  it('uses a tool-group’s own label (not its children) for an errored group, and does not double-flag its children', () => {
    const t = turn({
      outcome: { kind: 'done' },
      items: [
        {
          kind: 'tool-group',
          id: 'group-1',
          seq: 1,
          label: 'Read 3 files',
          groupKind: 'read-batch',
          status: 'error',
          children: [toolCall({ id: 'child-1', kind: 'read-tool-call', status: 'error' })],
        } as TranscriptItem,
      ],
    });
    expect(deriveErrorAttentionSources(t, null)).toEqual([
      { id: 'tool:group-1', itemId: 'group-1', summary: 'Tool failed: Read 3 files' },
    ]);
  });

  it('does not reach into a leaf tool call’s nested children (not addressable via scrollToTranscriptItem)', () => {
    const t = turn({
      outcome: { kind: 'done' },
      items: [
        toolCall({
          id: 'parent-1',
          status: 'done',
          children: [toolCall({ id: 'nested-1', status: 'error' })],
        }),
      ],
    });
    expect(deriveErrorAttentionSources(t, null)).toEqual([]);
  });

  it('collects tool errors from the active (not-yet-committed) turn too', () => {
    const active = turn({ id: 'turn-active', items: [toolCall({ id: 'a1', status: 'error' })] });
    expect(deriveErrorAttentionSources(null, active)).toEqual([
      { id: 'tool:a1', itemId: 'a1', summary: 'Tool failed: Run the build' },
    ]);
  });

  it('never derives a turn-level error from the active turn (it never carries a settled outcome)', () => {
    // Even if a caller mistakenly attached an `outcome` to an in-flight turn,
    // only `lastCommittedTurn` is checked for turn-level errors.
    const active = turn({ id: 'turn-active', outcome: { kind: 'error' }, items: [] });
    expect(deriveErrorAttentionSources(null, active)).toEqual([]);
  });

  it('orders the last committed turn’s own error(s) before the active turn’s', () => {
    const last = turn({
      id: 'turn-committed',
      outcome: { kind: 'error' },
      items: [
        message('msg-1', 1, 'assistant', 'x'),
        toolCall({ id: 'committed-tool', status: 'error' }),
      ],
    });
    const active = turn({
      id: 'turn-active',
      items: [toolCall({ id: 'active-tool', status: 'error' })],
    });

    expect(deriveErrorAttentionSources(last, active).map((e) => e.id)).toEqual([
      'turn:turn-committed',
      'tool:committed-tool',
      'tool:active-tool',
    ]);
  });

  it('sanitizes and bounds a provider-authored tool title', () => {
    const longTitle = `Fetch ${'x'.repeat(120)}`;
    const t = turn({ items: [toolCall({ id: 'tool-1', status: 'error', title: longTitle })] });
    const [source] = deriveErrorAttentionSources(t, null);
    expect(source.summary.startsWith('Tool failed: Fetch xxx')).toBe(true);
    expect(source.summary.length).toBeLessThanOrEqual('Tool failed: '.length + 80);
    expect(source.summary.endsWith('…')).toBe(true);
  });

  it('strips bidi-override spoofing characters from a tool title', () => {
    const t = turn({
      items: [toolCall({ id: 'tool-1', status: 'error', title: 'safe‮command' })],
    });
    const [source] = deriveErrorAttentionSources(t, null);
    expect(source.summary).not.toContain('‮');
  });
});
