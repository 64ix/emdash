import type { ILifecycle } from '@emdash/shared';
import { computed, makeAutoObservable, observable, reaction, runInAction } from 'mobx';
import { ChangesRailViewStore } from '@renderer/features/conversations/acp/changes/changes-rail-store';
import { conversationTabKind } from '@renderer/features/conversations/conversation-tab-kind';
import { DefaultConversationSeeder } from '@renderer/features/conversations/default-conversation-seeder';
import { conversationRegistry } from '@renderer/features/conversations/stores/conversation-registry';
import type { TaskTabContext } from '@renderer/features/tabs/core/task-tab-context';
import { getDiffTabManager } from '@renderer/features/tasks/diff-view/stores/diff-tab-manager';
import { DiffViewStore } from '@renderer/features/tasks/diff-view/stores/diff-view-store';
import { EditorViewStore } from '@renderer/features/tasks/editor/stores/editor-view-store';
import type { FileTabResource } from '@renderer/features/tasks/editor/stores/file-tab-resource';
import { PreviewServerStore } from '@renderer/features/tasks/stores/preview-server-store';
import { TerminalTabViewStore } from '@renderer/features/tasks/terminals/terminal-tab-view-store';
import { type SidebarTab } from '@renderer/features/tasks/types';
import { appState } from '@renderer/lib/stores/app-state';
import { snapshotRegistry } from '@renderer/lib/stores/snapshot-registry';
import { focusTracker } from '@renderer/utils/focus-tracker';
import { log } from '@renderer/utils/logger';
import type { Task } from '@shared/core/tasks/tasks';
import type { TerminalShellId } from '@shared/core/terminals/terminal-settings';
import type {
  DiffViewSnapshot,
  TaskViewSnapshot,
  TerminalDrawerActiveItem,
} from '@shared/view-state';
import { taskTabView } from '../task-tab-registry';
import { PrStore } from './pr-store';
import type { TaskStore } from './task-store';
import { terminalRegistry } from './terminal-registry';
import { resolveWorkspacePath } from './workspace-path';
import { workspaceRegistry } from './workspace-registry';

export type RendererKind =
  | 'monaco'
  | 'markdown'
  | 'diff'
  | 'agents'
  | 'browser'
  | 'terminal'
  | 'other-file';

export class WorkspaceViewModel implements ILifecycle {
  sidebarTab: SidebarTab;
  isSidebarCollapsed: boolean;
  focusedRegion: 'main' | 'bottom';
  isTerminalDrawerOpen: boolean;
  terminalDrawerActiveItem: TerminalDrawerActiveItem | undefined;

  /** Stable sub-stores — live for the full WorkspaceViewModel lifetime. */
  readonly paneLayout: ReturnType<typeof taskTabView.createPaneLayoutStore>;
  readonly terminalTabs: TerminalTabViewStore;
  readonly editorView: EditorViewStore;
  readonly changesRail: ChangesRailViewStore;

  /**
   * Returns the focused pane's PaneStore.
   * Callers outside the split-pane render tree use this to access tab state
   * without needing to know about multiple panes.
   */
  get activePane(): ReturnType<typeof taskTabView.createPaneLayoutStore>['focusedPane'] {
    return this.paneLayout.focusedPane;
  }

  /**
   * Session-scoped: created in initialize() with live workspace git/pr references,
   * disposed and set to null in suspend().
   */
  diffView: DiffViewStore | null = null;
  prStore: PrStore | null = null;
  previewServers: PreviewServerStore | null = null;

  /** Permanent reactions (live as long as the view model). */
  private readonly _disposers: (() => void)[] = [];
  /** Session reactions (created in initialize, disposed in suspend). */
  private _sessionDisposers: (() => void)[] = [];

  private _snapshotDisposer: (() => void) | null = null;
  /** Saved whenever suspend() is called, restored in next initialize(). */
  private _savedDiffViewSnapshot: DiffViewSnapshot | undefined;
  private _isCreatingTerminal = false;

  private readonly _seeder: DefaultConversationSeeder;

  readonly taskId: string;

