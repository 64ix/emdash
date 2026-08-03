import type {
  ChatContext,
  ChatImageAttachment,
  ChatState,
  ChatView,
  OutlineEntry,
  ReadWatermark,
  ScrollMode,
  ScrollToItemOptions,
} from '@emdash/chat-ui';
import {
  captureReadWatermark,
  connectSession,
  countNewTranscriptEvents,
  createChatState,
  deriveTranscriptOutline,
  pinTopMode,
} from '@emdash/chat-ui';
import type {
  AttachmentMimeType,
  AttachmentRef,
  PromptDraft,
  PromptInput,
  QueuedPrompt,
} from '@emdash/core/acp/client';
import { ok } from '@emdash/shared';
import type {
  CommandItem,
  ComposerEffortOption,
  ComposerModelOption,
  ComposerPermissionModeOption,
  ComposerQueuedPrompt,
} from '@emdash/ui/react/components';
import type { BlobSource } from '@emdash/wire';
import { action, computed, makeObservable, observable, reaction, runInAction, toJS } from 'mobx';
// TODO(conversations-extraction): Inject task/workspace lookups instead of importing task stores.
import { asProvisioned, getTaskStore } from '@renderer/features/tasks/stores/task-selectors';
import { workspaceRegistry } from '@renderer/features/tasks/stores/workspace-registry';
import { AcpLiveSession, AcpStartError, asValueSource } from '@renderer/lib/acp/acp-live-session';
import { getAgentConfigRuntimeClient } from '@renderer/lib/agent-config/runtime-client';
import {
  registerConversationCommands,
  unregisterConversationCommands,
} from '@renderer/lib/chat/advertised-command-provider';
import { getSharedChatContext } from '@renderer/lib/chat/shared-chat-context';
import { toast } from '@renderer/lib/hooks/use-toast';
import { rpc } from '@renderer/lib/ipc';
import { log } from '@renderer/utils/logger';
import { conversationRegistry } from '../stores/conversation-registry';
import { createStopController, type StopController } from './acp-chat-stop-controller';
import { AcpHistoryPagination } from './acp-history-pagination';
import type {
  AcpPromptAttachment,
  AcpSubmissionSessionPort,
  AcpSubmissionSnapshot,
  FailedAcpSubmission,
} from './acp-submission-recovery';
import { AcpSubmissionController, resultError } from './acp-submission-recovery';
import { bindSessionTerminalOutputs } from './acp-terminal-output-binding';
import {
  buildChangesFootprint,
  EMPTY_CHANGES_FOOTPRINT,
  type ChangesFootprint,
} from './changes/acp-changes-footprint';

export type {
  AcpPromptAttachment,
  AcpSubmissionKind,
  AcpSubmissionSnapshot,
  FailedAcpSubmission,
} from './acp-submission-recovery';

/**
 * Page size for every ACP history fetch: the initial window, each
 * reach-start-triggered older page, and the post-turn-commit refresh window.
 * Kept as a single constant so all three requests stay consistent with the
 * `AcpHistoryPagination` cursor bookkeeping.
 */
const HISTORY_PAGE_SIZE = 100;

export interface AgentAffordances {
  isWorking: boolean;
  isBusy: boolean;
  hasPendingPermission: boolean;
  canSubmit: boolean;
  canCancel: boolean;
}

type PermissionQueueItem = {
  requestId: string;
  title: string;
  options: Array<{ optionId: string; name: string; kind: string }>;
};

export type AcpLoadError =
  | { kind: 'auth_required'; message: string }
  | { kind: 'generic'; message: string };

export class AcpChatStore {
  readonly chatContext: ChatContext;
  readonly chatState: ChatState;

  session: AcpLiveSession | null = null;
  historyLoading = true;
  loadError: AcpLoadError | null = null;
  messageCount = 0;
  draftText = '';
  /**
   * Task-scoped Changes footprint (edited/read files), reconciled from the
   * canonical transcript (persisted + active turns) and the task's current
   * Git status. Recomputed via `_syncChangesFootprint` — see that method for
   * every place the transcript or Git status can change. Never persisted;
   * see `ChangesRailViewStore` for the view preferences that are.
   */
  changesFootprint: ChangesFootprint = EMPTY_CHANGES_FOOTPRINT;
  /**
   * Count of transcript turns that have arrived since the user last left tail
   * mode (see `setAtBottom` / `state/reading-position.ts`). Zero while
   * following the tail. Recomputed via `_syncNewEventCount` at every point
   * the transcript can grow — mirrors `changesFootprint`'s explicit-field
   * pattern rather than a lazy `computed` getter, deliberately: this value's
   * inputs (`chatState.transcript.state`) are Solid signals, not MobX
   * observables, so a `computed` reading them directly would go stale once
   * "hot" (observed) with no MobX-tracked dependency to invalidate it on.
   */
  newEventCount = 0;
  /**
   * True while a "return to reading position" jump (see `visitNewestEvent`)
   * is available. Ticket #37: visiting the newest event must not lose the
   * exact prior item + offset.
   */
  canReturnToReadingPosition = false;
  /**
   * True while a Stop/cancel request for the active turn is in flight.
   * Mirrored into `chatState.session.setStopPending` so the transcript's
   * active-message Stop control can disable itself and communicate a busy
   * state (see acp-chat-stop-controller.ts).
   */
  isCancelling = false;
  /** True while an older-history page requested via `loadOlderHistory` is in flight. */
  isLoadingOlderHistory = false;

