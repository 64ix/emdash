import { makeAutoObservable } from 'mobx';
import type { Snapshottable } from '@renderer/lib/stores/snapshottable';
import type { IssueProviderType } from '@shared/issue-providers';
import type { ProjectTaskSortBy, ProjectViewSnapshot } from '@shared/view-state';

/**
 * The project workspace's primary work modes (ticket #44: Board, List
 * — stored as `'tasks'` for backward compatibility, only its label changed —
 * and Pull Requests), plus Settings, which is a project-configuration
 * destination rather than a work-mode peer but still uses this same
 * persisted slot.
 */
export type ProjectView = 'tasks' | 'pull-request' | 'settings' | 'board';

const PROJECT_VIEWS: ReadonlySet<string> = new Set<ProjectView>([
  'tasks',
  'pull-request',
  'settings',
  'board',
]);

function isProjectTaskSortBy(value: unknown): value is ProjectTaskSortBy {
  return (
    value === 'created-at' || value === 'updated-at' || value === 'pr-status' || value === 'unread'
  );
}

/**
 * Validates a persisted `activeView` value instead of blindly casting it
 * (ticket #44). Snapshots written before Board existed only ever carried
 * `'tasks' | 'pull-request' | 'settings'`, all still valid here, so they load
 * unchanged. An unrecognized value — a snapshot written by a newer app
 * version, or corrupted data — is rejected rather than assigned, so the
 * store keeps its default instead of entering a state no current UI renders.
 */
function isProjectView(value: unknown): value is ProjectView {
  return typeof value === 'string' && PROJECT_VIEWS.has(value);
}

export class ProjectViewStore implements Snapshottable<ProjectViewSnapshot> {
  // No universal Board default (ticket #44): existing and new projects alike
  // keep starting on List until a user explicitly picks Board, at which
  // point `restoreSnapshot` below persists that choice going forward.
  activeView: ProjectView = 'tasks';
  taskView: TaskViewStore = new TaskViewStore();
  selectedIssueProvider: IssueProviderType | null = null;

  constructor() {
    makeAutoObservable(this);
  }

  setProjectView(view: ProjectView) {
    this.activeView = view;
  }

  setSelectedIssueProvider(provider: IssueProviderType | null) {
    this.selectedIssueProvider = provider;
  }

  get snapshot(): ProjectViewSnapshot {
    return {
      activeView: this.activeView,
      taskViewTab: this.taskView.tab,
      taskSortBy: this.taskView.sortBy,
      selectedIssueProvider: this.selectedIssueProvider ?? undefined,
    };
  }

  restoreSnapshot(snapshot: Partial<ProjectViewSnapshot>): void {
    if (isProjectView(snapshot.activeView)) this.activeView = snapshot.activeView;
    if (snapshot.taskViewTab) this.taskView.setTab(snapshot.taskViewTab);
    if (isProjectTaskSortBy(snapshot.taskSortBy)) this.taskView.setSortBy(snapshot.taskSortBy);
    if (snapshot.selectedIssueProvider)
      this.selectedIssueProvider = snapshot.selectedIssueProvider as IssueProviderType;
  }
}

class TaskViewStore {
  tab: 'active' | 'archived' = 'active';
  sortBy: ProjectTaskSortBy = 'updated-at';
  searchQuery: string = '';
  selectedIds: Set<string> = new Set();
  lastSelectedId: string | null = null;

  constructor() {
    makeAutoObservable(this);
  }

  setTab(tab: 'active' | 'archived') {
    this.tab = tab;
  }

  setSortBy(sortBy: ProjectTaskSortBy) {
    this.sortBy = sortBy;
  }

  setSearchQuery(query: string) {
    this.searchQuery = query;
  }

  setSelectedIds(ids: Set<string>) {
    this.selectedIds = ids;
    this.lastSelectedId = null;
  }

  toggleSelect(id: string) {
    if (this.selectedIds.has(id)) {
      this.selectedIds.delete(id);
    } else {
      this.selectedIds.add(id);
    }
    this.lastSelectedId = id;
  }

  selectRange(orderedIds: string[], toId: string) {
    const anchor = this.lastSelectedId;
    if (!anchor || anchor === toId) {
      this.toggleSelect(toId);
      return;
    }
    const fromIndex = orderedIds.indexOf(anchor);
    const toIndex = orderedIds.indexOf(toId);
    if (fromIndex === -1 || toIndex === -1) {
      this.toggleSelect(toId);
      return;
    }
    const [start, end] = fromIndex < toIndex ? [fromIndex, toIndex] : [toIndex, fromIndex];
    this.selectedIds = new Set(orderedIds.slice(start, end + 1));
  }
}
