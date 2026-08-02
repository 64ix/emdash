import type { TranscriptItem, TranscriptTurn } from '@emdash/core/acp/client';
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
  return {
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

    store.loadOlderHistory();
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
    store.loadOlderHistory();
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
    store.loadOlderHistory();
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
    store.loadOlderHistory();
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
    store.loadOlderHistory();
    await flushMicrotasks();

    expect(fakeChatState.transcript.history.get()).toEqual([olderTurn, turnWithEdit]);
    expect(store.changesFootprint.edited.map((entry) => entry.path)).toEqual([
      'src/a.ts',
      'src/b.ts',
    ]);
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