  private _view: ChatView | null = null;
  private _bootstrapped = false;
  private _unsubs: Array<() => void> = [];
  private _draftRev = 0;
  private _pendingDraftRev: number | null = null;
  private _draftTimer: number | null = null;
  private readonly _submissions: AcpSubmissionController;
  private readonly _stopController: StopController;
  private readonly _historyPagination = new AcpHistoryPagination();
  /**
   * Frozen "seen up to here" baseline captured when the user leaves tail
   * mode; null while following the tail (or before it is first left). See
   * `setAtBottom` and `state/reading-position.ts`.
   */
  private _readWatermark: ReadWatermark | null = null;
  /**
   * The exact scroll intent to restore when the user is done visiting the
   * newest event — set by `visitNewestEvent`, consumed by
   * `returnToReadingPosition`.
   */
  private _returnAnchor: ScrollMode | null = null;

  constructor(
    readonly conversationId: string,
    readonly projectId: string,
    readonly taskId: string
  ) {
    this.chatContext = getSharedChatContext();
    this.chatState = createChatState(this.chatContext, { uri: conversationId });
    registerConversationCommands(conversationId, () =>
      this.commands.map((command) => command.name)
    );
    this._submissions = new AcpSubmissionController(() => this._sessionPort(), {
      onDirectStart: (snapshot) => this._showOptimisticPrompt(snapshot),
      onFailure: (failure) => this._handleSubmissionFailure(failure),
      onDiscard: (discarded) => this._releaseSubmissionAttachments(discarded),
    });

    this._stopController = createStopController(
      () => this.session?.cancelTurn() ?? Promise.resolve(ok<void>()),
      {
        onBusyChange: (busy) => {
          runInAction(() => {
            this.isCancelling = busy;
          });
          this.chatState.session.setStopPending(busy);
        },
        onError: (error) => this._toastError('Failed to stop', error),
      }
    );

    makeObservable(this, {
      session: observable.ref,
      historyLoading: observable,
      loadError: observable,
      messageCount: observable,
      draftText: observable,
      isCancelling: observable,
      isLoadingOlderHistory: observable,
      changesFootprint: observable.ref,
      newEventCount: observable,
      canReturnToReadingPosition: observable,
      model: computed,
      modelOptions: computed,
      permissionMode: computed,
      permissionModeOptions: computed,
      effort: computed,
      effortOptions: computed,
      commands: computed,
      permissionQueue: computed,
      queuedPrompts: computed,
      usage: computed,
      affordances: computed,
      isEmpty: computed,
      failedSubmissions: computed,
      outline: computed,
      submitPrompt: action,
      queuePrompt: action,
      retryFailedSubmission: action,
      editFailedSubmission: action,
      discardFailedSubmission: action,
      stop: action,
      setModel: action,
      setMode: action,
      setEffort: action,
      resolvePermission: action,
      editQueuedPrompt: action,
      deleteQueuedPrompt: action,
      reorderQueuedPrompts: action,
      sendQueuedPromptNow: action,
      setDraftText: action,
      exportTranscript: action,
      retry: action,
      loadOlderHistory: action,
      scrollToTranscriptItem: action,
      setAtBottom: action,
      visitNewestEvent: action,
      returnToReadingPosition: action,
    });
  }

  get model(): string | null {
    return this.session?.config.current().modelOptions?.selected ?? null;
  }

  get modelOptions(): Record<string, ComposerModelOption> | null {
    const options = this.session?.config.current().modelOptions;
    if (!options) return null;
    return Object.fromEntries(
      options.available.map((option) => [
        option.id,
        { name: option.name, description: option.description },
      ])
    );
  }

  get permissionMode(): string | null {
    return this.session?.config.current().modeOptions?.selected ?? null;
  }

  get permissionModeOptions(): Record<string, ComposerPermissionModeOption> | null {
    const options = this.session?.config.current().modeOptions;
    if (!options) return null;
    return Object.fromEntries(
      options.available.map((option) => [
        option.id,
        { name: option.name, description: option.description },
      ])
    );
  }

  get effort(): string | null {
    return this.session?.config.current().efforts?.selected ?? null;
  }

  get effortOptions(): Record<string, ComposerEffortOption> | null {
    const options = this.session?.config.current().efforts;
    if (!options) return null;
    return Object.fromEntries(
      options.available.map((option) => [
        option.id,
        { name: option.name, description: option.description },
      ])
    );
  }

