import { computed, makeAutoObservable, observable, reaction, runInAction } from 'mobx';
import { type ProjectStore } from '@renderer/features/projects/stores/project';
import type { ProjectManagerStore } from '@renderer/features/projects/stores/project-manager';
import { taskAgentStatus } from '@renderer/features/tasks/stores/task-selectors';
import {
  registeredTaskData,
  unregisteredTaskData,
  type TaskStore,
} from '@renderer/features/tasks/stores/task-store';
import type { Snapshottable } from '@renderer/lib/stores/snapshottable';
import { workflowStages, type WorkflowStage } from '@shared/core/tasks/tasks';
import type { SidebarSnapshot, SidebarTaskSortBy } from '@shared/view-state';
import { buildStageGroupedRows, type SidebarRow } from './stage-group-row-model';

/** Every known Workflow Stage id — used to sanitize persisted snapshot blobs. */
const WORKFLOW_STAGE_VALUES: ReadonlySet<string> = new Set(workflowStages.options);

function parseSidebarTaskSortBy(value: unknown): SidebarTaskSortBy | undefined {
  return value === 'created-at' || value === 'updated-at' ? value : undefined;
}

export type TaskSortKind = 'created' | 'updated';

export function sortKindFor(sortBy: SidebarTaskSortBy): TaskSortKind {
  return sortBy === 'created-at' ? 'created' : 'updated';
}

export function getSortInstant(task: TaskStore, kind: TaskSortKind): string | undefined {
  const reg = registeredTaskData(task);
  if (reg) {
    if (kind === 'created') return reg.createdAt;
    return reg.lastInteractedAt ?? reg.updatedAt;
  }
  const u = unregisteredTaskData(task);
  if (u) {
    if (kind === 'created') return u.createdAt;
    return u.lastInteractedAt;
  }
  return undefined;
}

/**
 * Keeps only known Workflow Stage ids from a persisted snapshot blob —
 * snapshots from an older or newer app version must not corrupt the field.
 */
function sanitizeCollapsedStageGroups(
  value: Record<string, WorkflowStage[]>
): Record<string, WorkflowStage[]> {
  const result: Record<string, WorkflowStage[]> = {};
  for (const [projectId, stages] of Object.entries(value)) {
    const valid = stages.filter((stage) => WORKFLOW_STAGE_VALUES.has(stage));
    if (valid.length > 0) result[projectId] = valid;
  }
  return result;
}

export class SidebarStore implements Snapshottable<SidebarSnapshot> {
  projectOrder: string[] = [];
  taskOrderByProject: Record<string, string[]> = {};
  expandedProjectIds = observable.set<string>();
  taskSortBy: SidebarTaskSortBy = 'created-at';
  /**
   * Collapsed Stage Group ids per project (spec #85, ticket #86): a stage
   * whose group is collapsed keeps its header row but omits its task rows.
   * Persisted in the sidebar snapshot; stale ids for stages with no
   * visible tasks are pruned by the reaction below, so a newly non-empty
   * group always appears expanded.
   */
  collapsedStageGroupIdsByProject: Record<string, WorkflowStage[]> = {};

  constructor(private readonly projectManager: ProjectManagerStore) {
    makeAutoObservable(this, {
      expandedProjectIds: false,
      sidebarRows: computed,
      pinnedSidebarEntries: computed,
    });

    // Auto-expand a project when its task count goes from 0 to >0.
    const prevTaskCounts = new Map<string, number>();
    reaction(
      () => {
        const counts: [string, number][] = [];
        for (const [id, project] of this.projectManager.projects) {
          if (project.mountedProject) {
            counts.push([id, project.mountedProject.taskManager.tasks.size]);
          }
        }
        return counts;
      },
      (counts) => {
        runInAction(() => {
          for (const [id, count] of counts) {
            const prev = prevTaskCounts.get(id) ?? 0;
            if (prev === 0 && count > 0) {
              this.ensureProjectExpanded(id);
            }
            prevTaskCounts.set(id, count);
          }
        });
      }
    );

    // Prune stale collapsed Stage Group ids (spec #85): a group with no
    // visible tasks is not rendered, so it cannot be collapsed — and a stale
    // id must not collapse the group when a task later moves back in ("a
    // newly non-empty group appears expanded"). Tracks the row model so the
    // prune runs on any task/expansion/collapse change, but derives each
    // project's non-empty stages from the tasks themselves (a project whose
    // rows show no groups at all must still prune). Idempotent: once pruned,
    // no further write happens, so the reaction settles.
    reaction(
      () => this.sidebarRows,
      () => {
        runInAction(() => {
          for (const [projectId, project] of this.projectManager.projects) {
            const mounted = project.mountedProject;
            if (!mounted) continue;
            const nonEmpty = new Set<WorkflowStage>();
            for (const task of mounted.taskManager.tasks.values()) {
              if (task.data.type === 'automation-run' || task.data.isPinned) continue;
              if (
                task.state !== 'unregistered' &&
                'archivedAt' in task.data &&
                task.data.archivedAt
              ) {
                continue;
              }
              const stage = 'workflowStage' in task.data ? task.data.workflowStage : undefined;
              if (stage) nonEmpty.add(stage);
            }
            const stored = this.collapsedStageGroupIdsByProject[projectId] ?? [];
            const pruned = stored.filter((stage) => nonEmpty.has(stage));
            if (pruned.length === stored.length) continue;
            const next = { ...this.collapsedStageGroupIdsByProject };
            // A fully-pruned project's key is dropped entirely, so the record
            // never carries empty arrays (and `isStageGroupCollapsed` stays
            // false for every stage of that project).
            if (pruned.length === 0) {
              delete next[projectId];
            } else {
              next[projectId] = pruned;
            }
            this.collapsedStageGroupIdsByProject = next;
          }
        });
      }
    );
  }

