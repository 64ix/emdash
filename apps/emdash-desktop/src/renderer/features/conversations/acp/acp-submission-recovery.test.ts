import type { PromptInput } from '@emdash/core/acp/client';
import type { Result } from '@emdash/shared';
import { describe, expect, it, vi } from 'vitest';
import type {
  AcpPromptAttachment,
  AcpSubmissionSessionPort,
  AcpSubmissionSnapshot,
  FailedAcpSubmission,
} from './acp-submission-recovery';
import {
  AcpSubmissionController,
  appendFailedSubmission,
  createSubmissionSnapshot,
  removeFailedSubmission,
  resultError,
  toPromptInput,
} from './acp-submission-recovery';

// ── Helpers ───────────────────────────────────────────────────────────────────

function attachment(id: string, previewUrl?: string): AcpPromptAttachment {
  return {
    ref: { type: 'attachment', id, mimeType: 'image/png', name: `${id}.png` },
    previewUrl,
  };
}

function snapshot(overrides: Partial<AcpSubmissionSnapshot> = {}): AcpSubmissionSnapshot {
  return createSubmissionSnapshot({
    localId: 'submission:1',
    kind: 'direct',
    text: 'hello',
    attachments: [],
    ...overrides,
  });
}

function failed(overrides: Partial<FailedAcpSubmission> = {}): FailedAcpSubmission {
  return { ...snapshot(overrides), error: 'boom', ...overrides };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

type PendingRequest = {
  resolve: (result: Result<{ queued: boolean }, unknown>) => void;
  reject: (error: unknown) => void;
};

/** A fake session port whose sendPrompt/queuePrompt resolution is controlled by the test. */
class FakeSessionPort implements AcpSubmissionSessionPort {
  working = false;
  queuedCount = 0;
  readonly sendCalls: PromptInput[] = [];
  readonly queueCalls: PromptInput[] = [];
  private pendingSends: PendingRequest[] = [];
  private pendingQueues: PendingRequest[] = [];

  isWorking(): boolean {
    return this.working;
  }

  queuedPromptCount(): number {
    return this.queuedCount;
  }

  sendPrompt(input: PromptInput): Promise<Result<{ queued: boolean }, unknown>> {
    this.sendCalls.push(input);
    return new Promise((resolve, reject) => {
      this.pendingSends.push({ resolve, reject });
    });
  }

  queuePrompt(input: PromptInput): Promise<Result<{ queued: boolean }, unknown>> {
    this.queueCalls.push(input);
    return new Promise((resolve, reject) => {
      this.pendingQueues.push({ resolve, reject });
    });
  }

  resolveNextSend(result: Result<{ queued: boolean }, unknown>): void {
    const pending = this.pendingSends.shift();
    if (!pending) throw new Error('No pending sendPrompt call to resolve');
    pending.resolve(result);
  }

  rejectNextSend(error: unknown): void {
    const pending = this.pendingSends.shift();
    if (!pending) throw new Error('No pending sendPrompt call to reject');
    pending.reject(error);
  }

  resolveNextQueue(result: Result<{ queued: boolean }, unknown>): void {
    const pending = this.pendingQueues.shift();
    if (!pending) throw new Error('No pending queuePrompt call to resolve');
    pending.resolve(result);
  }

  rejectNextQueue(error: unknown): void {
    const pending = this.pendingQueues.shift();
    if (!pending) throw new Error('No pending queuePrompt call to reject');
    pending.reject(error);
  }
}

const ok: Result<{ queued: boolean }, unknown> = { success: true, data: { queued: false } };

// ── Pure snapshot/list helpers ─────────────────────────────────────────────────

describe('createSubmissionSnapshot', () => {
  it('freezes the snapshot and its attachments array', () => {
    const att = attachment('att-1');
    const snap = createSubmissionSnapshot({
      localId: 'submission:1',
      kind: 'direct',
      text: 'hi',
      attachments: [att],
    });
    expect(Object.isFrozen(snap)).toBe(true);
    expect(Object.isFrozen(snap.attachments)).toBe(true);
    expect(snap.attachments).toEqual([att]);
  });

  it('omits hiddenContext and queuePosition entirely when not provided', () => {
    const snap = createSubmissionSnapshot({
      localId: 'submission:1',
      kind: 'direct',
      text: 'hi',
      attachments: [],
    });
    expect('hiddenContext' in snap).toBe(false);
    expect('queuePosition' in snap).toBe(false);
  });

  it('preserves hiddenContext and queuePosition when provided', () => {
    const snap = createSubmissionSnapshot({
      localId: 'submission:1',
      kind: 'queued',
      text: 'hi',
      attachments: [],
      hiddenContext: 'issue context',
      queuePosition: 2,
    });
    expect(snap.hiddenContext).toBe('issue context');
    expect(snap.queuePosition).toBe(2);
  });
});

describe('toPromptInput', () => {
  it('maps text-only snapshots without hiddenContext/attachments keys', () => {
    const input = toPromptInput(snapshot({ text: 'hello' }));
    expect(input).toEqual({ text: 'hello' });
  });

  it('includes hiddenContext and attachment refs when present', () => {
    const att = attachment('att-1');
    const input = toPromptInput(
      snapshot({ text: 'hello', attachments: [att], hiddenContext: 'ctx' })
    );
    expect(input).toEqual({ text: 'hello', hiddenContext: 'ctx', attachments: [att.ref] });
  });
});

describe('resultError', () => {
  it('passes Error instances through unchanged', () => {
    const error = new Error('boom');
    expect(resultError(error)).toBe(error);
  });

  it('extracts a message from an error-shaped object', () => {
    expect(resultError({ message: 'nope' }).message).toBe('nope');
  });

  it('falls back to the type field, then to String(error)', () => {
    expect(resultError({ type: 'auth_required' }).message).toBe('auth_required');
    expect(resultError('raw string').message).toBe('raw string');
  });
});

describe('appendFailedSubmission', () => {
  it('appends a new failed submission', () => {
    const entries = appendFailedSubmission([], snapshot({ localId: 'submission:1' }), 'boom');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ localId: 'submission:1', error: 'boom' });
  });

  it('replaces (never duplicates) an existing entry with the same localId', () => {
    const first = appendFailedSubmission(
      [],
      snapshot({ localId: 'submission:1', text: 'first attempt' }),
      'first error'
    );
    const second = appendFailedSubmission(
      first,
      snapshot({ localId: 'submission:1', text: 'second attempt' }),
      'second error'
    );
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({
      localId: 'submission:1',
      text: 'second attempt',
      error: 'second error',
    });
  });
});

