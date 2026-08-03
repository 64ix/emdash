import type { TranscriptItem, TranscriptTurn } from '@emdash/core/acp/client';
import { autorun } from 'mobx';
import { describe, expect, it, vi } from 'vitest';
import { AcpChatStore } from './acp-chat-store';
import type { AcpHistoryPagination } from './acp-history-pagination';
import { bindSessionTerminalOutputs } from './acp-terminal-output-binding';

// ── AcpChatStore.loadOlderHistory — bound view vs. unbound fallback ──────────
//
// Vitest hoists `vi.mock` factory calls above every import in this file
// (including the static `AcpChatStore` import below), so the mocks declared
// here take effect before `acp-chat-store.ts` and its dependency graph load.
//
// `@emdash/chat-ui`'s built bundle touches `document` at import time (it
// bundles the Solid-rendered ChatRoot alongside the state-only exports this
// store actually uses), so any file that imports it — `acp-chat-store.ts`
// itself, and its `shared-chat-context`/`advertised-command-provider`
// dependencies — cannot load under the `node` Vitest environment. Mock all
// three so `AcpChatStore` can be constructed and exercised here without a
// DOM, and fake only the small slice of `ChatState`/`ChatView` the store
// actually calls (`transcript.history.{prepend,append}`,
// `session.setPendingPrompt`, `transcript.state`).
//
// `acp-chat-store.ts` also pulls in `workspace-registry` -> `WorkspaceStore`,
// which imports the process-global `appState` singleton; constructing it
// starts real `rpc` calls (e.g. `ssh.getConnections`) that reject in the node
// test environment (no `window.electronAPI`). Mock it too so importing the
// store module never triggers that unrelated, unhandled side effect.
vi.mock('@emdash/chat-ui', () => ({
  connectSession: vi.fn(() => () => {}),
  createChatState: () => makeFakeChatState(),
  pinTopMode: vi.fn(() => ({ kind: 'pin-top' })),
  // Real derivation semantics are covered by chat-ui's own
  // `state/outline.test.ts`; this file only needs `AcpChatStore.outline` to
  // exist and to forward its four arguments unchanged (see the "outline"
  // describe block below).
  deriveTranscriptOutline: vi.fn(
    (
      committedTurns: unknown,
      activeTurn: unknown,
      turnStatus: unknown,
      pendingPrompt: unknown
    ) => ({ committedTurns, activeTurn, turnStatus, pendingPrompt })
  ),
  // Real (simplified) semantics rather than a passthrough echo — ticket #37's
  // wiring tests below assert actual counts across setAtBottom/transcript-
  // growth transitions. The turn-identity math itself is unit-tested in
  // chat-ui's own `state/reading-position.test.ts`.
  captureReadWatermark: (committedTurns: TranscriptTurn[], activeTurn: TranscriptTurn | null) => ({
    lastCommittedTurnId: committedTurns[committedTurns.length - 1]?.id ?? null,
    activeTurnId: activeTurn?.id ?? null,
  }),
  countNewTranscriptEvents: (
    watermark: { lastCommittedTurnId: string | null; activeTurnId: string | null },
    committedTurns: TranscriptTurn[],
    activeTurn: TranscriptTurn | null
  ) => {
    const lastCommittedIdx =
      watermark.lastCommittedTurnId === null
        ? -1
        : committedTurns.findIndex((turn) => turn.id === watermark.lastCommittedTurnId);
    let newCommittedCount: number;
    if (watermark.lastCommittedTurnId !== null && lastCommittedIdx === -1) {
      newCommittedCount = committedTurns.length;
    } else {
      const settledActiveIdx =
        watermark.activeTurnId === null
          ? -1
          : committedTurns.findIndex((turn) => turn.id === watermark.activeTurnId);
      const baselineIdx = Math.max(lastCommittedIdx, settledActiveIdx);
      newCommittedCount = committedTurns.length - 1 - baselineIdx;
    }
    const hasNewActiveTurn = activeTurn !== null && activeTurn.id !== watermark.activeTurnId;
    return newCommittedCount + (hasNewActiveTurn ? 1 : 0);
  },
}));
vi.mock('@renderer/lib/chat/shared-chat-context', () => ({
  getSharedChatContext: () => ({}),
}));
vi.mock('@renderer/lib/chat/advertised-command-provider', () => ({
  registerConversationCommands: vi.fn(),
  unregisterConversationCommands: vi.fn(),
}));
// `projects` is an empty Map (rather than omitted) so `_resolveWorkspace()`'s
// `getTaskStore` lookup (used by `_syncChangesFootprint`) resolves to "task
// not found" the same way it would for any unregistered task, instead of
// throwing on a missing `.projects`.
vi.mock('@renderer/lib/stores/app-state', () => ({
  appState: {
    sshConnections: {
      stateFor: vi.fn(),
      connect: vi.fn(async () => {}),
    },
    projects: { projects: new Map() },
  },
}));

type FakeChatState = ReturnType<typeof makeFakeChatState>;

function makeFakeChatState() {
  let committed: TranscriptTurn[] = [];
  let scrollMode: unknown = { kind: 'tail' };
  return {
    scroll: {
      get: () => scrollMode,
      set: (mode: unknown) => {
        scrollMode = mode;
      },
    },
    transcript: {
      history: {
        get: () => committed,
        seed: (turns: readonly TranscriptTurn[]) => {
          committed = [...turns];
        },
        prepend: (turns: readonly TranscriptTurn[]) => {
          committed = [...turns, ...committed];
        },
        append: (turns: readonly TranscriptTurn[]) => {
          committed = [...committed, ...turns];
        },
      },
      state: {
        get committedTurns() {
          return committed;
        },
        activeTurnSnapshot: null,
        turnStatus: 'done',
      },
      findItemById: (id: string) => {
        for (const turn of committed) {
          const item = turn.items.find((candidate) => candidate.id === id);
          if (item) return item;
        }
        return undefined;
      },
    },
    session: {
      state: { pendingPrompt: null },
      setPendingPrompt: vi.fn(),
    },
    dispose: vi.fn(),
  };
}

function makeTurn(seq: number): TranscriptTurn {
  return {
    id: `turn-${seq}`,
    seq,
    initiator: 'agent',
    items: [],
    outcome: { kind: 'done' },
  };
}

