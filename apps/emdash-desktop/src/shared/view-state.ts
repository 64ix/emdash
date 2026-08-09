import type { GitChangeStatus, GitObjectRef } from '@emdash/core/git';
import type { BrowserSessionSnapshot } from '@shared/browser';
import type { WorkflowStage } from '@shared/core/tasks/tasks';

export type TabViewSnapshot = {
  tabOrder: string[];
  activeTabId: string | undefined;
};

export type TabDescriptor =
  | { kind: 'conversation'; tabId: string; conversationId: string; isPreview: boolean }
  | { kind: 'acp-chat'; tabId: string; conversationId: string; isPreview: boolean }
  | { kind: 'file'; tabId: string; path: string; isPreview: boolean; isExternal?: boolean }
  | {
      kind: 'browser';
      tabId: string;
      browserId: string;
      session: BrowserSessionSnapshot;
      isPreview: boolean;
    }
  | { kind: 'terminal'; tabId: string; terminalId: string; isPreview: boolean }
  | {
      kind: 'diff';
      tabId: string;
      path: string;
      diffGroup: 'disk' | 'staged' | 'git' | 'pr';
      originalRef: GitObjectRef;
      modifiedRef?: GitObjectRef;
      prNumber?: number;
      prBaseOid?: string;
      prHeadOid?: string;
      commitOriginalSha?: string | null;
      commitModifiedSha?: string;
      status?: GitChangeStatus;
      isPreview: boolean;
    };

export type TabManagerSnapshot = {
  tabs: TabDescriptor[];
  activeTabId: string | undefined;
};

export type TabGroupsSnapshot = {
  groups: Array<{
    groupId: string;
    tabManager: TabManagerSnapshot;
  }>;
  activeGroupId: string;
  /** Percentage sizes parallel to groups[]. */
  paneSizes: number[];
};

export type EditorViewSnapshot = {
  /** Legacy: was used before tab state moved to TabManagerSnapshot. Ignored on restore. */
  tabs?: Array<{ tabId: string; path: string; isPreview: boolean; isExternal?: boolean }>;
  /** Legacy: was used before tab state moved to TabManagerSnapshot. Ignored on restore. */
  activeTabId?: string | null;
  expandedPaths: string[];
};

export type DiffViewSnapshot = {
  diffStyle: 'unified' | 'split';
  viewMode: 'file';
  activeFile?: ActiveFile;
  commitAction: 'commit' | 'commit-push' | 'commit-pr' | null;
  prTab?: 'files' | 'commits' | 'checks';
};

export type ChangesRailFilter = 'all' | 'edited' | 'read';

/**
 * Persisted view preferences for the ACP chat's task-scoped Changes rail.
 * Only UI preferences are persisted here — the rail's contents are a
 * projection recomputed from transcript + Git state, never stored (see
 * `acp-changes-footprint.ts`).
 */
export type ChangesRailSnapshot = {
  isOpen?: boolean;
  width?: number;
  filter?: ChangesRailFilter;
  selectedPath?: string | null;
};

export type TerminalDrawerActiveItem =
  | { kind: 'terminal'; id: string }
  | { kind: 'script'; id: string };

export interface ActiveFile {
  path: string;
  /** Storage layer: how content is fetched.
   *  'disk' = working-tree read (disk://)
   *  'git'  = git-object read (git://) */
  type: 'disk' | 'git';
  /** Semantic context: which diff panel/group this file belongs to.
   *  Determines which side is original/modified and which events make it stale.
   *  'disk'   = working tree vs HEAD
   *  'staged' = index vs HEAD
   *  'git'    = arbitrary ref-to-ref comparison
   *  'pr'     = PR diff (originalRef is remote-tracking base) */
  group: 'disk' | 'staged' | 'git' | 'pr';
  originalRef: GitObjectRef;
  /** Fixed modified-side ref for 'git' and 'pr' diffs.
   *  When absent the diff viewer falls back to HEAD_REF. */
  modifiedRef?: GitObjectRef;
  /** Set only when group === 'pr'. Identifies the PR for store lookups. */
  prNumber?: number;
  /** Exact PR base/head OIDs for comment scoping and stable target identity. */
  prBaseOid?: string;
  prHeadOid?: string;
  /** Exact commit diff endpoints for comment scoping. Root commits use null original. */
  commitOriginalSha?: string | null;
  commitModifiedSha?: string;
}

