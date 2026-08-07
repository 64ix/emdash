import { FolderKanban, Plus, SlidersHorizontal, X } from 'lucide-react';
import type { ReactNode } from 'react';
import {
  AGENT_STATE_FILTER_LABELS,
  EMPTY_BOARD_FILTERS,
  hasActiveBoardFilters,
  LINKED_ISSUE_PRESENCE_FILTER_LABELS,
  PR_STATE_FILTER_LABELS,
  toggleSetMember,
  type AgentStateFilterValue,
  type BoardFilterState,
  type LinkedIssuePresenceFilterValue,
  type PrStateFilterValue,
} from '@renderer/features/board/board-filters';
import { Badge } from '@renderer/lib/ui/badge';
import { Button } from '@renderer/lib/ui/button';
import { Checkbox } from '@renderer/lib/ui/checkbox';
import { Label } from '@renderer/lib/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/lib/ui/popover';
import { SearchInput } from '@renderer/lib/ui/search-input';
import { Separator } from '@renderer/lib/ui/separator';
import { Toggle } from '@renderer/lib/ui/toggle';
import { captureTelemetry } from '@renderer/utils/telemetryClient';
import { STAGE_LABELS } from './board-columns';
import { COLUMNS } from './board-ordering';

const AGENT_STATE_VALUES: AgentStateFilterValue[] = [
  'working',
  'awaiting-input',
  'error',
  'completed',
  'idle',
];
const LINKED_ISSUE_PRESENCE_VALUES: LinkedIssuePresenceFilterValue[] = ['linked', 'unlinked'];
const PR_STATE_VALUES: PrStateFilterValue[] = ['open', 'merged', 'closed', 'none'];

/**
 * The project multi-select axis (spec #104, ticket #107): the only Global
 * Board filter that persists (per workspace, `SidebarSnapshot
 * .globalBoardProjectFilter`). Presentational — the header never imports a
 * store; the view wires this to the sidebar store, and the Feature Board
 * simply never passes the axis. An empty `selectedProjectIds` is the
 * persisted default, "all projects".
 */
export type BoardProjectFilterAxis = {
  /** The filter-list candidate set, in display order — every project with at
   * least one displayable card (the module's `presentProjects`). */
  presentProjectIds: readonly string[];
  /** The active selection; empty = all projects. */
  selectedProjectIds: ReadonlySet<string>;
  /** Persists the next explicit selection (`[]` = all projects). */
  onSelectionChange: (projectIds: string[]) => void;
  /** Display name for a project id, falling back to the id itself. */
  projectDisplayNameOf: (projectId: string) => string;
};

/**
 * Feature Board workspace header (ticket #45): project scope, task creation,
 * search, Needs Attention, and the compact filter categories. Active
 * filters remain visible below as clearable chips — a hidden card must never
 * be unexplained (spec #25's User Story 20). The Global Board (spec #104,
 * ticket #107) reuses it with `title`, an optional `projectFilter` axis and
 * no `onCreateTask`; without those props the header is unchanged.
 */