  get commands(): CommandItem[] {
    return (this.session?.config.current().availableCommands ?? []).map((command) => ({
      id: command.name,
      name: command.name,
      description: command.description,
      behavior: 'insert',
    }));
  }

  get permissionQueue(): PermissionQueueItem[] {
    return (this.session?.sessionState.current().pendingPermissions ?? []).map((request) => ({
      requestId: request.requestId,
      title: request.toolCall.title,
      options: request.options.map((option) => ({
        optionId: option.optionId,
        name: option.name,
        kind: option.kind,
      })),
    }));
  }

  get queuedPrompts(): ComposerQueuedPrompt[] {
    return this._queuedPromptModels().map((prompt) => ({
      id: prompt.id,
      text: prompt.text,
    }));
  }

  get usage(): {
    contextUsed: number;
    contextSize: number;
    cost?: { amount: number; currency: string } | null;
  } | null {
    return this.session?.usage.current() ?? null;
  }

  get affordances(): AgentAffordances {
    const state = this.session?.sessionState.current();
    return {
      isWorking: state?.isGenerating ?? false,
      isBusy: state?.isGenerating ?? false,
      hasPendingPermission: (state?.pendingPermissions.length ?? 0) > 0,
      canSubmit: state?.canSubmit ?? false,
      canCancel: state?.canCancel ?? false,
    };
  }

  get isEmpty(): boolean {
    return !this.historyLoading && this.messageCount === 0;
  }

  /**
   * Submissions (direct or queued) that were rejected or threw, in the order
   * they failed. Each carries the immutable snapshot needed to retry, edit,
   * or discard it — see `acp-submission-recovery.ts`.
   */
  get failedSubmissions(): readonly FailedAcpSubmission[] {
    return this._submissions.failedSubmissions;
  }

  /**
   * Compact outline of user prompts and assistant/agent turns — one stable
   * entry per prompt and per turn, derived fresh from canonical transcript
   * state on every read (see `deriveTranscriptOutline`). Reads the same
   * three-way committed/active/pending-prompt split `ChatRoot` reconciles for
   * rendering, so the outline always matches what is actually loaded —
   * extending without duplicates or reordering as older history pages in.
   */
  get outline(): readonly OutlineEntry[] {
    const transcript = this.chatState.transcript.state;
    return deriveTranscriptOutline(
      transcript.committedTurns,
      transcript.activeTurnSnapshot,
      transcript.turnStatus,
      this.chatState.session.state.pendingPrompt
    );
  }

  bootstrap(): void {
    if (this._bootstrapped) return;
    this._bootstrapped = true;
    void this._runBootstrap();
  }

  retry(): void {
    if (this.historyLoading || !this.loadError) return;
    this.historyLoading = true;
    this.loadError = null;
    void this._runBootstrap();
  }

  bindView(view: ChatView | null): void {
    this._view = view;
  }

  /**
   * Load the next older page of transcript history, if one is available.
   * Intended to be wired to `ChatTranscript`'s `onReachStart` (fired when the
   * transcript is scrolled to its top). A no-op when history is still
   * loading, a page is already in flight, or the start of history has
   * already been reached — see `AcpHistoryPagination`.
   *
   * Returns the in-flight (or immediately-resolved) promise so callers that
   * need to act *after* the page lands — e.g. `scrollToTranscriptItem` below —
   * can await it. `onReachStart={() => store.loadOlderHistory()}` in
   * acp-chat-panel.tsx ignores the return value, which is fine: `() => void`
   * callback props accept a Promise-returning implementation.
   */
  loadOlderHistory(): Promise<void> {
    const begin = this._historyPagination.beginLoadOlder();
    if (!begin) return Promise.resolve();
    return this._loadOlderPage(begin);
  }

  /**
   * Scroll the bound transcript view to the row for `itemId`. If the item is
   * part of the currently-loaded transcript, this jumps immediately through
   * the existing virtualizer-aware `ChatView.scrollToItem` seam — correct
   * even when the destination row is off-DOM, never a manual `scrollTop`
   * write. Otherwise this pages in older history first (reusing
   * `loadOlderHistory`, one page at a time) and retries, so a target from a
   * not-yet-paginated-in page is never a silent no-op.
   *
   * Built for the outline (`scrollToOutlineEntry` below), but intentionally
   * generic and typed for reuse by later transcript-navigation features
   * (search, durable reading position — see spec #18 tickets #35-#37): any
   * caller that has a stable canonical item id can resolve a jump through it.
   */
  async scrollToTranscriptItem(itemId: string, opts?: ScrollToItemOptions): Promise<void> {
    if (this.chatState.transcript.findItemById(itemId)) {
      this._view?.scrollToItem(itemId, opts);
      return;
    }
    // Ask permission the same way `loadOlderHistory` does, rather than
    // calling it directly: `beginLoadOlder()` returning null (bootstrap not
    // done yet, a page is already in flight, or history is exhausted) means
    // no *new* page is coming from this call, so recursing further would
    // spin forever instead of resolving. The pagination cursor only ever
    // moves toward exhaustion, so a successful `begin` bounds the recursion
    // by the number of remaining pages.
    const begin = this._historyPagination.beginLoadOlder();
    if (!begin) return;
    await this._loadOlderPage(begin);
    await this.scrollToTranscriptItem(itemId, opts);
  }