  get orderedProjects(): ProjectStore[] {
    const all = Array.from(this.projectManager.projects.values());

    return [...all].sort((a, b) => {
      const ai = this.projectOrder.indexOf(a.id);
      const bi = this.projectOrder.indexOf(b.id);
      if (ai === -1 && bi === -1) return this.compareSidebarProjects(a, b);
      if (ai === -1) return -1;
      if (bi === -1) return 1;
      return ai - bi;
    });
  }

  get sidebarRows(): SidebarRow[] {
    const rows: SidebarRow[] = [];
    for (const project of this.orderedProjects) {
      const projectId = project.id;
      if (this.expandedProjectIds.has(projectId) && project.mountedProject) {
        // Grouped rows replace the flat task list (spec #85, ticket #86):
        // project row, Board row, Unstaged loose rows, then one header row
        // per non-empty stage in board column order, each followed by its
        // task rows (omitted for collapsed groups).
        rows.push(...this.groupedRowsForProject(projectId));
      } else {
        rows.push({ kind: 'project', projectId });
      }
    }
    return rows;
  }

  /**
   * The stage-grouped rows for one project, independent of expand state.
   * The row-model builder (stage-group-row-model.ts) emits the project and
   * Board rows plus the grouped content; it never writes stages or ranks —
   * read-only ordering only (ADR 0006).
   */
  private groupedRowsForProject(projectId: string): SidebarRow[] {
    const mounted = this.projectManager.projects.get(projectId)?.mountedProject;
    if (!mounted) return [];
    const tasks = Array.from(mounted.taskManager.tasks.values()).filter(
      (t) =>
        t.data.type !== 'automation-run' &&
        !t.data.isPinned &&
        (t.state === 'unregistered' || !('archivedAt' in t.data && t.data.archivedAt))
    );
    // Awaiting Input elevation is render-time only (ADR 0002): the same
    // status the board reads, never persisted.
    const awaitingInputIds = new Set<string>();
    for (const task of tasks) {
      if (taskAgentStatus(task) === 'awaiting-input') awaitingInputIds.add(task.data.id);
    }
    return buildStageGroupedRows({
      projectId,
      tasks: tasks.map((t) => t.data),
      collapsedStages: new Set(this.collapsedStageGroupIdsByProject[projectId] ?? []),
      awaitingInputIds,
    });
  }

  /** Visible unpinned tasks in the same order they are rendered in the project tree. */
  get visibleTaskEntries(): { projectId: string; taskId: string }[] {
    return this.sidebarRows
      .filter((row): row is Extract<SidebarRow, { kind: 'task' }> => row.kind === 'task')
      .map(({ projectId, taskId }) => ({ projectId, taskId }));
  }

  /** Flat list of pinned tasks (all mounted projects), same sort rules as project tree tasks. */
  get pinnedSidebarEntries(): { projectId: string; taskId: string }[] {
    const pairs: { projectId: string; task: TaskStore }[] = [];
    for (const project of this.projectManager.projects.values()) {
      if (!project.mountedProject) continue;
      const projectId = project.id;
      for (const task of project.mountedProject.taskManager.tasks.values()) {
        const visible =
          task.state === 'unregistered' || !('archivedAt' in task.data && task.data.archivedAt);
        if (!visible || !task.data.isPinned) continue;
        pairs.push({ projectId, task });
      }
    }
    pairs.sort((a, b) => this.compareSidebarTasks(a.task, b.task));
    return pairs.map(({ projectId, task }) => ({ projectId, taskId: task.data.id }));
  }

  /**
   * Visible unpinned task IDs for a project in sidebar row order (spec #85):
   * the grouped model's order — Board Rank first, unranked after, Awaiting
   * Input elevated — with the tasks of collapsed groups excluded, so
   * navigation never lands on a task whose row is not rendered. Archived,
   * pinned and automation tasks are excluded. Independent of expand state so
   * Next/Previous Task navigation works even when the project is collapsed.
   * `taskSortBy` and the per-project manual orders are inert in grouped mode
   * (spec: no data migration).
   */
  visibleTaskIdsForProject(projectId: string): string[] {
    if (!this.projectManager.projects.get(projectId)?.mountedProject) return [];
    return this.groupedRowsForProject(projectId)
      .filter((row): row is Extract<SidebarRow, { kind: 'task' }> => row.kind === 'task')
      .map((row) => row.taskId);
  }

