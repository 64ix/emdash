/**
 * ACP submission recovery — the transactional seam behind `AcpChatStore.submitPrompt`
 * and `queuePrompt`.
 *
 * Sending (direct or queued) is treated as a recoverable transaction:
 *
 *   1. Capture an immutable snapshot of everything the user would lose on
 *      failure (text, attachments, hidden mention context, and — for queued
 *      sends — the queue position the prompt would have taken) *before* any
 *      optimistic UI mutation happens.
 *   2. Attempt the send/queue call.
 *   3. On rejection or thrown error, the snapshot enters `failedSubmissions`
 *      exactly once (never duplicated — a same-`localId` retry replaces its
 *      own prior entry rather than appending a second one) and the caller
 *      renders Retry / Edit / Discard for it.
 *   4. Retry resubmits the exact snapshot under its original `localId` so any
 *      optimistic UI keyed by that id is reconciled instead of duplicated.
 *      Edit hands the snapshot back for the composer to reload as editable
 *      text/attachments. Discard is the only way to drop it for good.
 *   5. Success never touches `failedSubmissions` — there is nothing to
 *      release because a snapshot only ever enters the list on failure.
 *
 * This module is intentionally free of MobX/DOM/ChatState dependencies so it
 * can be unit-tested as a plain reducer/service. `AcpSubmissionController`
 * adds the (still DOM-free) observable/orchestration layer that
 * `AcpChatStore` wires up to the real ACP session and optimistic chat state.
 */
import type { PromptAttachment, PromptInput } from '@emdash/core/acp/client';
import type { Result } from '@emdash/shared';
import { action, makeObservable, observable, runInAction } from 'mobx';

type StoredPromptAttachment = Extract<PromptAttachment, { type: 'attachment' }>;

export type AcpPromptAttachment = {
  ref: StoredPromptAttachment;
  previewUrl?: string;
};

export type AcpSubmissionKind = 'direct' | 'queued';

/** Immutable recovery snapshot captured before any optimistic mutation. */
export interface AcpSubmissionSnapshot {
  /** Stable identity reused across retries so no duplicate turn/bubble is created. */
  readonly localId: string;
  readonly kind: AcpSubmissionKind;
  readonly text: string;
  readonly attachments: readonly AcpPromptAttachment[];
  readonly hiddenContext?: string;
  /** Queued submissions only: how many prompts were already queued at capture time. */
  readonly queuePosition?: number;
}

export interface FailedAcpSubmission extends AcpSubmissionSnapshot {
  readonly error: string;
}

export interface CreateSnapshotInput {
  localId: string;
  kind: AcpSubmissionKind;
  text: string;
  attachments: readonly AcpPromptAttachment[];
  hiddenContext?: string;
  queuePosition?: number;
}

/** Build a frozen, immutable snapshot — the only way to construct one. */
export function createSubmissionSnapshot(input: CreateSnapshotInput): AcpSubmissionSnapshot {
  return Object.freeze({
    localId: input.localId,
    kind: input.kind,
    text: input.text,
    attachments: Object.freeze([...input.attachments]),
    ...(input.hiddenContext !== undefined ? { hiddenContext: input.hiddenContext } : {}),
    ...(input.queuePosition !== undefined ? { queuePosition: input.queuePosition } : {}),
  });
}