  constructor(private readonly _taskStore: TaskStore) {
    const taskData = _taskStore.data as Task;
    this.taskId = taskData.id;

    // UI state defaults — overridden by restoreSnapshot when called
    this.sidebarTab = 'conversations';
    this.isSidebarCollapsed = true;
    this.focusedRegion = 'main';
    this.isTerminalDrawerOpen = false;
    this.terminalDrawerActiveItem = undefined;

    const workspaceId = taskData.workspaceId ?? taskData.id;
    const projectId = taskData.projectId;

    const taskCtx: TaskTabContext = {
      viewId: this.taskId,
      projectId,
      workspaceId,
      taskId: this.taskId,
      get workspacePath(): string | undefined {
        return workspaceRegistry.get(projectId, workspaceId)?.path;
      },
      modelRootPath: `workspace:${workspaceId}`,
      getRemoteConnectionId: () => this._workspace?.sshConnectionId,
    };
    this.paneLayout = taskTabView.createPaneLayoutStore(taskCtx, {
      onActiveTabChange: (tabId) => {
        if (!tabId) return;
        appState.history.push({
          kind: 'tab',
          projectId: taskData.projectId,
          taskId: this.taskId,
          tabId,
        });
      },
    });
    this._seeder = new DefaultConversationSeeder(this.taskId, this.paneLayout);
    this.terminalTabs = new TerminalTabViewStore(() => terminalRegistry.get(this.taskId) ?? null);
    this.editorView = new EditorViewStore(this.paneLayout, taskData.projectId, workspaceId);
    this.changesRail = new ChangesRailViewStore();

    makeAutoObservable(this, {
      paneLayout: false,
      terminalTabs: false,
      editorView: false,
      changesRail: false,
      diffView: observable.ref,
      activeRenderer: computed,
    });

    // Tell the engine whether this task is the active route so panes can
    // fire onActivate() correctly when the view becomes visible.
    this._disposers.push(
      reaction(
        () =>
          appState.navigation.currentViewId === 'task' &&
          (appState.navigation.viewParamsStore['task'] as { taskId?: string } | undefined)
            ?.taskId === this.taskId,
        (isActive) => this.paneLayout.setViewActive(isActive),
        { fireImmediately: true }
      )
    );
  }

  private get _workspace() {
    const workspaceId = this._taskStore.workspaceId;
    if (!workspaceId) return null;
    const projectId = (this._taskStore.data as Task).projectId;
    return workspaceRegistry.get(projectId, workspaceId) ?? null;
  }

  // -------------------------------------------------------------------------
  // Computed
  // -------------------------------------------------------------------------

  get activeRenderer(): RendererKind {
    const desc = this.activePane.activeEntry;
    if (desc?.kind === 'diff') return 'diff';
    if (desc?.kind === 'browser') return 'browser';
    if (desc?.kind === 'terminal') return 'terminal';
    const resource = this.activePane.activeResourceOfKind<FileTabResource>('file');
    if (!resource) return 'agents';
    if (resource.contentType === 'markdown' && resource.viewMode === 'preview') return 'markdown';
    if (resource.contentType === 'text' || resource.viewMode === 'source') return 'monaco';
    return 'other-file';
  }