  /** Jump the transcript to an outline entry's anchor item — see `outline`. */
  scrollToOutlineEntry(entry: OutlineEntry): void {
    void this.scrollToTranscriptItem(entry.itemId, { align: 'start' });
  }

  /**
   * Report the bound view's "at bottom" state (see `onAtBottomChange` in
   * `ChatRoot`/`ChatView`, which only fires on a genuine true/false
   * transition — never redundantly). Leaving the tail freezes a new-events
   * baseline; returning to the tail clears it, so the count only ever
   * reflects turns that arrived while the user was actually reading history —
   * ticket #37 (spec #18).
   */
  setAtBottom(atBottom: boolean): void {
    if (atBottom) {
      this._readWatermark = null;
    } else if (!this._readWatermark) {
      const state = this.chatState.transcript.state;
      this._readWatermark = captureReadWatermark(state.committedTurns, state.activeTurnSnapshot);
    }
    this._syncNewEventCount();
  }

  /**
   * Jump to the newest transcript content without losing the current reading
   * position: the exact scroll intent is saved so `returnToReadingPosition`
   * can restore the same item and offset afterwards. Clears the new-event
   * count immediately (the user is about to see everything up to now) rather
   * than waiting for the async `setAtBottom(true)` callback that follows the
   * scroll animation, so the badge never lingers stale mid-jump.
   */
  visitNewestEvent(): void {
    const current = this.chatState.scroll.get();
    if (current.kind === 'anchor') {
      this._returnAnchor = current;
      this.canReturnToReadingPosition = true;
    }
    this._readWatermark = null;
    this._syncNewEventCount();
    this._view?.scrollToBottom({ behavior: 'smooth' });
  }

  /**
   * Restore the exact item + offset saved by `visitNewestEvent`. A no-op
   * when nothing was saved (e.g. already consumed, or the view never left
   * the tail in the first place).
   */
  returnToReadingPosition(): void {
    const anchor = this._returnAnchor;
    if (!anchor) return;
    this._returnAnchor = null;
    this.canReturnToReadingPosition = false;
    this._view?.setScrollMode(anchor);
  }

  async uploadAttachment(input: {
    data?: Uint8Array;
    source?: BlobSource;
    size?: number;
    mimeType: AttachmentMimeType;
    name?: string;
    originalPath?: string;
  }): Promise<AttachmentRef | null> {
    try {
      const result = await this.session?.uploadAttachment(input);
      if (!result) {
        this._toastError('Failed to upload attachment', new Error('ACP session is not connected'));
        return null;
      }
      if (!result.success) {
        this._toastError('Failed to upload attachment', result.error);
        return null;
      }
      return result.data;
    } catch (error) {
      this._toastError('Failed to upload attachment', error);
      return null;
    }
  }

  async deleteAttachment(id: string): Promise<void> {
    try {
      const result = await this.session?.deleteAttachment(id);
      if (result && !result.success) this._toastError('Failed to delete attachment', result.error);
    } catch (error) {
      this._toastError('Failed to delete attachment', error);
    }
  }

  /**
   * Direct send. Captures an immutable recovery snapshot before any state is
   * cleared; on rejection/throw the snapshot lands in `failedSubmissions`
   * instead of being lost — see `acp-submission-recovery.ts`.
   */
  submitPrompt(
    text: string,
    attachments: AcpPromptAttachment[] = [],
    hiddenContext?: string
  ): void {
    this._submissions.submit(text, attachments, hiddenContext);
  }

  /** Queued send — same recovery guarantee as `submitPrompt`. */
  queuePrompt(text: string, attachments: AcpPromptAttachment[] = [], hiddenContext?: string): void {
    this._submissions.queue(text, attachments, hiddenContext);
  }

  /**
   * Resend a failed submission under its original local identity. The entry
   * is removed before resending so it cannot be retried twice or duplicate
   * the prompt/turn.
   */
  retryFailedSubmission(localId: string): void {
    this._submissions.retry(localId);
  }

  /**
   * Remove a failed submission and hand its snapshot back to the caller so
   * the composer can reload it as editable text/attachments.
   */
  editFailedSubmission(localId: string): AcpSubmissionSnapshot | null {
    return this._submissions.edit(localId);
  }