/** Map a snapshot to the wire `PromptInput` shape for `sendPrompt`/`queuePrompt`. */
export function toPromptInput(snapshot: AcpSubmissionSnapshot): PromptInput {
  const attachments = snapshot.attachments.map((attachment) => attachment.ref);
  return {
    text: snapshot.text,
    ...(snapshot.hiddenContext ? { hiddenContext: snapshot.hiddenContext } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
  };
}

/**
 * Append a failed submission. Any existing entry with the same `localId` is
 * replaced (not duplicated) — the guarantee behind "restores exactly once"
 * even if a caller somehow reports failure twice for one attempt.
 */
export function appendFailedSubmission(
  entries: readonly FailedAcpSubmission[],
  snapshot: AcpSubmissionSnapshot,
  error: string
): FailedAcpSubmission[] {
  const withoutExisting = entries.filter((entry) => entry.localId !== snapshot.localId);
  return [...withoutExisting, { ...snapshot, error }];
}

/**
 * Remove a failed submission by `localId`. Returns the removed entry (or
 * `null` when not found) alongside the resulting list. This is the only path
 * out of `failedSubmissions` — retry/edit/discard all go through it, so a
 * given failed submission can only ever be acted on once.
 */
export function removeFailedSubmission(
  entries: readonly FailedAcpSubmission[],
  localId: string
): { removed: FailedAcpSubmission | null; entries: FailedAcpSubmission[] } {
  const index = entries.findIndex((entry) => entry.localId === localId);
  if (index === -1) return { removed: null, entries: entries.slice() };
  const removed = entries[index];
  const next = entries.slice();
  next.splice(index, 1);
  return { removed, entries: next };
}

export function resultError(error: unknown): Error {
  if (error instanceof Error) return error;
  if (typeof error === 'object' && error !== null) {
    const message = (error as { message?: unknown }).message;
    const type = (error as { type?: unknown }).type;
    return new Error(typeof message === 'string' ? message : String(type ?? 'Unknown error'));
  }
  return new Error(String(error));
}

/** Minimal session surface the controller needs — mockable in unit tests. */
export interface AcpSubmissionSessionPort {
  isWorking(): boolean;
  queuedPromptCount(): number;
  sendPrompt(input: PromptInput): Promise<Result<{ queued: boolean }, unknown>>;
  queuePrompt(input: PromptInput): Promise<Result<{ queued: boolean }, unknown>>;
}

export interface AcpSubmissionHooks {
  /** A direct send started while the agent was idle — show the optimistic bubble. */
  onDirectStart?(snapshot: AcpSubmissionSnapshot): void;
  /** Any submission (direct or queued) was rejected or threw. */
  onFailure?(failure: FailedAcpSubmission): void;
}

/**
 * Owns the recoverable-submission state machine: capture → send → (on
 * failure) recover, with retry/edit/discard as the only ways out.
 *
 * DOM/ChatState-free by design so it is unit-testable as a plain
 * reducer/service; `AcpChatStore` supplies the session port + hooks that
 * bridge to the real ACP session and optimistic chat UI.
 */
export class AcpSubmissionController {
  failedSubmissions: FailedAcpSubmission[] = [];

  private _seq = 0;

  constructor(
    private readonly sessionPort: () => AcpSubmissionSessionPort | null,
    private readonly hooks: AcpSubmissionHooks = {}
  ) {
    makeObservable(this, {
      failedSubmissions: observable,
      submit: action,
      queue: action,
      retry: action,
      edit: action,
      discard: action,
    });
  }

  /** Direct send: creates a fresh snapshot and attempts to send immediately. */
  submit(
    text: string,
    attachments: readonly AcpPromptAttachment[] = [],
    hiddenContext?: string
  ): void {
    const snapshot = createSubmissionSnapshot({
      localId: this._nextLocalId(),
      kind: 'direct',
      text,
      attachments,
      hiddenContext,
    });
    this._send(snapshot);
  }

  /** Queued send: creates a fresh snapshot (recording queue position) and queues it. */
  queue(
    text: string,
    attachments: readonly AcpPromptAttachment[] = [],
    hiddenContext?: string
  ): void {
    const port = this.sessionPort();
    const snapshot = createSubmissionSnapshot({
      localId: this._nextLocalId(),
      kind: 'queued',
      text,
      attachments,
      hiddenContext,
      queuePosition: port?.queuedPromptCount() ?? 0,
    });
    this._send(snapshot);
  }

  /**
   * Retry a failed submission under its original `localId`. The entry is
   * removed synchronously before resending, so a second Retry click (or a
   * second failure report) can never resend the same failed entry twice.
   */
  retry(localId: string): void {
    const { removed, entries } = removeFailedSubmission(this.failedSubmissions, localId);
    if (!removed) return;
    this.failedSubmissions = entries;
    this._send(removed);
  }

  /** Hand the snapshot back to the caller (composer) as editable state. */
  edit(localId: string): AcpSubmissionSnapshot | null {
    const { removed, entries } = removeFailedSubmission(this.failedSubmissions, localId);
    this.failedSubmissions = entries;
    return removed;
  }

  /** Drop a failed submission for good. Only path that permanently loses it. */
  discard(localId: string): FailedAcpSubmission | null {
    const { removed, entries } = removeFailedSubmission(this.failedSubmissions, localId);
    this.failedSubmissions = entries;
    return removed;
  }

  private _nextLocalId(): string {
    this._seq += 1;
    return `submission:${Date.now()}:${this._seq}`;
  }

  private _send(snapshot: AcpSubmissionSnapshot): void {
    const port = this.sessionPort();
    if (!port) {
      this._fail(snapshot, new Error('ACP session is not connected'));
      return;
    }

    if (snapshot.kind === 'direct' && !port.isWorking()) {
      this.hooks.onDirectStart?.(snapshot);
    }

    const input = toPromptInput(snapshot);
    const request = snapshot.kind === 'direct' ? port.sendPrompt(input) : port.queuePrompt(input);

    void request
      .then((result) => {
        if (!result.success) this._fail(snapshot, resultError(result.error));
      })
      .catch((error: unknown) => this._fail(snapshot, resultError(error)));
  }

  private _fail(snapshot: AcpSubmissionSnapshot, error: Error): void {
    let failure!: FailedAcpSubmission;
    runInAction(() => {
      this.failedSubmissions = appendFailedSubmission(
        this.failedSubmissions,
        snapshot,
        error.message
      );
      failure = { ...snapshot, error: error.message };
    });
    this.hooks.onFailure?.(failure);
  }
}