describe('removeFailedSubmission', () => {
  it('removes the matching entry and returns it', () => {
    const entries = [failed({ localId: 'a' }), failed({ localId: 'b' })];
    const { removed, entries: next } = removeFailedSubmission(entries, 'a');
    expect(removed?.localId).toBe('a');
    expect(next.map((entry) => entry.localId)).toEqual(['b']);
  });

  it('returns null and a copy of the list when the id is not found', () => {
    const entries = [failed({ localId: 'a' })];
    const { removed, entries: next } = removeFailedSubmission(entries, 'missing');
    expect(removed).toBeNull();
    expect(next).toEqual(entries);
    expect(next).not.toBe(entries);
  });
});

// ── AcpSubmissionController ────────────────────────────────────────────────────

describe('AcpSubmissionController', () => {
  it('captures the snapshot and shows the optimistic bubble before the send settles (direct, idle)', () => {
    const port = new FakeSessionPort();
    const onDirectStart = vi.fn();
    const controller = new AcpSubmissionController(() => port, { onDirectStart });

    controller.submit('hello', [attachment('att-1')], 'ctx');

    expect(onDirectStart).toHaveBeenCalledTimes(1);
    const snap = onDirectStart.mock.calls[0][0] as AcpSubmissionSnapshot;
    expect(snap.kind).toBe('direct');
    expect(snap.text).toBe('hello');
    expect(snap.hiddenContext).toBe('ctx');
    expect(snap.attachments).toHaveLength(1);
    expect(port.sendCalls).toEqual([
      { text: 'hello', hiddenContext: 'ctx', attachments: [attachment('att-1').ref] },
    ]);
    // Nothing failed yet — the snapshot has not entered failedSubmissions.
    expect(controller.failedSubmissions).toEqual([]);
  });

  it('does not show an optimistic bubble for a direct send while the agent is working', () => {
    const port = new FakeSessionPort();
    port.working = true;
    const onDirectStart = vi.fn();
    const controller = new AcpSubmissionController(() => port, { onDirectStart });

    controller.submit('hello');

    expect(onDirectStart).not.toHaveBeenCalled();
  });

  it('releases the snapshot on success — nothing lands in failedSubmissions', async () => {
    const port = new FakeSessionPort();
    const controller = new AcpSubmissionController(() => port);

    controller.submit('hello');
    port.resolveNextSend(ok);
    await flushPromises();

    expect(controller.failedSubmissions).toEqual([]);
  });

  it('restores text, attachments, and hidden context exactly once on a rejected direct send', async () => {
    const onFailure = vi.fn();
    const port = new FakeSessionPort();
    const controller = new AcpSubmissionController(() => port, { onFailure });

    const atts = [attachment('att-1'), attachment('att-2')];
    controller.submit('please restore me', atts, 'hidden ctx');
    port.resolveNextSend({ success: false, error: 'rejected' });
    await flushPromises();

    expect(controller.failedSubmissions).toHaveLength(1);
    const [entry] = controller.failedSubmissions;
    expect(entry.text).toBe('please restore me');
    expect(entry.attachments).toEqual(atts);
    expect(entry.hiddenContext).toBe('hidden ctx');
    expect(entry.kind).toBe('direct');
    expect(entry.error).toBe('rejected');
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledWith(entry);
  });

  it('restores the snapshot exactly once on a thrown/rejected promise', async () => {
    const port = new FakeSessionPort();
    const controller = new AcpSubmissionController(() => port);

    controller.submit('thrown case');
    port.rejectNextSend(new Error('network down'));
    await flushPromises();

    expect(controller.failedSubmissions).toHaveLength(1);
    expect(controller.failedSubmissions[0].error).toBe('network down');
  });

  it('fails immediately (without calling the session) when no session is connected', async () => {
    const controller = new AcpSubmissionController(() => null);

    controller.submit('no session');
    await flushPromises();

    expect(controller.failedSubmissions).toHaveLength(1);
    expect(controller.failedSubmissions[0].error).toBe('ACP session is not connected');
  });

  it('captures queue position and restores a failed queued submission', async () => {
    const port = new FakeSessionPort();
    port.queuedCount = 3;
    const controller = new AcpSubmissionController(() => port);

    controller.queue('queued message', [attachment('att-1')], 'ctx');
    expect(port.queueCalls).toEqual([
      { text: 'queued message', hiddenContext: 'ctx', attachments: [attachment('att-1').ref] },
    ]);

    port.rejectNextQueue(new Error('queue rejected'));
    await flushPromises();

    expect(controller.failedSubmissions).toHaveLength(1);
    const [entry] = controller.failedSubmissions;
    expect(entry.kind).toBe('queued');
    expect(entry.queuePosition).toBe(3);
    expect(entry.attachments).toEqual([attachment('att-1')]);
  });

  it('keeps current queue ordering on success — queuePrompt is never called twice for one submission', async () => {
    const port = new FakeSessionPort();
    const controller = new AcpSubmissionController(() => port);

    controller.queue('queued message');
    port.resolveNextQueue(ok);
    await flushPromises();

    expect(port.queueCalls).toHaveLength(1);
    expect(controller.failedSubmissions).toEqual([]);
  });

  it('retry reconciles with the original local identity and cannot duplicate the turn', async () => {
    const onDirectStart = vi.fn();
    const port = new FakeSessionPort();
    const controller = new AcpSubmissionController(() => port, { onDirectStart });

    controller.submit('retry me');
    port.rejectNextSend(new Error('first failure'));
    await flushPromises();

    const [failedEntry] = controller.failedSubmissions;
    const originalLocalId = failedEntry.localId;

    controller.retry(originalLocalId);

    // Removed from failedSubmissions synchronously, before the resend settles.
    expect(controller.failedSubmissions).toEqual([]);
    expect(port.sendCalls).toHaveLength(2);
    const retryStartSnapshot = onDirectStart.mock.calls[1][0] as AcpSubmissionSnapshot;
    expect(retryStartSnapshot.localId).toBe(originalLocalId);

    // A second retry call for the same (already-consumed) id is a no-op —
    // it cannot resend and cannot duplicate the turn.
    controller.retry(originalLocalId);
    expect(port.sendCalls).toHaveLength(2);

    port.resolveNextSend(ok);
    await flushPromises();
    expect(controller.failedSubmissions).toEqual([]);
  });

  it('repeated failure: a retried submission that fails again re-enters failedSubmissions once, under the same id', async () => {
    const port = new FakeSessionPort();
    const controller = new AcpSubmissionController(() => port);

    controller.submit('always fails');
    port.rejectNextSend(new Error('first failure'));
    await flushPromises();
    const originalLocalId = controller.failedSubmissions[0].localId;

    controller.retry(originalLocalId);
    port.rejectNextSend(new Error('second failure'));
    await flushPromises();

    expect(controller.failedSubmissions).toHaveLength(1);
    expect(controller.failedSubmissions[0].localId).toBe(originalLocalId);
    expect(controller.failedSubmissions[0].error).toBe('second failure');
  });

  it('retry on an unknown localId is a no-op', () => {
    const port = new FakeSessionPort();
    const controller = new AcpSubmissionController(() => port);

    controller.retry('does-not-exist');

    expect(port.sendCalls).toEqual([]);
    expect(port.queueCalls).toEqual([]);
  });

  it('edit removes the failed submission and hands back its snapshot for the composer', async () => {
    const port = new FakeSessionPort();
    const controller = new AcpSubmissionController(() => port);

    const atts = [attachment('att-1')];
    controller.submit('edit me', atts, 'ctx');
    port.rejectNextSend(new Error('failed'));
    await flushPromises();

    const localId = controller.failedSubmissions[0].localId;
    const editedSnapshot = controller.edit(localId);

    expect(editedSnapshot).not.toBeNull();
    expect(editedSnapshot?.text).toBe('edit me');
    expect(editedSnapshot?.attachments).toEqual(atts);
    expect(editedSnapshot?.hiddenContext).toBe('ctx');
    // Editing removes it from the recovery list — no lingering duplicate.
    expect(controller.failedSubmissions).toEqual([]);
    // Editing never resends.
    expect(port.sendCalls).toHaveLength(1);
  });

  it('edit on an unknown localId is a no-op that returns null', () => {
    const controller = new AcpSubmissionController(() => new FakeSessionPort());
    expect(controller.edit('missing')).toBeNull();
  });

  it('discard permanently removes a failed submission without resending it', async () => {
    const port = new FakeSessionPort();
    const controller = new AcpSubmissionController(() => port);

    controller.submit('discard me');
    port.rejectNextSend(new Error('failed'));
    await flushPromises();

    const localId = controller.failedSubmissions[0].localId;
    const discarded = controller.discard(localId);

    expect(discarded?.localId).toBe(localId);
    expect(controller.failedSubmissions).toEqual([]);
    expect(port.sendCalls).toHaveLength(1);

    // Discard is final: retrying the same (already-discarded) id does nothing.
    controller.retry(localId);
    expect(port.sendCalls).toHaveLength(1);
  });

  it('discard on an unknown localId is a no-op that returns null', () => {
    const controller = new AcpSubmissionController(() => new FakeSessionPort());
    expect(controller.discard('missing')).toBeNull();
  });

  it('two independent queued submissions can fail without losing either snapshot', async () => {
    const port = new FakeSessionPort();
    const controller = new AcpSubmissionController(() => port);

    controller.queue('first queued');
    controller.queue('second queued');
    // Both queuePrompt calls are in flight; reject them out of order.
    port.rejectNextQueue(new Error('first failed'));
    port.rejectNextQueue(new Error('second failed'));
    await flushPromises();

    expect(controller.failedSubmissions).toHaveLength(2);
    expect(controller.failedSubmissions.map((entry) => entry.text)).toEqual([
      'first queued',
      'second queued',
    ]);
    expect(new Set(controller.failedSubmissions.map((entry) => entry.localId)).size).toBe(2);
  });
});