  /**
   * Permanently drop a failed submission. Attachment release happens via the
   * controller's `onDiscard` hook — see `_releaseSubmissionAttachments`.
   */
  discardFailedSubmission(localId: string): void {
    this._submissions.discard(localId);
  }

  setDraftText(text: string): void {
    if (text === this.draftText) return;
    this.draftText = text;
    this._draftRev += 1;
    this._pendingDraftRev = this._draftRev;
    this._scheduleDraftWrite(text, this._draftRev);
  }

  /**
   * Cancel the active turn. Shared by the composer's Stop button and the
   * active-message Stop action in the transcript (see acp-chat-panel.tsx),
   * so both surfaces are single-flight together and disable in lockstep.
   */
  stop(): void {
    this._stopController.stop();
  }

  setModel(model: string): void {
    void this.session
      ?.setModelOption('model', model)
      .then((result) => {
        if (!result.success) this._toastError('Failed to change model', result.error);
      })
      .catch((error: unknown) => this._toastError('Failed to change model', error));
  }

  setMode(modeId: string): void {
    void this.session
      ?.setModeOption(modeId)
      .then((result) => {
        if (!result.success) this._toastError('Failed to change session mode', result.error);
      })
      .catch((error: unknown) => this._toastError('Failed to change session mode', error));
  }

  setEffort(effort: string): void {
    void this.session
      ?.setModelOption('effort', effort)
      .then((result) => {
        if (!result.success) this._toastError('Failed to change effort', result.error);
      })
      .catch((error: unknown) => this._toastError('Failed to change effort', error));
  }

  resolvePermission(optionId: string): void {
    const request = this.permissionQueue[0];
    if (!request) return;
    void this.session?.resolvePermission(request.requestId, optionId);
  }

  editQueuedPrompt(id: string, text: string): void {
    const existing = this._queuedPromptModels().find((prompt) => prompt.id === id);
    if (!existing) return;
    const input: PromptInput = {
      text,
      hiddenContext: existing.hiddenContext,
      attachments: existing.attachments,
    };
    void this.session
      ?.editQueuedPrompt(id, input)
      .then((result) => {
        if (!result.success) this._toastError('Failed to edit queued prompt', result.error);
      })
      .catch((error: unknown) => this._toastError('Failed to edit queued prompt', error));
  }

  deleteQueuedPrompt(id: string): void {
    void this.session
      ?.deleteQueuedPrompt(id)
      .then((result) => {
        if (!result.success) this._toastError('Failed to delete queued prompt', result.error);
      })
      .catch((error: unknown) => this._toastError('Failed to delete queued prompt', error));
  }

  reorderQueuedPrompts(ids: string[]): void {
    void this.session
      ?.changeQueuePromptOrder(ids)
      .then((result) => {
        if (!result.success) this._toastError('Failed to reorder queued prompts', result.error);
      })
      .catch((error: unknown) => this._toastError('Failed to reorder queued prompts', error));
  }

  sendQueuedPromptNow(id: string): void {
    void this._sendQueuedPromptNow(id);
  }

  exportTranscript(kind: 'parsed' | 'raw'): void {
    void this._exportTranscript(kind);
  }

  dispose(): void {
    unregisterConversationCommands(this.conversationId);
    if (this._draftTimer !== null) {
      window.clearTimeout(this._draftTimer);
      this._draftTimer = null;
    }
    this._unsubs.splice(0).forEach((unsub) => unsub());
    this.session?.dispose();
    this.chatState.dispose();
  }

  private async _runBootstrap(): Promise<void> {
    // Fence off any older-page load already in flight from a prior attempt
    // (retry after a load error) before this bootstrap seeds fresh state.
    this._historyPagination.reset();
    let providerId: string | undefined;
    try {
      const input = this._startInput();
      providerId = input.providerId;
      const clientSession = await AcpLiveSession.create(this.conversationId, input);

      const history = await clientSession.getHistory(undefined, HISTORY_PAGE_SIZE);
      if (!history.success) throw resultError(history.error);

      runInAction(() => {
        this.session?.dispose();
        this.session = clientSession;
        this.chatState.transcript.history.seed(history.data.turns);
        this._historyPagination.seed(history.data);
        this._subscribeLiveSession(clientSession);
        this._applyDraftSnapshot(clientSession.draft.current());
        this.historyLoading = false;
        this.loadError = null;
        // A (re)seed starts a fresh transcript identity — any reading
        // position saved from a prior session/attempt no longer applies.
        this._resetReadingPosition();
        this._syncMessageCount();
        this._syncChangesFootprint();
      });
    } catch (error) {
      log.error('ACP chat bootstrap failed', {
        conversationId: this.conversationId,
        projectId: this.projectId,
        taskId: this.taskId,
        error,
      });
      runInAction(() => {
        this.historyLoading = false;
        this.loadError = toLoadError(error);
      });
      if (this.loadError?.kind === 'auth_required' && providerId) {
        void this._refreshAuthStatus(providerId);
      }
    }
  }