export function BoardHeader({
  title = 'Feature board',
  projectName,
  filters,
  onFiltersChange,
  onCreateTask,
  projectFilter,
}: {
  title?: string;
  projectName: string;
  filters: BoardFilterState;
  onFiltersChange: (next: BoardFilterState) => void;
  onCreateTask?: () => void;
  projectFilter?: BoardProjectFilterAxis;
}) {
  const compactFilterCount =
    filters.stages.size +
    filters.agentStates.size +
    filters.linkedIssuePresence.size +
    filters.prStates.size;

  // The project axis' active state: an empty selection is the "all projects"
  // default, so a restriction is active exactly when the selection lists at
  // least one project. Chips explain the *excluded* projects (the ones a
  // "hidden card" reading needs explained), each individually clearable to
  // re-include.
  const projectSelectionIsActive =
    projectFilter !== undefined && projectFilter.selectedProjectIds.size > 0;
  const excludedProjectIds = projectSelectionIsActive
    ? projectFilter!.presentProjectIds.filter((id) => !projectFilter!.selectedProjectIds.has(id))
    : [];

  /**
   * Toggles one project in or out of the selection. From the default (empty
   * = all), deselecting materializes the explicit list of every other
   * present project; re-selecting them all normalizes back to the empty
   * default so the persisted value stays canonical. Stale selected ids
   * (projects that no longer have displayable cards) are left alone — the
   * module's filter predicate ignores them — and are never counted above.
   */
  const toggleProject = (projectId: string) => {
    if (!projectFilter) return;
    const present = projectFilter.presentProjectIds;
    const selected = [...projectFilter.selectedProjectIds];
    const isAll = selected.length === 0;
    const currentlySelected = isAll || selected.includes(projectId);
    const next = currentlySelected
      ? isAll
        ? present.filter((id) => id !== projectId)
        : selected.filter((id) => id !== projectId)
      : [...selected, projectId];
    const coversAll =
      present.length > 0 &&
      next.length === present.length &&
      present.every((id) => next.includes(id));
    projectFilter.onSelectionChange(coversAll ? [] : next);
  };

  const setNeedsAttentionOnly = (active: boolean) => {
    onFiltersChange({ ...filters, needsAttentionOnly: active });
    captureTelemetry('board_needs_attention_filtered', { active });
  };

  return (
    <div className="flex flex-col gap-2 border-b border-border px-4 pt-4 pb-3">
      <div className="flex items-center justify-between gap-2">
        {/* Narrow-window adaptation (ticket #52): `min-w-0` lets this group
            shrink instead of forcing the row to overflow, and the project
            name (unlike the fixed "Feature board" label) is the part that
            actually varies in length — it truncates first, the same
            protect-the-primary-action pattern the Task Detail Panel's own
            header already uses for its title row. Without this, a long
            project name on a narrow supported window could push "New task"
            (the primary action) out of the visible header entirely. */}
        <div className="flex min-w-0 items-baseline gap-2">
          <h1 className="shrink-0 text-sm font-medium">{title}</h1>
          <span
            className="min-w-0 flex-1 truncate text-xs text-foreground-muted"
            title={projectName}
          >
            {projectName}
          </span>
        </div>
        {/* Task creation is Feature Board-only (spec #104): a Global Board
            card would have no project, so the header offers no "New task"
            button there — the prop is simply absent. */}
        {onCreateTask && (
          <Button size="sm" onClick={onCreateTask}>
            <Plus className="size-3.5" />
            New task
          </Button>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput
          aria-label="Search tasks, Linked Issues, and Pull Requests"
          placeholder="Search tasks, issues, PRs…"
          value={filters.query}
          onChange={(e) => onFiltersChange({ ...filters, query: e.target.value })}
          containerClassName="w-56"
          focusHotkey={false}
        />
        <Toggle
          size="sm"
          variant="outline"
          pressed={filters.needsAttentionOnly}
          onPressedChange={setNeedsAttentionOnly}
          aria-label="Filter to tasks needing attention"
        >
          Needs Attention
        </Toggle>
        <Popover>
          <PopoverTrigger
            render={
              <Button variant="outline" size="sm">
                <SlidersHorizontal className="size-3.5" />
                Filters
                {compactFilterCount > 0 && (
                  <Badge variant="secondary" aria-label={`${compactFilterCount} filters active`}>
                    {compactFilterCount}
                  </Badge>
                )}
              </Button>
            }
          />
          <PopoverContent align="start" className="w-64 gap-3">
            <FilterGroup title="Workflow Stage">
              {COLUMNS.map((column) => (
                <FilterCheckboxRow
                  key={column}
                  label={STAGE_LABELS[column]}
                  checked={filters.stages.has(column)}
                  onCheckedChange={() =>
                    onFiltersChange({ ...filters, stages: toggleSetMember(filters.stages, column) })
                  }
                />
              ))}
            </FilterGroup>
            <Separator />
            <FilterGroup title="Agent State">
              {AGENT_STATE_VALUES.map((value) => (
                <FilterCheckboxRow
                  key={value}
                  label={AGENT_STATE_FILTER_LABELS[value]}
                  checked={filters.agentStates.has(value)}
                  onCheckedChange={() =>
                    onFiltersChange({
                      ...filters,
                      agentStates: toggleSetMember(filters.agentStates, value),
                    })
                  }
                />
              ))}
            </FilterGroup>
            <Separator />
            <FilterGroup title="Linked Issue">
              {LINKED_ISSUE_PRESENCE_VALUES.map((value) => (
                <FilterCheckboxRow
                  key={value}
                  label={LINKED_ISSUE_PRESENCE_FILTER_LABELS[value]}
                  checked={filters.linkedIssuePresence.has(value)}
                  onCheckedChange={() =>
                    onFiltersChange({
                      ...filters,
                      linkedIssuePresence: toggleSetMember(filters.linkedIssuePresence, value),
                    })
                  }
                />
              ))}
            </FilterGroup>
            <Separator />
            <FilterGroup title="Pull Request">
              {PR_STATE_VALUES.map((value) => (
                <FilterCheckboxRow
                  key={value}
                  label={PR_STATE_FILTER_LABELS[value]}
                  checked={filters.prStates.has(value)}
                  onCheckedChange={() =>
                    onFiltersChange({
                      ...filters,
                      prStates: toggleSetMember(filters.prStates, value),
                    })
                  }
                />
              ))}
            </FilterGroup>
          </PopoverContent>
        </Popover>
        {/* Project multi-select (spec #104): the only persisted board filter,
            per workspace. The candidate set comes from the view (projects
            with at least one displayable card), so a project with no cards is
            absent here too — the same omission the board itself applies. */}
        {projectFilter && (
          <Popover>
            <PopoverTrigger
              render={
                <Button variant="outline" size="sm">
                  <FolderKanban className="size-3.5" />
                  Projects
                  {projectSelectionIsActive && (
                    <Badge
                      variant="secondary"
                      aria-label={`${projectFilter.selectedProjectIds.size} projects selected`}
                    >
                      {projectFilter.selectedProjectIds.size}
                    </Badge>
                  )}
                </Button>
              }
            />
            <PopoverContent align="start" className="w-64 gap-3">
              <FilterGroup title="Projects">
                {projectFilter.presentProjectIds.length === 0 ? (
                  <span className="text-xs text-foreground-muted">
                    No projects with displayable cards yet.
                  </span>
                ) : (
                  projectFilter.presentProjectIds.map((projectId) => (
                    <FilterCheckboxRow
                      key={projectId}
                      label={projectFilter.projectDisplayNameOf(projectId)}
                      checked={
                        !projectSelectionIsActive ||
                        projectFilter.selectedProjectIds.has(projectId)
                      }
                      onCheckedChange={() => toggleProject(projectId)}
                    />
                  ))
                )}
              </FilterGroup>
            </PopoverContent>
          </Popover>
        )}
      </div>
      {(hasActiveBoardFilters(filters) || excludedProjectIds.length > 0) && (
        <ActiveFilterChips
          filters={filters}
          onFiltersChange={onFiltersChange}
          excludedProjectIds={excludedProjectIds}
          projectFilter={projectFilter}
          onClearProjectFilter={(projectId) => toggleProject(projectId)}
        />
      )}
    </div>
  );
}

function FilterGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-foreground-muted">{title}</span>
      <div className="flex flex-col gap-1.5">{children}</div>
    </div>
  );
}