/** A turn with one addressable message item, for `scrollToTranscriptItem` fixtures. */
function makeMessageTurn(seq: number, itemId: string): TranscriptTurn {
  return {
    id: `turn-${seq}`,
    seq,
    initiator: 'agent',
    items: [{ kind: 'message', id: itemId, seq: 0, role: 'assistant', text: `text for ${itemId}` }],
    outcome: { kind: 'done' },
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function setUpStore(seedTurns: TranscriptTurn[], nextCursor: number | null) {
  const store = new AcpChatStore('conversation-1', 'project-1', 'task-1');
  const pagination = (store as unknown as { _historyPagination: AcpHistoryPagination })
    ._historyPagination;
  pagination.seed({ turns: seedTurns, nextCursor });
  const fakeChatState = store.chatState as unknown as FakeChatState;
  fakeChatState.transcript.history.seed(seedTurns);
  // Mirror what `_runBootstrap` does after a real (re)seed. `outline` and
  // `newEventCount` are explicitly-resynced observable fields rather than lazy
  // computeds (see the field docs in acp-chat-store.ts), so a fixture that
  // seeds the fake chat state directly has to resync them too — otherwise it
  // hands tests a store whose derived state never matches its transcript.
  (store as unknown as { _syncOutline(): void })._syncOutline();
  return { store, fakeChatState };
}

describe('AcpChatStore.loadOlderHistory', () => {
  it('prepends through the bound view, preserving the scroll-anchor seam', async () => {
    const { store, fakeChatState } = setUpStore([makeTurn(10), makeTurn(11)], 10);
    const olderPage = { turns: [makeTurn(8), makeTurn(9)], nextCursor: null };
    store.session = {
      getHistory: vi.fn(async () => ({ success: true, data: olderPage })),
    } as never;

    const loadOlder = vi.fn();
    store.bindView({ loadOlder } as never);

    void store.loadOlderHistory();
    await flushMicrotasks();

    // The view handle owns the anchor-preserving prepend; the store must not
    // also write straight into chatState when a view is bound (that would
    // double-apply the page once the view's own `loadOlder` runs).
    expect(loadOlder).toHaveBeenCalledTimes(1);
    expect(loadOlder).toHaveBeenCalledWith([makeTurn(8), makeTurn(9)]);
    expect(fakeChatState.transcript.history.get()).toEqual([makeTurn(10), makeTurn(11)]);
  });

  it('falls back to prepending directly into chatState when the view is unbound', async () => {
    const { store, fakeChatState } = setUpStore([makeTurn(10), makeTurn(11)], 10);
    const olderPage = { turns: [makeTurn(8), makeTurn(9)], nextCursor: null };
    store.session = {
      getHistory: vi.fn(async () => ({ success: true, data: olderPage })),
    } as never;

    // Tab switched away before the fetch resolves: no view bound.
    store.bindView(null);
    void store.loadOlderHistory();
    await flushMicrotasks();

    expect(fakeChatState.transcript.history.get()).toEqual([
      makeTurn(8),
      makeTurn(9),
      makeTurn(10),
      makeTurn(11),
    ]);
  });

  it('does not duplicate or drop the fallback-loaded page once the view rebinds', async () => {
    const { store, fakeChatState } = setUpStore([makeTurn(10), makeTurn(11)], 10);
    // Not yet the true start of history: nextCursor 8 leaves one more page.
    const olderPage = { turns: [makeTurn(8), makeTurn(9)], nextCursor: 8 };
    store.session = {
      getHistory: vi.fn(async () => ({ success: true, data: olderPage })),
    } as never;

    store.bindView(null);
    void store.loadOlderHistory();
    await flushMicrotasks();

    // Switching back to this conversation rebinds a fresh view handle. The
    // page already landed in chatState via the fallback path — rebinding
    // must not replay or duplicate it.
    const loadOlder = vi.fn();
    store.bindView({ loadOlder } as never);

    expect(loadOlder).not.toHaveBeenCalled();
    expect(fakeChatState.transcript.history.get()).toEqual([
      makeTurn(8),
      makeTurn(9),
      makeTurn(10),
      makeTurn(11),
    ]);

    // A further reach-start (now with the view bound again) pages in the
    // true start of history — the earlier fallback write must not have left
    // pagination or chatState in a state that corrupts this next load, and
    // it must now go through the rebound view rather than the fallback path.
    const finalPage = { turns: [makeTurn(6), makeTurn(7)], nextCursor: null };
    store.session = {
      getHistory: vi.fn(async () => ({ success: true, data: finalPage })),
    } as never;
    void store.loadOlderHistory();
    await flushMicrotasks();

    expect(loadOlder).toHaveBeenCalledTimes(1);
    expect(loadOlder).toHaveBeenCalledWith([makeTurn(6), makeTurn(7)]);
    expect(fakeChatState.transcript.history.get()).toEqual([
      makeTurn(8),
      makeTurn(9),
      makeTurn(10),
      makeTurn(11),
    ]);
  });

  it('toggles isLoadingOlderHistory around the fetch', async () => {
    const { store } = setUpStore([makeTurn(10), makeTurn(11)], 10);
    let resolveHistory!: (value: {
      success: true;
      data: { turns: TranscriptTurn[]; nextCursor: null };
    }) => void;
    store.session = {
      getHistory: vi.fn(
        () =>
          new Promise((resolve) => {
            resolveHistory = resolve;
          })
      ),
    } as never;

    expect(store.isLoadingOlderHistory).toBe(false);
    const pending = store.loadOlderHistory();
    expect(store.isLoadingOlderHistory).toBe(true);

    resolveHistory({ success: true, data: { turns: [makeTurn(9)], nextCursor: null } });
    await pending;

    expect(store.isLoadingOlderHistory).toBe(false);
  });
});

// ── AcpChatStore.scrollToTranscriptItem / scrollToOutlineEntry ───────────────
//
// The outline (ticket #34) selects an entry by calling `scrollToOutlineEntry`,
// which delegates to this generic, reusable "resolve an itemId then scroll"
// capability. The interesting case is an itemId that belongs to a page that
// has not been paginated into `chatState` yet — this must page it in through
// the existing `loadOlderHistory` path and then land on it, not silently
// no-op or leave the view scrolled to the wrong row.
describe('AcpChatStore.scrollToTranscriptItem', () => {
  function setUpStore(seedTurns: TranscriptTurn[], nextCursor: number | null) {
    const store = new AcpChatStore('conversation-1', 'project-1', 'task-1');
    const pagination = (store as unknown as { _historyPagination: AcpHistoryPagination })
      ._historyPagination;
    pagination.seed({ turns: seedTurns, nextCursor });
    const fakeChatState = store.chatState as unknown as FakeChatState;
    fakeChatState.transcript.history.seed(seedTurns);
    // See the module-level setUpStore: resync the explicitly-synced fields.
    (store as unknown as { _syncOutline(): void })._syncOutline();
    return { store, fakeChatState };
  }

  it('scrolls immediately when the item is already loaded, without paging', async () => {
    const { store } = setUpStore([makeMessageTurn(10, 'target-item'), makeTurn(11)], 10);
    const getHistory = vi.fn();
    store.session = { getHistory } as never;
    const scrollToItem = vi.fn();
    store.bindView({ scrollToItem } as never);

    await store.scrollToTranscriptItem('target-item');

    expect(scrollToItem).toHaveBeenCalledWith('target-item', undefined);
    expect(getHistory).not.toHaveBeenCalled();
  });

  it('pages in older history through loadOlderHistory and lands on the newly-revealed turn', async () => {
    const { store, fakeChatState } = setUpStore([makeTurn(10), makeTurn(11)], 10);
    const olderPage = {
      turns: [makeTurn(8), makeMessageTurn(9, 'target-item')],
      nextCursor: null,
    };
    const getHistory = vi.fn(async () => ({ success: true, data: olderPage }));
    store.session = { getHistory } as never;

    const scrollToItem = vi.fn();
    // Simulate the real ChatView.loadOlder contract: prepend into chatState
    // (see ChatRoot.tsx's doLoadOlder) — a bare spy would not, and the target
    // item would never become findable.
    const loadOlder = vi.fn((turns: TranscriptTurn[]) => {
      fakeChatState.transcript.history.prepend(turns);
    });
    store.bindView({ loadOlder, scrollToItem } as never);

    await store.scrollToTranscriptItem('target-item', { align: 'start' });

    // The existing loadOlderHistory path actually ran (not a silent no-op)...
    expect(getHistory).toHaveBeenCalledTimes(1);
    expect(loadOlder).toHaveBeenCalledWith(olderPage.turns);
    // ...and the jump landed on the correct row once it was loaded, aligned
    // to the top like every other outline selection.
    expect(scrollToItem).toHaveBeenCalledWith('target-item', { align: 'start' });
    expect(fakeChatState.transcript.history.get().map((t) => t.id)).toEqual([
      'turn-8',
      'turn-9',
      'turn-10',
      'turn-11',
    ]);
  });

  it('gives up once history is exhausted instead of retrying forever', async () => {
    // nextCursor null at seed time: pagination is already exhausted.
    const { store } = setUpStore([makeTurn(10), makeTurn(11)], null);
    const getHistory = vi.fn();
    store.session = { getHistory } as never;
    const scrollToItem = vi.fn();
    store.bindView({ scrollToItem } as never);

    await store.scrollToTranscriptItem('never-loaded-item');

    expect(getHistory).not.toHaveBeenCalled();
    expect(scrollToItem).not.toHaveBeenCalled();
  });

  it('scrollToOutlineEntry delegates to scrollToTranscriptItem, aligned to the top', async () => {
    const { store } = setUpStore([makeMessageTurn(10, 'entry-item'), makeTurn(11)], 10);
    const scrollToItem = vi.fn();
    store.bindView({ scrollToItem } as never);

    store.scrollToOutlineEntry({ itemId: 'entry-item' } as never);
    await flushMicrotasks();

    expect(scrollToItem).toHaveBeenCalledWith('entry-item', { align: 'start' });
  });
});

describe('AcpChatStore.outline', () => {
  it('derives from the current committed/active/pending-prompt transcript state', async () => {
    // `outline` is an explicitly-resynced observable field, not a `computed`
    // getter: a computed reading only Solid-signal state has no MobX-tracked
    // dependency, so MobX would cache its first evaluation forever once
    // observed (the #34 staleness bug found in #37's review). So this test
    // must grow the transcript through a real store path — seeding the fake
    // chat state directly, as the original version of this test did, bypasses
    // every resync point and is exactly the read the old getter made look
    // correct.
    const older = makeTurn(1);
    const { store, fakeChatState } = setUpStore([makeTurn(2)], 1);
    store.session = {
      getHistory: vi.fn(async () => ({
        success: true,
        data: { turns: [older], nextCursor: null },
      })),
    } as never;
    store.bindView(null);

    void store.loadOlderHistory();
    await flushMicrotasks();

    expect(store.outline).toEqual({
      committedTurns: fakeChatState.transcript.history.get(),
      activeTurn: fakeChatState.transcript.state.activeTurnSnapshot,
      turnStatus: fakeChatState.transcript.state.turnStatus,
      pendingPrompt: fakeChatState.session.state.pendingPrompt,
    });
  });

  it('keeps updating once observed, instead of caching its first evaluation', async () => {
    // Regression guard for the #34 staleness bug. It only reproduces while the
    // value is *observed*: a MobX `computed` re-evaluates on every read outside
    // a reaction, so a plain read cannot catch it. `autorun` is what makes the
    // value "hot" — the same thing `observer()` does in AcpChatPanel's render.
    // Against the original `computed` (whose body read only Solid-signal state
    // and therefore had zero MobX-tracked dependencies) the second assertion
    // below fails: MobX never invalidates, so the outline stays frozen at its
    // first evaluation no matter how much the transcript grows.
    const { store, fakeChatState } = setUpStore([makeTurn(2)], 1);
    store.session = {
      getHistory: vi.fn(async () => ({
        success: true,
        data: { turns: [makeTurn(1)], nextCursor: null },
      })),
    } as never;
    store.bindView(null);

    const seen: number[] = [];
    const stop = autorun(() => {
      // The mocked `deriveTranscriptOutline` echoes its arguments back as an
      // object rather than returning a real OutlineEntry[], hence the cast.
      const echoed = store.outline as unknown as { committedTurns: readonly unknown[] };
      seen.push(echoed.committedTurns.length);
    });

    expect(seen).toEqual([1]);

    void store.loadOlderHistory();
    await flushMicrotasks();

    expect(fakeChatState.transcript.history.get()).toHaveLength(2);
    expect(seen.at(-1)).toBe(2);
    stop();
  });
});

// ── AcpChatStore.permissionQueue / resolvePermission / permissionResolution ──
//
// Ticket #32: the queue must carry the normalized operation detail and the
// originating item id (for "jump to origin"), and resolution must expose
// pending/error state per the *current* request rather than silently
// swallowing a failed decision.
describe('AcpChatStore.permissionQueue / resolvePermission', () => {
  function toolCall(overrides: Record<string, unknown> = {}) {
    return {
      id: 'item-permission-1',
      seq: 0,
      toolCallId: 'call-1',
      title: 'Execute a Shell Command',
      status: 'pending',
      kind: 'execute-tool-call',
      command: 'rm -rf ./dist',
      ...overrides,
    };
  }

  function permissionRequest(overrides: Record<string, unknown> = {}) {
    return {
      requestId: 'req-1',
      toolCall: toolCall(),
      options: [
        { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
      ],
      ...overrides,
    };
  }

  it('maps the normalized operation detail and originating item id onto each queue entry', () => {
    const store = new AcpChatStore('conversation-1', 'project-1', 'task-1');
    store.session = {
      sessionState: { current: () => ({ pendingPermissions: [permissionRequest()] }) },
    } as never;

    expect(store.permissionQueue).toHaveLength(1);
    const item = store.permissionQueue[0];
    expect(item.itemId).toBe('item-permission-1');
    expect(item.operation.kind).toBe('command');
    expect(item.operation.command?.text).toBe('rm -rf ./dist');
  });

  it('redacts a secret embedded in the toolCall title (e.g. a web-fetch title that falls back to the raw URL)', () => {
    // `web-fetch-tool-call`'s title falls back to the raw URL when the
    // provider sends no page title (packages/core/src/acp/reducer/
    // item-fold.ts's upsertSpecialEvent) — the same secret leak the URL param
    // itself is redacted against must not reach the composer band via title.
    const secret = 'super-secret-api-key-value';
    const store = new AcpChatStore('conversation-1', 'project-1', 'task-1');
    store.session = {
      sessionState: {
        current: () => ({
          pendingPermissions: [
            permissionRequest({
              toolCall: toolCall({
                kind: 'web-fetch-tool-call',
                title: `https://api.example.com/v1?api_key=${secret}`,
                url: `https://api.example.com/v1?api_key=${secret}`,
              }),
            }),
          ],
        }),
      },
    } as never;

    const item = store.permissionQueue[0];
    expect(item.title).not.toContain(secret);
    expect(item.title).toContain('[REDACTED');
  });

  it('resolves the current request through the session and reports resolving state', async () => {
    const store = new AcpChatStore('conversation-1', 'project-1', 'task-1');
    let resolvePending!: (value: { success: true; data: undefined }) => void;
    const resolvePermission = vi.fn(
      () =>
        new Promise((resolve) => {
          resolvePending = resolve;
        })
    );
    store.session = {
      sessionState: { current: () => ({ pendingPermissions: [permissionRequest()] }) },
      resolvePermission,
    } as never;

    store.resolvePermission('allow-once');

    expect(resolvePermission).toHaveBeenCalledWith('req-1', 'allow-once');
    expect(store.permissionResolution).toEqual({ status: 'resolving' });

    resolvePending({ success: true, data: undefined });
    await flushMicrotasks();

    expect(store.permissionResolution).toBeNull();
  });

  it('surfaces a retryable error and lets retryPermissionResolution re-attempt the same option', async () => {
    const store = new AcpChatStore('conversation-1', 'project-1', 'task-1');
    let call = 0;
    const resolvePermission = vi.fn(() => {
      call += 1;
      return Promise.resolve(
        call === 1
          ? { success: false, error: new Error('transport hiccup') }
          : { success: true, data: undefined }
      );
    });
    store.session = {
      sessionState: { current: () => ({ pendingPermissions: [permissionRequest()] }) },
      resolvePermission,
    } as never;

    store.resolvePermission('reject-once');
    await flushMicrotasks();

    expect(store.permissionResolution).toEqual({ status: 'error', message: 'transport hiccup' });

    store.retryPermissionResolution();
    await flushMicrotasks();

    expect(resolvePermission).toHaveBeenLastCalledWith('req-1', 'reject-once');
    expect(store.permissionResolution).toBeNull();
  });

  it('does not duplicate the decision when resolvePermission is called twice before the first settles', () => {
    const store = new AcpChatStore('conversation-1', 'project-1', 'task-1');
    const resolvePermission = vi.fn(() => new Promise(() => {}));
    store.session = {
      sessionState: { current: () => ({ pendingPermissions: [permissionRequest()] }) },
      resolvePermission,
    } as never;

    store.resolvePermission('allow-once');
    store.resolvePermission('allow-once');

    expect(resolvePermission).toHaveBeenCalledTimes(1);
  });
});

// ── AcpChatStore.changesFootprint — resynced alongside messageCount ─────────
//
// `_resolveWorkspace()` returns null in this harness (no task/workspace is
// registered), so these tests exercise the transcript-only path: a real
// workspace's Git status is covered by `acp-changes-footprint.test.ts`'s
// pure-function tests instead of re-mocking the whole workspace registry here.
describe('AcpChatStore.changesFootprint', () => {
  function modifyItem(id: string, seq: number, path: string): TranscriptItem {
    return {
      kind: 'modify-file-tool-call',
      id,
      seq,
      toolCallId: id,
      title: `Edit ${path}`,
      status: 'done',
      path,
      oldText: '',
      newText: '',
    };
  }

  it('reflects the transcript seeded at bootstrap', () => {
    const store = new AcpChatStore('conversation-1', 'project-1', 'task-1');
    const fakeChatState = store.chatState as unknown as FakeChatState;
    const turnWithEdit: TranscriptTurn = {
      ...makeTurn(1),
      items: [modifyItem('c1', 1, 'src/a.ts')],
    };
    fakeChatState.transcript.history.seed([turnWithEdit]);

    (store as unknown as { _syncChangesFootprint: () => void })._syncChangesFootprint();

    expect(store.changesFootprint.edited).toEqual([
      {
        kind: 'edited',
        path: 'src/a.ts',
        status: 'modified',
        additions: 0,
        deletions: 0,
        source: { turnId: 'turn-1', itemId: 'c1' },
      },
    ]);
    expect(store.changesFootprint.read).toEqual([]);
  });

  it('recomputes once an older page adds more edited files', async () => {
    const turnWithEdit: TranscriptTurn = {
      ...makeTurn(10),
      items: [modifyItem('c1', 1, 'src/a.ts')],
    };
    const { store, fakeChatState } = setUpStore([turnWithEdit], 10);
    (store as unknown as { _syncChangesFootprint: () => void })._syncChangesFootprint();
    expect(store.changesFootprint.edited.map((entry) => entry.path)).toEqual(['src/a.ts']);

    const olderTurn: TranscriptTurn = {
      ...makeTurn(9),
      items: [modifyItem('c2', 1, 'src/b.ts')],
    };
    store.session = {
      getHistory: vi.fn(async () => ({
        success: true,
        data: { turns: [olderTurn], nextCursor: null },
      })),
    } as never;

    store.bindView(null);
    void store.loadOlderHistory();
    await flushMicrotasks();

    expect(fakeChatState.transcript.history.get()).toEqual([olderTurn, turnWithEdit]);
    expect(store.changesFootprint.edited.map((entry) => entry.path)).toEqual([
      'src/a.ts',
      'src/b.ts',
    ]);
  });

  // Ticket #35's "interesting case": a file touched by several turns must
  // resolve to exactly one entry, whose provenance deterministically points
  // at the *latest* (by seq, not array/load order) occurrence — see
  // `buildChangesFootprint`'s "last wins" rule. Exercised here through the
  // store's real `loadOlderHistory` update path (an older page arriving
  // after the newer turn is already loaded), not just the pure function.
  it('keeps one entry with the latest provenance when an older page also touches an already-edited path', async () => {
    const newerTurn: TranscriptTurn = {
      ...makeTurn(10),
      items: [modifyItem('newer-edit', 1, 'src/a.ts')],
    };
    const { store } = setUpStore([newerTurn], 10);
    (store as unknown as { _syncChangesFootprint: () => void })._syncChangesFootprint();
    expect(store.changesFootprint.edited).toEqual([
      expect.objectContaining({
        path: 'src/a.ts',
        source: { turnId: 'turn-10', itemId: 'newer-edit' },
      }),
    ]);

    const olderTurn: TranscriptTurn = {
      ...makeTurn(9),
      items: [modifyItem('older-edit', 1, 'src/a.ts')],
    };
    store.session = {
      getHistory: vi.fn(async () => ({
        success: true,
        data: { turns: [olderTurn], nextCursor: null },
      })),
    } as never;

    store.bindView(null);
    void store.loadOlderHistory();
    await flushMicrotasks();

    // Still a single entry for src/a.ts — the older page's edit never
    // duplicates the file — and provenance still points at the newer turn's
    // item, never silently overwritten by array-order (the older page was
    // prepended, so a naive "last processed" rule would have picked it).
    expect(store.changesFootprint.edited).toHaveLength(1);
    expect(store.changesFootprint.edited[0]).toMatchObject({
      path: 'src/a.ts',
      source: { turnId: 'turn-10', itemId: 'newer-edit' },
    });
  });
});

// ── Changes rail provenance jump (ticket #35) ────────────────────────────────
//
// The Changes rail's "jump to provenance" action (acp-chat-panel.tsx's
// handleSelectChangesEntry) calls `store.scrollToTranscriptItem` directly
// with a footprint entry's `source.itemId` — the same generic, reusable seam
// `scrollToOutlineEntry` uses (see the describe block above). This closes the
// loop for this ticket's specific consumer: a provenance target that belongs
// to a turn not yet paginated into `chatState` must still page in and land
// correctly, not silently no-op.
describe('AcpChatStore.scrollToTranscriptItem — Changes rail provenance target', () => {
  it('pages in older history to reach a Changes entry provenance item not yet loaded', async () => {
    const { store, fakeChatState } = setUpStore([makeTurn(10), makeTurn(11)], 10);
    const olderTurn: TranscriptTurn = {
      ...makeTurn(9),
      items: [
        {
          kind: 'modify-file-tool-call',
          id: 'edit-item',
          seq: 1,
          toolCallId: 'edit-item',
          title: 'Edit src/a.ts',
          status: 'done',
          path: 'src/a.ts',
          oldText: '',
          newText: '',
        },
      ],
    };
    const getHistory = vi.fn(async () => ({
      success: true,
      data: { turns: [olderTurn], nextCursor: null },
    }));
    store.session = { getHistory } as never;

    const scrollToItem = vi.fn();
    const loadOlder = vi.fn((turns: TranscriptTurn[]) => {
      fakeChatState.transcript.history.prepend(turns);
    });
    store.bindView({ loadOlder, scrollToItem } as never);

    // A Changes footprint entry for src/a.ts whose provenance is the tool
    // call above — as if computed before this page was ever loaded.
    const provenanceItemId = 'edit-item';

    await store.scrollToTranscriptItem(provenanceItemId, { align: 'start' });

    expect(getHistory).toHaveBeenCalledTimes(1);
    expect(scrollToItem).toHaveBeenCalledWith(provenanceItemId, { align: 'start' });
    expect(fakeChatState.transcript.history.get().map((t) => t.id)).toEqual([
      'turn-9',
      'turn-10',
      'turn-11',
    ]);
  });
});

// ── AcpChatStore reading position — ticket #37 ───────────────────────────────
//
// `connectSession` is mocked as a no-op in this file (see the top-of-file
// comment), so these tests exercise the wiring directly: `setAtBottom` (the
// `onAtBottomChange` seam), `visitNewestEvent`/`returnToReadingPosition` (the
// scroll-mode save/restore round trip), and `newEventCount` (recomputed via
// the private `_syncNewEventCount`, called automatically by `setAtBottom` and
// exposed here for tests that grow the transcript directly). The turn-
// identity counting math itself is unit-tested in chat-ui's own
// `state/reading-position.test.ts` — this file's mock of `captureReadWatermark`/
// `countNewTranscriptEvents` mirrors that real logic (see the `vi.mock` above).
describe('AcpChatStore reading position', () => {
  function syncNewEventCount(store: AcpChatStore): void {
    (store as unknown as { _syncNewEventCount: () => void })._syncNewEventCount();
  }

  it('stays at zero while following the tail, even as the transcript grows', () => {
    const { store, fakeChatState } = setUpStore([makeTurn(1)], null);
    expect(store.newEventCount).toBe(0);
    fakeChatState.transcript.history.append([makeTurn(2)]);
    syncNewEventCount(store);
    expect(store.newEventCount).toBe(0);
  });

  it('counts turns appended after leaving tail mode, without duplicating on repeated false calls', () => {
    const { store, fakeChatState } = setUpStore([makeTurn(1)], null);

    store.setAtBottom(false);
    expect(store.newEventCount).toBe(0);

    fakeChatState.transcript.history.append([makeTurn(2)]);
    syncNewEventCount(store);
    expect(store.newEventCount).toBe(1);

    // A repeated "still not at bottom" report must not slide the baseline
    // forward and hide the turn already counted as new.
    store.setAtBottom(false);
    expect(store.newEventCount).toBe(1);

    fakeChatState.transcript.history.append([makeTurn(3)]);
    syncNewEventCount(store);
    expect(store.newEventCount).toBe(2);
  });

  it('clears the count once the view reports it is back at the tail', () => {
    const { store, fakeChatState } = setUpStore([makeTurn(1)], null);
    store.setAtBottom(false);
    fakeChatState.transcript.history.append([makeTurn(2)]);
    syncNewEventCount(store);
    expect(store.newEventCount).toBe(1);

    store.setAtBottom(true);
    expect(store.newEventCount).toBe(0);

    // Leaving tail again establishes a fresh baseline — already-seen content
    // is not "new" a second time.
    store.setAtBottom(false);
    expect(store.newEventCount).toBe(0);
  });

  it('visitNewestEvent saves the exact scroll intent and returnToReadingPosition restores it', () => {
    const { store, fakeChatState } = setUpStore([makeTurn(1)], null);
    const anchor = { kind: 'anchor', itemId: 'msg-1', edge: 'top', offset: 42 };
    fakeChatState.scroll.set(anchor);
    store.setAtBottom(false);
    fakeChatState.transcript.history.append([makeTurn(2)]);
    syncNewEventCount(store);
    expect(store.newEventCount).toBe(1);

    const scrollToBottom = vi.fn();
    const setScrollMode = vi.fn();
    store.bindView({ scrollToBottom, setScrollMode } as never);

    expect(store.canReturnToReadingPosition).toBe(false);
    store.visitNewestEvent();

    expect(scrollToBottom).toHaveBeenCalledWith({ behavior: 'smooth' });
    expect(store.canReturnToReadingPosition).toBe(true);
    // Visiting the newest event clears the badge immediately rather than
    // waiting for the async onAtBottomChange callback the scroll triggers.
    expect(store.newEventCount).toBe(0);

    store.returnToReadingPosition();
    expect(setScrollMode).toHaveBeenCalledExactlyOnceWith(anchor);
    expect(store.canReturnToReadingPosition).toBe(false);

    // Consumed: a second call is a no-op.
    store.returnToReadingPosition();
    expect(setScrollMode).toHaveBeenCalledTimes(1);
  });

  it('visitNewestEvent is a no-op for the return anchor when already at the tail', () => {
    const { store, fakeChatState } = setUpStore([makeTurn(1)], null);
    fakeChatState.scroll.set({ kind: 'tail' });

    const scrollToBottom = vi.fn();
    store.bindView({ scrollToBottom } as never);
    store.visitNewestEvent();

    expect(store.canReturnToReadingPosition).toBe(false);
  });

  it('keeps counting new events if the smooth jump is interrupted before the view ever reports reaching the tail', () => {
    // `ChatRoot.onAtBottomChange` only fires on a genuine true/false
    // transition. If the user scrolls away again mid-animation before the
    // smooth `scrollToBottom` gets close enough to the tail to ever report
    // `true`, no transition fires at all — `setAtBottom` is never called
    // again to re-arm a baseline. A watermark nulled out by `visitNewestEvent`
    // would then never come back, silently disabling new-event tracking for
    // the rest of the session (see acp-chat-store.ts's `visitNewestEvent`
    // doc comment). This simulates exactly that: `visitNewestEvent` runs, but
    // no subsequent `setAtBottom` call ever follows it.
    const { store, fakeChatState } = setUpStore([makeTurn(1)], null);
    fakeChatState.scroll.set({ kind: 'anchor', itemId: 'msg-1', edge: 'top', offset: 10 });
    store.setAtBottom(false);
    fakeChatState.transcript.history.append([makeTurn(2)]);
    syncNewEventCount(store);
    expect(store.newEventCount).toBe(1);

    store.bindView({ scrollToBottom: vi.fn(), setScrollMode: vi.fn() } as never);
    store.visitNewestEvent();
    expect(store.newEventCount).toBe(0);

    // A further turn commits while the (interrupted) animation is still
    // "in flight" — it must still be counted, not silently dropped.
    fakeChatState.transcript.history.append([makeTurn(3)]);
    syncNewEventCount(store);
    expect(store.newEventCount).toBe(1);
  });

  it('_resetReadingPosition (called on a fresh bootstrap seed) clears the watermark, return anchor, and count', () => {
    const { store, fakeChatState } = setUpStore([makeTurn(1)], null);
    fakeChatState.scroll.set({ kind: 'anchor', itemId: 'msg-1', edge: 'top', offset: 0 });
    store.setAtBottom(false);
    fakeChatState.transcript.history.append([makeTurn(2)]);
    syncNewEventCount(store);
    expect(store.newEventCount).toBe(1);

    store.bindView({ scrollToBottom: vi.fn(), setScrollMode: vi.fn() } as never);
    store.visitNewestEvent();
    expect(store.canReturnToReadingPosition).toBe(true);

    (store as unknown as { _resetReadingPosition: () => void })._resetReadingPosition();

    expect(store.newEventCount).toBe(0);
    expect(store.canReturnToReadingPosition).toBe(false);
    // A prior baseline must not resurface once the transcript is reseeded:
    // leaving tail mode again establishes a fresh baseline at whatever the
    // (new) transcript looks like now, not the old one.
    store.setAtBottom(false);
    expect(store.newEventCount).toBe(0);
  });
});

// ── AcpChatStore.attentionQueue — ticket #33 ─────────────────────────────────
//
// `attentionQueue` is an explicitly-resynced field (see its doc comment), so
// — mirroring `changesFootprint`/`outline`/`newEventCount`'s own tests —
// these tests call `_syncAttentionQueue()` directly after mutating the
// fixtures it reads from, rather than exercising the real event subscriptions
// in `_subscribeLiveSession` (untested elsewhere in this file for the same
// reason: the wiring is straightforward glue, the interesting behavior is in
// what gets recomputed).
describe('AcpChatStore.attentionQueue', () => {
  function syncAttentionQueue(store: AcpChatStore): void {
    (store as unknown as { _syncAttentionQueue(): void })._syncAttentionQueue();
  }

  function permissionRequest(requestId: string, itemId: string, title = 'Execute a Shell Command') {
    return {
      requestId,
      toolCall: {
        id: itemId,
        seq: 0,
        toolCallId: `call-${itemId}`,
        title,
        status: 'pending',
        kind: 'execute-tool-call',
        command: 'ls',
      },
      options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
    };
  }

  function seedFailedSubmission(store: AcpChatStore, localId: string): void {
    (
      store as unknown as { _submissions: { failedSubmissions: Record<string, unknown>[] } }
    )._submissions.failedSubmissions = [
      { localId, kind: 'direct', text: 'hi', attachments: [], error: 'boom' },
    ];
  }

  it('combines a simultaneous permission, failed submission, and turn error in deterministic priority order', () => {
    const erroredTurn: TranscriptTurn = {
      id: 'turn-err',
      seq: 1,
      initiator: 'agent',
      items: [{ kind: 'message', id: 'msg-err', seq: 0, role: 'assistant', text: 'oops' }],
      outcome: { kind: 'error' },
    };
    const { store } = setUpStore([erroredTurn], null);
    store.session = {
      sessionState: {
        current: () => ({ pendingPermissions: [permissionRequest('req-1', 'perm-item')] }),
      },
    } as never;
    seedFailedSubmission(store, 'sub-1');

    syncAttentionQueue(store);

    expect(store.attentionQueue.map((item) => item.kind)).toEqual([
      'permission',
      'failed-submission',
      'error',
    ]);
    expect(store.attentionQueue.map((item) => item.id)).toEqual([
      'permission:req-1',
      'failed-submission:sub-1',
      'error:turn:turn-err',
    ]);
  });

  // ── Permission exits ────────────────────────────────────────────────────────

  it('drops a permission the moment it is resolved (no longer listed in pendingPermissions)', () => {
    const pending: unknown[] = [permissionRequest('req-1', 'perm-item')];
    const { store } = setUpStore([], null);
    store.session = { sessionState: { current: () => ({ pendingPermissions: pending }) } } as never;
    syncAttentionQueue(store);
    expect(store.attentionQueue.map((i) => i.id)).toEqual(['permission:req-1']);

    pending.length = 0; // the runtime settled the request
    syncAttentionQueue(store);

    expect(store.attentionQueue).toEqual([]);
  });

  it('drops a permission the agent cancels outright, without any resolvePermission call, while a sibling request stays queued', () => {
    const pending: unknown[] = [
      permissionRequest('req-1', 'perm-1'),
      permissionRequest('req-2', 'perm-2'),
    ];
    const { store } = setUpStore([], null);
    store.session = { sessionState: { current: () => ({ pendingPermissions: pending }) } } as never;
    syncAttentionQueue(store);
    expect(store.attentionQueue.map((i) => i.id)).toEqual(['permission:req-1', 'permission:req-2']);

    pending.splice(0, 1); // agent cancelled req-1, never resolved by the user
    syncAttentionQueue(store);

    expect(store.attentionQueue.map((i) => i.id)).toEqual(['permission:req-2']);
  });

  it('drops a superseded permission and adopts its replacement, never keeping both', () => {
    const pending: unknown[] = [permissionRequest('req-1', 'perm-item')];
    const { store } = setUpStore([], null);
    store.session = { sessionState: { current: () => ({ pendingPermissions: pending }) } } as never;
    syncAttentionQueue(store);
    expect(store.attentionQueue.map((i) => i.id)).toEqual(['permission:req-1']);

    pending[0] = permissionRequest('req-2', 'perm-item-2');
    syncAttentionQueue(store);

    expect(store.attentionQueue.map((i) => i.id)).toEqual(['permission:req-2']);
  });

  it('keeps reflecting new pendingPermissions even while `permissionQueue` is kept "hot" by an observer elsewhere', () => {
    // Regression guard: `permissionQueue` is a `computed` whose only tracked
    // MobX dependency is `session` (an `observable.ref`) — the
    // `pendingPermissions` data itself lives in a plain, non-MobX replicated
    // store. If `_syncAttentionQueue` read `permissionQueue` while it is kept
    // continuously observed (exactly what the composer's `observer()` render
    // does in production), MobX would return its cached first evaluation
    // forever instead of the current data — see `_computePermissionQueue`'s
    // doc. This proves `_syncAttentionQueue` reads fresh data directly
    // instead, so it can never inherit that staleness.
    const pending: unknown[] = [];
    const { store } = setUpStore([], null);
    store.session = { sessionState: { current: () => ({ pendingPermissions: pending }) } } as never;

    const stop = autorun(() => {
      void store.permissionQueue.length;
    });

    pending.push(permissionRequest('req-1', 'perm-item'));
    syncAttentionQueue(store);

    expect(store.attentionQueue.map((i) => i.id)).toEqual(['permission:req-1']);
    stop();
  });

  // ── Failed-submission exits ──────────────────────────────────────────────────

  it('discardFailedSubmission removes the item from the queue', () => {
    const { store } = setUpStore([], null);
    seedFailedSubmission(store, 'sub-1');
    syncAttentionQueue(store);
    expect(store.attentionQueue.map((i) => i.id)).toEqual(['failed-submission:sub-1']);

    store.discardFailedSubmission('sub-1');

    expect(store.attentionQueue).toEqual([]);
  });

  it('editFailedSubmission removes the item from the queue and hands back its snapshot', () => {
    const { store } = setUpStore([], null);
    seedFailedSubmission(store, 'sub-1');
    syncAttentionQueue(store);

    const snapshot = store.editFailedSubmission('sub-1');

    expect(snapshot?.localId).toBe('sub-1');
    expect(store.attentionQueue).toEqual([]);
  });

  it('retryFailedSubmission removes the item once the resend succeeds', async () => {
    const { store } = setUpStore([], null);
    seedFailedSubmission(store, 'sub-1');
    syncAttentionQueue(store);
    expect(store.attentionQueue.map((i) => i.id)).toEqual(['failed-submission:sub-1']);

    store.session = {
      sessionState: {
        current: () => ({
          pendingPermissions: [],
          isGenerating: false,
          canSubmit: true,
          canCancel: false,
        }),
      },
      sendPrompt: vi.fn(async () => ({ success: true, data: { queued: false } })),
    } as never;

    store.retryFailedSubmission('sub-1');
    await Promise.resolve();
    await Promise.resolve();

    expect(store.attentionQueue).toEqual([]);
  });

  // ── Turn/tool error scoping — "the latest activity" ──────────────────────────

  it('reflects a newly committed turn’s error outcome once resynced', () => {
    const { store, fakeChatState } = setUpStore([makeTurn(1)], null);
    syncAttentionQueue(store);
    expect(store.attentionQueue).toEqual([]);

    const erroredTurn: TranscriptTurn = {
      id: 'turn-2',
      seq: 2,
      initiator: 'agent',
      items: [{ kind: 'message', id: 'msg-2', seq: 0, role: 'assistant', text: 'oops' }],
      outcome: { kind: 'error' },
    };
    fakeChatState.transcript.history.append([erroredTurn]);
    syncAttentionQueue(store);

    expect(store.attentionQueue.map((i) => i.id)).toEqual(['error:turn:turn-2']);
  });

  it('drops a committed turn’s error once a further turn supersedes it as the latest activity', () => {
    const erroredTurn: TranscriptTurn = {
      id: 'turn-2',
      seq: 2,
      initiator: 'agent',
      items: [{ kind: 'message', id: 'msg-2', seq: 0, role: 'assistant', text: 'oops' }],
      outcome: { kind: 'error' },
    };
    const { store, fakeChatState } = setUpStore([makeTurn(1), erroredTurn], null);
    syncAttentionQueue(store);
    expect(store.attentionQueue.map((i) => i.id)).toEqual(['error:turn:turn-2']);

    fakeChatState.transcript.history.append([makeTurn(3)]);
    syncAttentionQueue(store);

    expect(store.attentionQueue).toEqual([]);
  });

  it('never moves the viewport while resyncing, even when the queue changes', () => {
    const { store, fakeChatState } = setUpStore([makeTurn(1)], null);
    const scrollToItem = vi.fn();
    const scrollToBottom = vi.fn();
    const setScrollMode = vi.fn();
    store.bindView({ scrollToItem, scrollToBottom, setScrollMode } as never);

    const erroredTurn: TranscriptTurn = {
      id: 'turn-2',
      seq: 2,
      initiator: 'agent',
      items: [{ kind: 'message', id: 'msg-2', seq: 0, role: 'assistant', text: 'oops' }],
      outcome: { kind: 'error' },
    };
    fakeChatState.transcript.history.append([erroredTurn]);
    syncAttentionQueue(store);

    expect(store.attentionQueue).not.toEqual([]);
    expect(scrollToItem).not.toHaveBeenCalled();
    expect(scrollToBottom).not.toHaveBeenCalled();
    expect(setScrollMode).not.toHaveBeenCalled();
  });

  // ── Different resolution orders ──────────────────────────────────────────────

  it('resolves two simultaneous items correctly regardless of which one is handled first', () => {
    // Order A: the permission is resolved before the failed submission is discarded.
    const pendingA: unknown[] = [permissionRequest('req-1', 'perm-item')];
    const { store: storeA } = setUpStore([], null);
    storeA.session = {
      sessionState: { current: () => ({ pendingPermissions: pendingA }) },
    } as never;
    seedFailedSubmission(storeA, 'sub-1');
    syncAttentionQueue(storeA);
    expect(storeA.attentionQueue.map((i) => i.id)).toEqual([
      'permission:req-1',
      'failed-submission:sub-1',
    ]);

    pendingA.length = 0;
    syncAttentionQueue(storeA);
    expect(storeA.attentionQueue.map((i) => i.id)).toEqual(['failed-submission:sub-1']);
    storeA.discardFailedSubmission('sub-1');
    expect(storeA.attentionQueue).toEqual([]);

    // Order B: the same two items, resolved in the opposite order — the
    // failed submission first, then the permission.
    const pendingB: unknown[] = [permissionRequest('req-1', 'perm-item')];
    const { store: storeB } = setUpStore([], null);
    storeB.session = {
      sessionState: { current: () => ({ pendingPermissions: pendingB }) },
    } as never;
    seedFailedSubmission(storeB, 'sub-1');
    syncAttentionQueue(storeB);
    expect(storeB.attentionQueue.map((i) => i.id)).toEqual([
      'permission:req-1',
      'failed-submission:sub-1',
    ]);

    storeB.discardFailedSubmission('sub-1');
    expect(storeB.attentionQueue.map((i) => i.id)).toEqual(['permission:req-1']);
    pendingB.length = 0;
    syncAttentionQueue(storeB);
    expect(storeB.attentionQueue).toEqual([]);
  });
});

// ── AcpChatStore attention-queue traversal ───────────────────────────────────

describe('AcpChatStore attention traversal', () => {
  function syncAttentionQueue(store: AcpChatStore): void {
    (store as unknown as { _syncAttentionQueue(): void })._syncAttentionQueue();
  }

  function permissionRequest(requestId: string, itemId: string) {
    return {
      requestId,
      toolCall: {
        id: itemId,
        seq: 0,
        toolCallId: `call-${itemId}`,
        title: 'Execute a Shell Command',
        status: 'pending',
        kind: 'execute-tool-call',
        command: 'ls',
      },
      options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }],
    };
  }

  it('attentionFocusedItem defaults to the front (highest priority) item', () => {
    const { store } = setUpStore([], null);
    store.session = {
      sessionState: {
        current: () => ({
          pendingPermissions: [permissionRequest('req-1', 'a'), permissionRequest('req-2', 'b')],
        }),
      },
    } as never;
    syncAttentionQueue(store);

    expect(store.attentionFocusedItem?.id).toBe('permission:req-1');
  });

  it('focusNextAttentionItem/focusPreviousAttentionItem cycle through the queue and wrap at both ends', () => {
    const { store } = setUpStore([], null);
    store.session = {
      sessionState: {
        current: () => ({
          pendingPermissions: [permissionRequest('req-1', 'a'), permissionRequest('req-2', 'b')],
        }),
      },
    } as never;
    syncAttentionQueue(store);

    store.focusNextAttentionItem();
    expect(store.attentionFocusedItem?.id).toBe('permission:req-2');

    store.focusNextAttentionItem();
    expect(store.attentionFocusedItem?.id).toBe('permission:req-1');

    store.focusPreviousAttentionItem();
    expect(store.attentionFocusedItem?.id).toBe('permission:req-2');
  });

  it('resets focus to the new front item once the focused item leaves the queue', () => {
    const pending: unknown[] = [permissionRequest('req-1', 'a'), permissionRequest('req-2', 'b')];
    const { store } = setUpStore([], null);
    store.session = { sessionState: { current: () => ({ pendingPermissions: pending }) } } as never;
    syncAttentionQueue(store);
    store.focusNextAttentionItem();
    expect(store.attentionFocusedItem?.id).toBe('permission:req-2');

    pending.splice(1, 1); // req-2 resolved
    syncAttentionQueue(store);

    expect(store.attentionFocusedItem?.id).toBe('permission:req-1');
  });

  it('keeps traversal focus on the same item across an unrelated resync', () => {
    const pending: unknown[] = [permissionRequest('req-1', 'a'), permissionRequest('req-2', 'b')];
    const { store } = setUpStore([], null);
    store.session = { sessionState: { current: () => ({ pendingPermissions: pending }) } } as never;
    syncAttentionQueue(store);
    store.focusNextAttentionItem();
    expect(store.attentionFocusedItem?.id).toBe('permission:req-2');

    (
      store as unknown as { _submissions: { failedSubmissions: Record<string, unknown>[] } }
    )._submissions.failedSubmissions = [
      { localId: 'sub-1', kind: 'direct', text: 'hi', attachments: [], error: 'boom' },
    ];
    syncAttentionQueue(store);

    expect(store.attentionFocusedItem?.id).toBe('permission:req-2');
  });

  it('attentionFocusedItem is null when the queue is empty', () => {
    const { store } = setUpStore([], null);
    syncAttentionQueue(store);
    expect(store.attentionFocusedItem).toBeNull();
  });
});

class FakeLiveList<T> {
  private listeners = new Set<() => void>();

  constructor(private value: T) {}

  current(): T {
    return this.value;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  set(value: T): void {
    this.value = value;
    for (const listener of this.listeners) listener();
  }
}

class FakeLog {
  private listeners = new Set<() => void>();

  constructor(private value: string) {}

  text(): string {
    return this.value;
  }

  onAppend(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  set(value: string): void {
    this.value = value;
    for (const listener of this.listeners) listener();
  }
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
}

describe('bindSessionTerminalOutputs', () => {
  it('mirrors terminal log text and clears it on terminal removal', async () => {
    const terminals = new FakeLiveList([{ terminalId: 'term-1' }]);
    const log = new FakeLog('initial output');
    const terminalOutput = vi.fn(async () => log);
    const outputs = new Map<string, string | null>();

    const dispose = bindSessionTerminalOutputs({ terminals, terminalOutput }, (terminalId, text) =>
      outputs.set(terminalId, text)
    );
    await flushPromises();

    expect(terminalOutput).toHaveBeenCalledWith('term-1');
    expect(outputs.get('term-1')).toBe('initial output');

    log.set('live output');
    expect(outputs.get('term-1')).toBe('live output');

    terminals.set([]);
    expect(outputs.get('term-1')).toBeNull();

    log.set('late output');
    expect(outputs.get('term-1')).toBeNull();

    dispose();
  });

  it('clears mirrored outputs when disposed', async () => {
    const terminals = new FakeLiveList([{ terminalId: 'term-1' }]);
    const log = new FakeLog('initial output');
    const outputs = new Map<string, string | null>();

    const dispose = bindSessionTerminalOutputs(
      { terminals, terminalOutput: async () => log },
      (terminalId, text) => outputs.set(terminalId, text)
    );
    await flushPromises();

    dispose();
    expect(outputs.get('term-1')).toBeNull();

    log.set('late output');
    expect(outputs.get('term-1')).toBeNull();
  });
});