  private async _refreshAuthStatus(providerId: string): Promise<void> {
    try {
      const client = await getAgentConfigRuntimeClient();
      const result = await client.refreshAuthStatus({ providerId });
      if (!result.success) {
        log.warn('Failed to refresh agent auth status after ACP auth error', {
          providerId,
          error: result.error,
        });
      }
    } catch (error) {
      log.warn('Failed to refresh agent auth status after ACP auth error', {
        providerId,
        error,
      });
    }
  }

  private _startInput() {
    const conversation = conversationRegistry
      .get(this.taskId)
      ?.conversations.get(this.conversationId)?.data;
    if (!conversation) throw new Error('Conversation not found');

    const task = asProvisioned(getTaskStore(this.projectId, this.taskId));
    if (!task?.workspaceId) throw new Error('No workspace found for task');

    const workspace = workspaceRegistry.get(this.projectId, task.workspaceId);
    if (!workspace) throw new Error('Workspace not found');

    const initialQueue =
      conversation.sessionId === undefined && conversation.initialQueue?.length
        ? toJS(conversation.initialQueue)
        : undefined;

    return {
      conversationId: this.conversationId,
      projectId: this.projectId,
      taskId: this.taskId,
      providerId: conversation.providerId,
      workspaceId: task.workspaceId,
      cwd: workspace.path,
      sessionId: conversation.sessionId ?? null,
      model: conversation.model ?? null,
      ...(initialQueue && { initialQueue }),
    };
  }

  private _queuedPromptModels(): QueuedPrompt[] {
    return this.session?.sessionState.current().queuedPrompts ?? [];
  }

  /** Bridges `AcpSubmissionController` to the live ACP session, if connected. */
  private _sessionPort(): AcpSubmissionSessionPort | null {
    const session = this.session;
    if (!session) return null;
    return {
      isWorking: () => this.affordances.isWorking,
      queuedPromptCount: () => this._queuedPromptModels().length,
      sendPrompt: (input) => session.sendPrompt(input),
      queuePrompt: (input) => session.queuePrompt(input),
    };
  }

  /** Show the optimistic user bubble for a direct send started while idle. */
  private _showOptimisticPrompt(snapshot: AcpSubmissionSnapshot): void {
    this.chatState.session.setPendingPrompt({
      id: snapshot.localId,
      text: snapshot.text,
      attachments: snapshot.attachments.map(toPendingAttachment),
    });
    this._syncMessageCount();
    const pinMode = pinTopMode(snapshot.localId);
    this._view?.setScrollMode(pinMode);
    this.chatState.scroll.set(pinMode);
  }

  /**
   * A submission was rejected or threw. Clear any matching optimistic bubble
   * (there is no turn behind it) and surface the failure — the snapshot
   * itself is already preserved in `failedSubmissions` by the controller.
   */
  private _handleSubmissionFailure(failure: FailedAcpSubmission): void {
    runInAction(() => {
      if (this.chatState.session.state.pendingPrompt?.id === failure.localId) {
        this.chatState.session.setPendingPrompt(null);
        this._syncMessageCount();
      }
    });
    this._toastError(
      failure.kind === 'queued' ? 'Failed to queue message' : 'Failed to send message',
      new Error(failure.error)
    );
  }

  /** A failed submission was discarded for good — release any uploaded attachments. */
  private _releaseSubmissionAttachments(discarded: FailedAcpSubmission): void {
    for (const attachment of discarded.attachments) {
      void this.deleteAttachment(attachment.ref.id);
    }
  }

  private async _sendQueuedPromptNow(id: string): Promise<void> {
    const current = this._queuedPromptModels();
    if (!current.some((prompt) => prompt.id === id)) return;

    const ids = [id, ...current.map((prompt) => prompt.id).filter((promptId) => promptId !== id)];
    const reorderResult = await this.session?.changeQueuePromptOrder(ids);
    if (!reorderResult?.success) {
      this._toastError('Failed to send queued prompt', reorderResult?.error);
      return;
    }

    if (!this.affordances.isWorking) return;
    const cancelResult = await this.session?.cancelTurn();
    if (!cancelResult?.success) {
      this._toastError('Failed to send queued prompt', cancelResult?.error);
    }
  }

  private async _exportTranscript(kind: 'parsed' | 'raw'): Promise<void> {
    const session = this.session;
    if (!session) {
      this._toastError('Failed to export transcript', new Error('Chat is not loaded.'));
      return;
    }

    try {
      const result =
        kind === 'raw' ? await session.exportRawAcpLog() : await session.exportTranscript();
      if (!result.success) {
        this._toastError('Failed to export transcript', result.error);
        return;
      }

      const label = kind === 'raw' ? 'raw ACP log' : 'parsed transcript';
      const suffix = kind === 'raw' ? 'acp-raw' : 'transcript';
      const saved = await rpc.app.saveTextFile({
        title: `Export ${label}`,
        defaultPath: `${this.conversationId}-${suffix}.json`,
        content: result.data,
      });
      if (!saved.success) {
        this._toastError('Failed to save transcript', new Error(saved.error));
        return;
      }
      if (!saved.path) return;
      toast({ title: `Exported ${label}` });
    } catch (error) {
      this._toastError('Failed to export transcript', error);
    }
  }