function FilterCheckboxRow({
  label,
  checked,
  onCheckedChange,
}: {
  label: string;
  checked: boolean;
  onCheckedChange: () => void;
}) {
  return (
    <Label className="text-xs font-normal">
      <Checkbox checked={checked} onCheckedChange={onCheckedChange} aria-label={label} />
      {label}
    </Label>
  );
}

/** A single active-filter chip: a label plus its own clear (×) button. */
function FilterChip({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <Badge variant="secondary" className="h-5 gap-1 pr-1 text-[11px]">
      {label}
      <button
        type="button"
        aria-label={`Remove filter: ${label}`}
        onClick={onClear}
        className="rounded-full p-0.5 hover:bg-foreground/10"
      >
        <X className="size-2.5" />
      </button>
    </Badge>
  );
}

/**
 * Active filters stay visible here, each individually clearable, plus a
 * "Clear all" action — a hidden card must always be explainable (spec #25's
 * User Story 20). On the Global Board (spec #104) the project multi-select
 * joins as one chip per *excluded* project (the projects whose cards are
 * hidden), each clearable to re-include; "Clear all" resets the project
 * selection to the default (all projects) too.
 */
function ActiveFilterChips({
  filters,
  onFiltersChange,
  excludedProjectIds,
  projectFilter,
  onClearProjectFilter,
}: {
  filters: BoardFilterState;
  onFiltersChange: (next: BoardFilterState) => void;
  excludedProjectIds: readonly string[];
  projectFilter: BoardProjectFilterAxis | undefined;
  onClearProjectFilter: (projectId: string) => void;
}) {
  const chips: { key: string; label: string; onClear: () => void }[] = [];

  if (filters.query.trim()) {
    chips.push({
      key: 'query',
      label: `Search: "${filters.query.trim()}"`,
      onClear: () => onFiltersChange({ ...filters, query: '' }),
    });
  }
  if (filters.needsAttentionOnly) {
    chips.push({
      key: 'needs-attention',
      label: 'Needs Attention',
      onClear: () => onFiltersChange({ ...filters, needsAttentionOnly: false }),
    });
  }
  for (const stage of filters.stages) {
    chips.push({
      key: `stage-${stage}`,
      label: STAGE_LABELS[stage],
      onClear: () =>
        onFiltersChange({ ...filters, stages: toggleSetMember(filters.stages, stage) }),
    });
  }
  for (const agentState of filters.agentStates) {
    chips.push({
      key: `agent-state-${agentState}`,
      label: AGENT_STATE_FILTER_LABELS[agentState],
      onClear: () =>
        onFiltersChange({
          ...filters,
          agentStates: toggleSetMember(filters.agentStates, agentState),
        }),
    });
  }
  for (const presence of filters.linkedIssuePresence) {
    chips.push({
      key: `linked-issue-${presence}`,
      label: LINKED_ISSUE_PRESENCE_FILTER_LABELS[presence],
      onClear: () =>
        onFiltersChange({
          ...filters,
          linkedIssuePresence: toggleSetMember(filters.linkedIssuePresence, presence),
        }),
    });
  }
  for (const prState of filters.prStates) {
    chips.push({
      key: `pr-state-${prState}`,
      label: PR_STATE_FILTER_LABELS[prState],
      onClear: () =>
        onFiltersChange({ ...filters, prStates: toggleSetMember(filters.prStates, prState) }),
    });
  }
  for (const projectId of excludedProjectIds) {
    chips.push({
      key: `project-excluded-${projectId}`,
      label: `Projects: ${projectFilter?.projectDisplayNameOf(projectId) ?? projectId}`,
      onClear: () => onClearProjectFilter(projectId),
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5" aria-label="Active filters">
      {chips.map((chip) => (
        <FilterChip key={chip.key} label={chip.label} onClear={chip.onClear} />
      ))}
      {chips.length > 1 && (
        <button
          type="button"
          className="text-[11px] text-foreground-muted underline-offset-2 hover:text-foreground hover:underline"
          onClick={() => {
            onFiltersChange(EMPTY_BOARD_FILTERS);
            projectFilter?.onSelectionChange([]);
          }}
        >
          Clear all
        </button>
      )}
    </div>
  );
}