  get isEmpty(): boolean {
    return this.projectManager.projects.size === 0;
  }

  get snapshot(): SidebarSnapshot {
    return {
      expandedProjectIds: [...this.expandedProjectIds],
      projectOrder: [...this.projectOrder],
      taskOrderByProject: { ...this.taskOrderByProject },
      taskSortBy: this.taskSortBy,
      collapsedStageGroupIdsByProject: { ...this.collapsedStageGroupIdsByProject },
    };
  }

  restoreSnapshot(snapshot: Partial<SidebarSnapshot>): void {
    if (snapshot.expandedProjectIds !== undefined) {
      this.expandedProjectIds.replace(snapshot.expandedProjectIds);
    }
    if (snapshot.projectOrder !== undefined) {
      this.projectOrder = [...snapshot.projectOrder];
    }
    if (snapshot.taskOrderByProject !== undefined) {
      this.taskOrderByProject = { ...snapshot.taskOrderByProject };
    }
    if (snapshot.taskSortBy !== undefined) {
      const v = parseSidebarTaskSortBy(snapshot.taskSortBy);
      if (v !== undefined) this.taskSortBy = v;
    }
    if (snapshot.collapsedStageGroupIdsByProject !== undefined) {
      // Only known stage ids are kept; stale ids for stages that end up
      // empty are pruned by the reaction as rows render, so a group that
      // gains its first task appears expanded.
      this.collapsedStageGroupIdsByProject = sanitizeCollapsedStageGroups(
        snapshot.collapsedStageGroupIdsByProject
      );
    }
  }

  /** Called on first load when no snapshot exists — expand all known projects. */
  expandAllProjects(): void {
    for (const project of this.orderedProjects) {
      this.expandedProjectIds.add(project.id);
    }
  }

  toggleProjectExpanded(projectId: string): void {
    if (this.expandedProjectIds.has(projectId)) {
      this.expandedProjectIds.delete(projectId);
    } else {
      this.expandedProjectIds.add(projectId);
    }
  }

  ensureProjectExpanded(projectId: string): void {
    this.expandedProjectIds.add(projectId);
  }

  /** Collapses an expanded Stage Group, or expands a collapsed one (spec #85). */
  toggleStageGroupCollapsed(projectId: string, stage: WorkflowStage): void {
    const current = this.collapsedStageGroupIdsByProject[projectId] ?? [];
    const next = current.includes(stage)
      ? current.filter((s) => s !== stage)
      : [...current, stage];
    this.collapsedStageGroupIdsByProject = {
      ...this.collapsedStageGroupIdsByProject,
      [projectId]: next,
    };
  }

  isStageGroupCollapsed(projectId: string, stage: WorkflowStage): boolean {
    return (this.collapsedStageGroupIdsByProject[projectId] ?? []).includes(stage);
  }

  setTaskSortBy(sortBy: SidebarTaskSortBy): void {
    this.taskSortBy = sortBy;
  }

  /** Set the sort key and clear all manual task orders so the list fully re-sorts. */
  applySort(sortBy: SidebarTaskSortBy): void {
    this.taskSortBy = sortBy;
    this.taskOrderByProject = {};
  }

  setProjectOrder(ids: string[]): void {
    this.projectOrder = ids;
  }

  mergeTaskOrder(projectId: string, tasks: TaskStore[]): TaskStore[] {
    const stored = this.taskOrderByProject[projectId] ?? [];
    const byId = new Map(tasks.map((t) => [t.data.id, t] as const));
    const seen = new Set<string>();
    const result: TaskStore[] = [];
    for (const id of stored) {
      const t = byId.get(id);
      if (t) {
        result.push(t);
        seen.add(id);
      }
    }
    // New tasks (not in the manual order) are sorted by date and prepended so
    // they always appear at the top rather than buried after manually-ordered tasks.
    const newTasks = tasks
      .filter((t) => !seen.has(t.data.id))
      .sort((a, b) => this.compareSidebarTasks(a, b));
    return [...newTasks, ...result];
  }

  setTaskOrder(projectId: string, orderedIds: string[]): void {
    this.taskOrderByProject = { ...this.taskOrderByProject, [projectId]: orderedIds };
  }

  private compareSidebarTasks(a: TaskStore, b: TaskStore): number {
    const kind = sortKindFor(this.taskSortBy);
    const ia = getSortInstant(a, kind) ?? '';
    const ib = getSortInstant(b, kind) ?? '';
    const d = ib.localeCompare(ia);
    if (d !== 0) return d;
    return a.data.id.localeCompare(b.data.id);
  }

  private compareSidebarProjects(a: ProjectStore, b: ProjectStore): number {
    const d = b.createdAt.localeCompare(a.createdAt);
    if (d !== 0) return d;
    return a.id.localeCompare(b.id);
  }
}