export type TaskViewSnapshot = {
  sidebarTab?: string;
  isSidebarCollapsed?: boolean;
  focusedRegion: 'main' | 'bottom';
  isTerminalDrawerOpen?: boolean;
  terminalDrawerActiveItem?: TerminalDrawerActiveItem;
  /** Takes precedence over tabManager when present. */
  tabGroups?: TabGroupsSnapshot;
  /** @deprecated Use tabGroups. Kept for migration from single-pane snapshots. */
  tabManager?: TabManagerSnapshot;
  /** @deprecated Legacy field from before the unified tab refactor. Used only for migration. */
  conversations?: TabViewSnapshot;
  terminals?: TabViewSnapshot;
  editor?: EditorViewSnapshot;
  diffView?: DiffViewSnapshot;
  changesRail?: ChangesRailSnapshot;
};

export type ProjectTaskSortBy = 'created-at' | 'updated-at' | 'pr-status' | 'unread';

export type ProjectViewSnapshot = {
  /**
   * Kept as `string` (not the renderer's `ProjectView` union) because this
   * crosses the main/renderer boundary as an untyped KV blob: older
   * snapshots, and snapshots from a newer app version, must still parse.
   * `ProjectViewStore.restoreSnapshot` (ticket #44) validates it against the
   * current known set — currently `'tasks' | 'pull-request' | 'settings' |
   * 'board'` — before assigning it, so an unrecognized value is ignored
   * rather than assigned.
   */
  activeView: string;
  taskViewTab: 'active' | 'archived';
  taskSortBy?: ProjectTaskSortBy;
  selectedIssueProvider?: string;
};

export type NavigationSnapshot = {
  currentViewId: string;
  viewParams: Record<string, unknown>;
};

export type SidebarTaskSortBy = 'created-at' | 'updated-at';

/** Persisted sidebar UI state; fields may be absent in older DB blobs. */
export type SidebarSnapshot = {
  expandedProjectIds?: string[];
  projectOrder?: string[];
  taskOrderByProject?: Record<string, string[]>;
  taskSortBy?: SidebarTaskSortBy;
  /**
   * Collapsed Stage Group ids (Workflow Stages) per project (spec #85):
   * a collapsed group hides its task rows in the sidebar until the header
   * is clicked again. Pure view state — tasks are never touched. A group
   * that has no visible tasks is not rendered and cannot be collapsed, so
   * stale ids are pruned by the SidebarStore and a newly non-empty group
   * always appears expanded.
   */
  collapsedStageGroupIdsByProject?: Record<string, WorkflowStage[]>;
  /**
   * Hidden Task ids per project (spec #85, ticket #87): tasks the user hid
   * from the sidebar with the context menu's "Hide from sidebar" action.
   * Pure view state — the task itself is never touched (ADR 0006: the
   * board, the project view's task list and search keep showing it). The
   * hidden set survives restarts; hidden tasks are unhidden from the
   * project view's task list.
   */
  hiddenTaskIdsByProject?: Record<string, string[]>;
  /**
   * Global Board project multi-select (spec #104, ticket #105): the project
   * ids whose cards the Global Board shows. Absent (or `undefined`) means
   * "all projects" — the default; an empty array behaves the same way (the
   * header's toggle normalizes a full re-selection back to the empty
   * "all projects" default, so the persisted value stays canonical). The
   * only Global Board filter that persists; the Board Header's other filters
   * stay ephemeral view state. Scoped per workspace: the sidebar snapshot is
   * app-global today (a single workspace), so this flat field holds that
   * workspace's value — if the app ever gains multiple workspaces, this is
   * the field to key by workspace id (the `sidebar` snapshot key is the seam).
   */
  globalBoardProjectFilter?: string[];
};