  private _subscribeLiveSession(session: AcpLiveSession): void {
    this._unsubs.splice(0).forEach((unsub) => unsub());
    const disconnectChatSession = connectSession(
      this.chatState,
      {
        activeTurn: asValueSource(session.activeTurn),
        plan: asValueSource(session.plan),
        sessionState: asValueSource(session.sessionState),
      },
      {
        onTurnCommitted: () => void this._refreshHistory(),
      }
    );
    this._unsubs.push(
      disconnectChatSession,
      this._bindTerminalOutputs(session),
      session.sessionState.onChange(() =>
        runInAction(() => {
          this._syncMessageCount();
        })
      ),
      session.activeTurn.onChange(() =>
        runInAction(() => {
          this._syncMessageCount();
          this._syncChangesFootprint();
          this._syncNewEventCount();
        })
      ),
      session.draft.onChange((draft) =>
        runInAction(() => {
          this._applyDraftSnapshot(draft);
        })
      ),
      // The Changes footprint reconciles transcript activity with the task's
      // current Git status; resync whenever a fresh Git snapshot arrives
      // (e.g. the working tree changed outside this conversation, or the
      // watcher catches up with edits this conversation just made).
      reaction(
        () => this._resolveWorkspace()?.gitWorktree.fileChanges,
        () => runInAction(() => this._syncChangesFootprint())
      )
    );
  }

  private _scheduleDraftWrite(text: string, rev: number): void {
    if (this._draftTimer !== null) window.clearTimeout(this._draftTimer);
    this._draftTimer = window.setTimeout(() => {
      this._draftTimer = null;
      const draft = { rev, input: text.trim().length > 0 ? { text } : null };
      void this.session
        ?.setPromptDraft(draft)
        .then((result) => {
          if (!result.success) this._toastError('Failed to sync draft', result.error);
          if (result.success && draft.input === null && this._pendingDraftRev === rev) {
            runInAction(() => {
              this._pendingDraftRev = null;
            });
          }
        })
        .catch((error: unknown) => this._toastError('Failed to sync draft', error));
    }, 300);
  }

  private _applyDraftSnapshot(draft: PromptDraft | null | undefined): void {
    if (draft === undefined) return;
    if (draft === null) {
      if (this._pendingDraftRev === null) {
        this._draftRev += 1;
        this.draftText = '';
      }
      return;
    }

    if (this._pendingDraftRev !== null) {
      if (draft.rev >= this._pendingDraftRev) {
        this._draftRev = Math.max(this._draftRev, draft.rev);
        this._pendingDraftRev = null;
      }
      return;
    }

    if (draft.rev >= this._draftRev) {
      this._draftRev = draft.rev;
      this.draftText = draft.text;
    }
  }

  private _bindTerminalOutputs(session: AcpLiveSession): () => void {
    return bindSessionTerminalOutputs(session, (terminalId, text) =>
      this.chatState.session.setTerminalOutput(terminalId, text)
    );
  }

  /**
   * Re-fetch the most recent history window after a turn commits (the
   * runtime only exposes a just-finished turn's content through the
   * canonical history, not through `activeTurn`). Appends only turns not
   * already known — via `AcpHistoryPagination.reconcileRefresh` — so this
   * never discards older pages already prepended by `loadOlderHistory`.
   */
  private async _refreshHistory(): Promise<void> {
    const history = await this.session?.getHistory(undefined, HISTORY_PAGE_SIZE);
    if (!history?.success) return;
    const fresh = this._historyPagination.reconcileRefresh(history.data.turns);
    runInAction(() => {
      this.chatState.session.setPendingPrompt(null);
      this.chatState.transcript.history.append([...fresh]);
      this._syncMessageCount();
      this._syncChangesFootprint();
      this._syncNewEventCount();
    });
  }

  /**
   * Shared `isLoadingOlderHistory` bookkeeping around `_loadOlderHistory`,
   * used by both the scroll-driven `loadOlderHistory()` and the itemId-driven
   * `scrollToTranscriptItem()` retry loop.
   */
  private _loadOlderPage(begin: { epoch: number; before: number }): Promise<void> {
    this.isLoadingOlderHistory = true;
    return this._loadOlderHistory(begin.epoch, begin.before).finally(() => {
      runInAction(() => {
        this.isLoadingOlderHistory = false;
      });
    });
  }