  get snapshot(): TaskViewSnapshot {
    return {
      sidebarTab: this.sidebarTab,
      isSidebarCollapsed: this.isSidebarCollapsed,
      focusedRegion: this.focusedRegion,
      isTerminalDrawerOpen: this.isTerminalDrawerOpen,
      terminalDrawerActiveItem: this.terminalDrawerActiveItem,
      terminals: this.terminalTabs.snapshot,
      editor: this.editorView.snapshot,
      diffView: this.diffView?.snapshot ?? this._savedDiffViewSnapshot,
      changesRail: this.changesRail.snapshot,
    };
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Restore persisted UI state from a saved snapshot. Call this before
   * initialize() so the reaction baseline is correct.
   *
   * The snapshot may be partial, absent, or null: tab state lives in the
   * dedicated `task:${id}:tabs` view-state key (read by the pane-layout
   * persistor), so the aggregate key — which is only written when
   * sidebar/editor/terminal state changes — can legitimately be missing
   * while tabs are persisted. `null` is what `viewStateCache.get` actually
   * returns for a missing key (the `= {}` default only covers `undefined`),
   * so it is normalized here rather than at every call site.
   */
  restoreSnapshot(savedSnapshot: Partial<TaskViewSnapshot> | null = {}): void {
    const snapshot = savedSnapshot ?? {};
    this.sidebarTab = (snapshot.sidebarTab as SidebarTab | undefined) ?? 'conversations';
    this.isSidebarCollapsed = snapshot.isSidebarCollapsed ?? true;
    this.focusedRegion = snapshot.focusedRegion === 'bottom' ? 'bottom' : 'main';
    this.isTerminalDrawerOpen = snapshot.isTerminalDrawerOpen ?? false;
    this.terminalDrawerActiveItem = snapshot.terminalDrawerActiveItem;

    // Pass the aggregate blob as fallback so the persistor can migrate legacy
    // tabGroups/tabManager/conversations fields when no dedicated key exists yet.
    this._seeder.markConsumed(this.paneLayout.hydrate(snapshot));

    if (snapshot.terminals) {
      this.terminalTabs.restoreSnapshot(snapshot.terminals);
    }
    if (snapshot.editor) {
      this.editorView.restoreSnapshot(snapshot.editor);
    }
    if (snapshot.diffView) {
      this._savedDiffViewSnapshot = snapshot.diffView;
    }
    if (snapshot.changesRail) {
      this.changesRail.restoreSnapshot(snapshot.changesRail);
    }
  }

  /**
   * Called when the task becomes provisioned. Creates session-scoped stores
   * (DiffViewStore, DiffTabLifecycleStore) and starts session-dependent reactions.
   */
  initialize(): void {
    if (this._snapshotDisposer) return; // already active

    const workspace = this._workspace;
    if (!workspace) return; // defensive — should always have workspace when provisioned

    const taskData = this._taskStore.data as Task;
    const workspaceId = this._taskStore.workspaceId!;
    this.previewServers = new PreviewServerStore({
      projectId: taskData.projectId,
      workspaceId,
      connectionId: workspace.sshConnectionId,
    });
    this.previewServers.start();
    this.prStore = new PrStore(
      taskData.projectId,
      workspaceId,
      workspace.gitRepository,
      this._taskStore
    );

    // Create DiffViewStore with live git/pr references from the workspace.
    this.diffView = new DiffViewStore(workspace.gitWorktree, this.prStore);
    if (this._savedDiffViewSnapshot) {
      this.diffView.restoreSnapshot(
        normalizeDiffSnapshotPaths(this._savedDiffViewSnapshot, workspace.path)
      );
    }

    getDiffTabManager(workspaceId).bindSession({
      gitWorktree: workspace.gitWorktree,
      pr: this.prStore,
      diffView: this.diffView,
    });

    // Register snapshot with the persistence layer.
    this._snapshotDisposer = snapshotRegistry.register(`task:${this.taskId}`, () => this.snapshot);
    this.paneLayout.startPersistence();

    // Open the default conversation tab only for fresh task views. If tab state was
    // restored, even an empty tab list represents the user's persisted choice.
    // This handles the optimistic-conversation case where conversations are already in
    // the manager before provision completes.
    this._seeder.seed();

    const closeEmptyTerminalDrawerDisposer = reaction(
      () => {
        const terminals = terminalRegistry.get(this.taskId);
        return {
          isDrawerOpen: this.isTerminalDrawerOpen,
          isCreatingTerminal: this._isCreatingTerminal,
          isLoaded: terminals?.isLoaded ?? false,
          terminalCount: terminals?.terminals.size ?? 0,
        };
      },
      (state, previous) => {
        if (
          state.isDrawerOpen &&
          !state.isCreatingTerminal &&
          state.isLoaded &&
          state.terminalCount === 0 &&
          (previous === undefined || previous.terminalCount > 0 || !previous.isLoaded)
        ) {
          runInAction(() => {
            this.setTerminalDrawerOpen(false);
            this.terminalDrawerActiveItem = undefined;
          });
        }
      },
      { fireImmediately: true }
    );
    this._sessionDisposers.push(closeEmptyTerminalDrawerDisposer);

    // Open this view's file-tree projection now that the workspace is provisioned.
    this.editorView.startFiles(workspace.path);

    const reconcileRegisteredScopesDisposer = reaction(
      () => {
        const files = this.editorView.files;
        if (!files) return '';
        const expanded = [...this.editorView.expandedPaths].sort().join('\0');
        const loaded = [...files.loadedPaths].sort().join('\0');
        const pending = [...files.pendingPaths].sort().join('\0');
        // `nodes.size` advances as scopes load, re-triggering progressive deep registration.
        return `${expanded}::${loaded}::${pending}::${files.nodes.size}`;
      },
      () => {
        const files = this.editorView.files;
        if (!files) return;
        files.reconcileVisibleScopes(this.editorView.expandedPaths);
      },
      { fireImmediately: true }
    );
    this._sessionDisposers.push(reconcileRegisteredScopesDisposer);
  }

  /**
   * Called when the task becomes unprovisioned. Persists the DiffView state and
   * tears down session-scoped stores and reactions. Stable state (tabs, sidebar)
   * is preserved so it survives re-provisioning.
   */
  suspend(): void {
    // Persist DiffView state before disposing.
    if (this.diffView) {
      this._savedDiffViewSnapshot = this.diffView.snapshot;
      this.diffView.dispose();
      this.diffView = null;
    }
    getDiffTabManager(this._taskStore.workspaceId!).unbindSession();
    this.prStore?.dispose();
    this.prStore = null;
    this.previewServers?.dispose();
    this.previewServers = null;

    // Stop snapshot persistence.
    this._snapshotDisposer?.();
    this._snapshotDisposer = null;
    this.paneLayout.stopPersistence();

    // Dispose session-scoped reactions before tearing down the projection they drive.
    for (const d of this._sessionDisposers) d();
    this._sessionDisposers = [];

    // Close this view's file-tree projection subscription.
    this.editorView.disposeFiles();
  }

  /**
   * Full teardown: suspend + dispose all permanent stores and reactions.
   * Call only when the task is being permanently removed.
   */
  dispose(): void {
    this.suspend();
    appState.history.prune((e) => e.kind === 'tab' && e.taskId === this.taskId);
    for (const d of this._disposers) d();
    this._seeder.dispose();
    this.paneLayout.dispose();
    this.terminalTabs.dispose();
    this.editorView.dispose();
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  /**
   * Opens a Conversation by id — the one shared entry point for "land on this
   * Conversation" (ticket #67). Both command-palette jump sites (the search
   * result and the Notifications-group entry) and the Task Detail Panel's
   * conversation row (next ticket) route through this rather than each
   * hardcoding a tab kind or opening the tab before the task view has
   * actually navigated there — see the focused-conversation navigation
   * parameter this method backs, which is what survives provisioning.
   *
   * Resolves the surface (ACP chat vs. terminal conversation) from the
   * conversation's own transport type via `conversationTabKind` — the same
   * mapper `SidebarConversationsList` already uses — never a hardcoded kind
   * or a second mapper. Marks the default-conversation seeder consumed
   * *before* opening (only once the conversation is confirmed to exist), so
   * a fresh task view whose seeder hasn't fired yet opens only the requested
   * conversation, never the initial one plus this one. `paneLayout.open`'s
   * existing single-mount dedup (both conversation tab kinds are keyed on
   * conversation id) activates an already-open tab instead of duplicating it.
   *
   * A conversation id that doesn't resolve on this task is a complete no-op —
   * the seeder is left untouched, so a fresh task view still opens its normal
   * default conversation.
   */
  openConversation(conversationId: string): void {
    const conversation = conversationRegistry.get(this.taskId)?.conversations.get(conversationId);
    if (!conversation) return;
    this._seeder.markConsumed(true);
    this.paneLayout.open(
      conversationTabKind(conversation.data.type),
      { conversationId },
      { preview: false }
    );
  }

  /**
   * Resolves the focused-conversation navigation parameter (ticket #67):
   * tolerant of conversation data for this task still loading, unlike
   * `openConversation`'s plain synchronous check.
   *
   * A task view reached via a fresh provision (never opened before) turns
   * `ready` — and mounts this resolution — the moment the task store
   * transitions to provisioned, in the very same tick that acquires a
   * *non-preloaded* `ConversationManagerStore`: its conversation list is
   * fetched over IPC and is not yet populated. Calling `openConversation`
   * directly right there would see an empty registry and silently no-op,
   * exactly the discard-on-provision race this ticket exists to close —
   * only one call site removed. Mirrors `DefaultConversationSeeder`'s own
   * handling of the identical race: waits for the first non-empty
   * conversation list, then resolves exactly once via `openConversation`
   * (still a no-op if the id truly doesn't resolve once data has loaded —
   * "fails safe" holds either way).
   *
   * Returns a disposer: callers that may move on before this fires (e.g. a
   * React effect whose params changed, or unmounting) should call it so a
   * stale attempt never surfaces later. Also self-registers for cleanup on
   * `dispose()`, so it never outlives this view model either way.
   *
   * Suppresses the seeder *synchronously*, before either the wait below or
   * the seeder's own reaction can run — not merely once `openConversation`
   * resolves. The seeder subscribes its own one-shot "first non-empty
   * conversation list" reaction in the constructor, unconditionally, well
   * before this method can ever be called; when the never-provisioned race
   * this method exists for actually happens, both reactions watch the exact
   * same transition and the seeder's — subscribed first — always runs
   * first. Marking it consumed only inside `openConversation` (i.e. only
   * once resolution actually happens) is one reaction-tick too late: the
   * seeder would already have opened the initial conversation *alongside*
   * the requested one. Marking it consumed up front closes that window; if
   * the id turns out not to resolve, the seeder is explicitly reset and
   * re-run (`markConsumed(false)` + `seed()`) so it still opens its normal
   * default conversation, matching `openConversation`'s own "seeder left
   * untouched" contract. If this resolution is cancelled before it ever
   * settles (the returned disposer), the suppression is undone the same
   * way, so the seeder's own still-pending reaction can seed normally
   * whenever conversation data does arrive.
   */
  resolveFocusedConversation(conversationId: string): () => void {
    this._seeder.markConsumed(true);
    let settled = false;

    const settle = (resolve: () => void): void => {
      settled = true;
      resolve();
    };

    const tryResolve = (): void => {
      const conversation = conversationRegistry.get(this.taskId)?.conversations.get(conversationId);
      if (conversation) {
        settle(() => this.openConversation(conversationId));
        return;
      }
      settle(() => {
        this._seeder.markConsumed(false);
        this._seeder.seed();
      });
    };

    const conversations = conversationRegistry.get(this.taskId);
    if (conversations && conversations.conversations.size > 0) {
      tryResolve();
      return () => {};
    }

    const disposeReaction = reaction(
      () => conversationRegistry.get(this.taskId)?.conversations.size ?? 0,
      (size) => {
        if (size === 0) return;
        disposeReaction();
        tryResolve();
      }
    );
    const disposer = (): void => {
      disposeReaction();
      if (!settled) this._seeder.markConsumed(false);
    };
    this._disposers.push(disposer);
    return disposer;
  }

  activateLastTabOfKind(kind: 'conversation' | 'file' | 'diff' | 'browser' | 'terminal'): void {
    const tabId = [...this.activePane.tabOrder]
      .reverse()
      .find((id) => this.activePane.entries.get(id)?.kind === kind);
    if (!tabId) return;
    const panelView =
      kind === 'conversation'
        ? 'agents'
        : kind === 'file'
          ? 'editor'
          : kind === 'diff'
            ? 'diff'
            : kind === 'browser'
              ? 'browser'
              : 'terminal';
    focusTracker.transition({ mainPanel: panelView }, 'panel_switch');
    this.activePane.setActiveTab(tabId);
  }

  setSidebarTab(v: SidebarTab): void {
    this.sidebarTab = v;
  }

  setSidebarCollapsed(collapsed: boolean): void {
    this.isSidebarCollapsed = collapsed;
  }

  // Single source of truth for whether the changes panel is actually visible. TaskSidebar
  // hides it via ShowHide (display: none) based on this, and usePanelLayout must defer
  // imperative panel resizes to exactly the same condition (ENG-1559).
  get isChangesPanelVisible(): boolean {
    return !this.isSidebarCollapsed && this.sidebarTab === 'changes';
  }

  setFocusedRegion(region: 'main' | 'bottom'): void {
    if (this.focusedRegion !== region) {
      focusTracker.transition({ focusedRegion: region }, 'region_switch');
    }
    this.focusedRegion = region;
  }

  setTerminalDrawerOpen(open: boolean): void {
    this.isTerminalDrawerOpen = open;
    this.setFocusedRegion(open ? 'bottom' : 'main');
  }

  setTerminalDrawerActiveItem(item: TerminalDrawerActiveItem): void {
    this.terminalDrawerActiveItem = item;
  }

  /** Opens the terminal drawer and always creates a new terminal session. */
  async openNewTerminal(shell?: TerminalShellId): Promise<string | undefined> {
    this.isTerminalDrawerOpen = true;
    this.setFocusedRegion('bottom');

    const terminalId = await this._createDefaultTerminal(shell);
    if (!terminalId) return undefined;
    runInAction(() => {
      this.terminalTabs.setActiveTab(terminalId);
      this.terminalDrawerActiveItem = { kind: 'terminal', id: terminalId };
    });
    return terminalId;
  }

  private async _createDefaultTerminal(shell?: TerminalShellId): Promise<string | undefined> {
    if (this._isCreatingTerminal) return undefined;

    this._isCreatingTerminal = true;
    try {
      const terminal = await terminalRegistry.get(this.taskId)?.createDefaultTerminal(shell);
      if (!terminal) return undefined;
      return terminal.id;
    } catch (error) {
      log.error('Failed to create terminal:', error);
      return undefined;
    } finally {
      runInAction(() => {
        this._isCreatingTerminal = false;
      });
    }
  }
}

function normalizeDiffSnapshotPaths(
  snapshot: DiffViewSnapshot,
  workspacePath: string
): DiffViewSnapshot {
  const activeFile = snapshot.activeFile;
  if (!activeFile || activeFile.group === 'pr') return snapshot;
  return {
    ...snapshot,
    activeFile: {
      ...activeFile,
      path: resolveWorkspacePath(workspacePath, activeFile.path),
    },
  };
}