  /**
   * Fetch and prepend one older-history page. Reach-start can only fire while
   * this conversation's view is bound, but the fetch is async — the panel may
   * have switched to another conversation (unbinding `_view`) by the time it
   * resolves. When still bound, go through `ChatView.loadOlder` (chat-ui's
   * `doLoadOlder`) to also capture/restore the visible reading position; when
   * backgrounded, prepend directly into `chatState` so the page is never
   * silently dropped — it renders correctly once the view rebinds.
   */
  private async _loadOlderHistory(epoch: number, before: number): Promise<void> {
    try {
      const result = await this.session?.getHistory(before, HISTORY_PAGE_SIZE);
      if (!result) {
        this._historyPagination.abortLoadOlder(epoch);
        return;
      }
      if (!result.success) {
        this._historyPagination.abortLoadOlder(epoch);
        this._toastError('Failed to load older messages', result.error);
        return;
      }
      const fresh = this._historyPagination.completeLoadOlder(epoch, result.data);
      if (!fresh || fresh.length === 0) return;
      runInAction(() => {
        if (this._view) {
          this._view.loadOlder([...fresh]);
        } else {
          this.chatState.transcript.history.prepend([...fresh]);
        }
        this._syncMessageCount();
        this._syncChangesFootprint();
        this._syncNewEventCount();
      });
    } catch (error) {
      this._historyPagination.abortLoadOlder(epoch);
      this._toastError('Failed to load older messages', error);
    }
  }

  private _syncMessageCount(): void {
    const state = this.chatState.transcript.state;
    const committedCount = state.committedTurns.reduce(
      (count, turn) => count + turn.items.length,
      0
    );
    const activeCount = state.activeTurnSnapshot?.items.length ?? 0;
    const pendingPromptCount = this.chatState.session.state.pendingPrompt ? 1 : 0;
    this.messageCount = committedCount + activeCount + pendingPromptCount;
  }

  /**
   * Resolves this store's task workspace, if the task is currently
   * provisioned. Used for the Changes footprint's Git-status input and path
   * normalization — see `_syncChangesFootprint`. Returns null (rather than
   * throwing, unlike `_startInput`) so the footprint degrades to
   * transcript-only when the workspace is not resolvable.
   */
  private _resolveWorkspace() {
    const task = asProvisioned(getTaskStore(this.projectId, this.taskId));
    if (!task?.workspaceId) return null;
    return workspaceRegistry.get(this.projectId, task.workspaceId) ?? null;
  }

  /**
   * Recompute the task-scoped Changes footprint. Called wherever the
   * transcript (committed history or the active turn) or the task's current
   * Git status can change — bootstrap, history refresh/load-older, live
   * active-turn updates, and the Git reaction registered in
   * `_subscribeLiveSession`.
   */
  private _syncChangesFootprint(): void {
    const workspace = this._resolveWorkspace();
    const state = this.chatState.transcript.state;
    this.changesFootprint = buildChangesFootprint({
      committedTurns: state.committedTurns,
      activeTurn: state.activeTurnSnapshot,
      gitChanges: workspace?.gitWorktree.fileChanges ?? [],
      workspacePath: workspace?.path ?? null,
    });
  }

  /**
   * Recompute `newEventCount` against the frozen `_readWatermark` baseline
   * (see `setAtBottom`). A no-op value of 0 while following the tail (no
   * watermark set). Called at every point the transcript can grow: live
   * active-turn updates (streaming + turn commit), the post-commit history
   * refresh, and history load-older — mirrors `_syncChangesFootprint`'s call
   * sites. Ticket #37 (spec #18).
   */
  private _syncNewEventCount(): void {
    if (!this._readWatermark) {
      this.newEventCount = 0;
      return;
    }
    const state = this.chatState.transcript.state;
    this.newEventCount = countNewTranscriptEvents(
      this._readWatermark,
      state.committedTurns,
      state.activeTurnSnapshot
    );
  }

  /**
   * Clear any saved reading position/watermark/return-anchor. Called when a
   * (re)seed starts a fresh transcript identity (initial bootstrap or
   * `retry()` after a load error) — a position saved against the prior
   * transcript no longer applies.
   */
  private _resetReadingPosition(): void {
    this._readWatermark = null;
    this._returnAnchor = null;
    this.canReturnToReadingPosition = false;
    this.newEventCount = 0;
  }

  private _toastError(title: string, error: unknown): void {
    toast({
      title,
      description: error instanceof Error ? error.message : undefined,
      variant: 'destructive',
    });
  }
}

function toPendingAttachment(attachment: AcpPromptAttachment): ChatImageAttachment {
  return {
    id: attachment.ref.id,
    name: attachment.ref.name ?? 'image',
    dataUrl: attachment.previewUrl,
  };
}

function toLoadError(error: unknown): AcpLoadError {
  const message = error instanceof Error ? error.message : 'Failed to load chat.';
  if (error instanceof AcpStartError && error.errorType === 'auth_required') {
    return { kind: 'auth_required', message };
  }
  return { kind: 'generic', message };
}
