import type { AgentStatus } from '@shared/core/agents/agentEvents';
import type { WorkflowStage } from '@shared/core/tasks/tasks';
import type { SidebarRow } from './stage-group-row-model';

/**
 * The sidebar's per-project card model (spec #120, ticket #121): the pure,
 * board-independent module that projects one card per project out of the
 * existing ordered sidebar row stream (`SidebarStore.sidebarRows`). Modeled
 * on `stage-group-row-model.ts` — the same "pure seam, no store" shape — and
 * never a second source of truth: the card is a computed projection of the
 * row stream (ADR 0006: the sidebar is a projection of the board), so it
 * carries no new store state, no snapshot fields and no schema changes.
 *
 * Card layout (spec #120 "Implementation Decisions"): the card header shows
 * the project's aggregate live signal (priority `error > awaiting-input >
 * working`; completed never lights the header), the Needs Attention count
 * and the visible task count; the card body nests the project's Stage Group
 * headers (labels, counts, board column order) and task rows. Grouping
 * mirrors the prototype's `groupSidebarRows`: iterate rows in order, one
 * card per project, `stage-group` rows populate `stageGroups`, `task` rows
 * populate `tasks`. Collapsed Stage Group task omission is already baked
 * into the row stream (collapsed groups emit no task rows), so the
 * projection preserves it for free — verified by fixture in the tests.
 *
 * The aggregate inputs are lookups, not stores: the stream carries only
 * task ids, so the caller supplies the per-task live signal and Needs
 * Attention data (ticket #122 wires `taskAgentStatus` and the shared
 * `taskNeedsAttention` predicate from board-attention.ts into them). This
 * module stays import-safe for node unit tests — it never imports a
 * `TaskStore` or the renderer store graph.
 */

/** The statuses that light a task-row signal dot (spinner / amber / red / green). */
export type SidebarSignal = Exclude<AgentStatus, 'idle'>;

/**
 * The statuses that can light a card header: `completed` never does (its
 * dot is the task row's own business — a finished task needs no header
 * attention), so the aggregate signal is drawn from these three only.
 */
export type LiveSidebarSignal = Exclude<SidebarSignal, 'completed'>;

/**
 * The card-header aggregate priority (spec #120): error outranks
 * awaiting-input outranks working. Lower rank = higher priority.
 */
export const LIVE_SIGNAL_PRIORITY: Readonly<Record<LiveSidebarSignal, number>> = {
  error: 0,
  'awaiting-input': 1,
  working: 2,
};

/** One Stage Group of a project card, exactly as carried by its header row. */
export type SidebarCardStageGroup = {
  stage: WorkflowStage;
  /** Stage display label (`STAGE_LABELS`), copied from the row. */
  label: string;
  /** Number of visible tasks in the group; collapse does not change it. */
  count: number;
};

/** One rendered task row of a project card (collapsed-group tasks never appear). */
export type SidebarCardTask = {
  projectId: string;
  taskId: string;
};

/**
 * The derived card model for one project: the stream projection (stage
 * groups, task membership) plus the card-header aggregates. Read-only and
 * value-like — the renderer (ticket #122) maps it straight to the card UI.
 */
export type SidebarCardModel = {
  projectId: string;
  /**
   * The project's Stage Groups in the order the row stream carries them
   * (board column order, empty stages skipped — `buildStageGroupedRows`
   * guarantees it, and the projection never re-sorts).
   */
  stageGroups: SidebarCardStageGroup[];
  /** The card's rendered task rows, in stream order. */
  tasks: SidebarCardTask[];
  /**
   * The highest-priority live signal among the card's tasks, or `null`
   * when none is live (`working`/`awaiting-input`/`error` only — a
   * `completed` or idle task never lights the header).
   */
  aggregateSignal: LiveSidebarSignal | null;
  /**
   * Number of the card's tasks the caller's Needs Attention lookup marks —
   * the caller applies the shared `taskNeedsAttention` predicate
   * (board-attention.ts) once per task; this module never re-implements it.
   */
  attentionCount: number;
  /**
   * Number of visible (rendered) tasks — exactly `tasks.length`. A
   * collapsed project emits no task rows, so its card reports 0; surfacing
   * a collapsed project's true task count on the header is the caller's
   * call (the stream carries no such data for a collapsed project).
   */
  visibleTaskCount: number;
  /** The project's stable palette member (hash of the project id). */
  hue: ProjectHue;
};

/**
 * The pure module's single entry point (ticket #121 "seam"): the ordered
 * row stream plus the per-task aggregate lookups. Rows may span any number
 * of projects; task ids are globally unique (`crypto.randomUUID()` at
 * creation, the same keying the conversation registry uses), so the lookups
 * are keyed by task id alone.
 */
export type ProjectCardModelInput = {
  /** The ordered sidebar row stream (`SidebarStore.sidebarRows`). */
  rows: readonly SidebarRow[];
  /**
   * Per-task live signal lookup, keyed by task id — the same data the task
   * rows' signal dots render (ticket #122 wires the shared
   * `taskAgentStatus`-based mapping here). A missing id or `null` value
   * means no live signal: the task lights nothing, on its row or on the
   * card header.
   */
  signalByTaskId?: ReadonlyMap<string, SidebarSignal | null>;
  /**
   * Task ids for which the shared `taskNeedsAttention` predicate is true —
   * the caller applies it per `TaskStore` (it reads stores this module
   * never imports); the module only counts its own membership against it.
   */
  attentionTaskIds?: ReadonlySet<string>;
};

/**
 * Builds one card model per project from the ordered row stream: iterate
 * rows in order, one card per project (first row seen wins the card's
 * position), `stage-group` rows populate `stageGroups`, `task` rows populate
 * `tasks` and the header aggregates. Pure: never writes, never reads the
 * store, never mutates the input rows.
 */
export function buildProjectCards(input: ProjectCardModelInput): SidebarCardModel[] {
  const { rows } = input;
  const signalByTaskId = input.signalByTaskId;
  const attentionTaskIds = input.attentionTaskIds;

  const cards: SidebarCardModel[] = [];
  const cardByProjectId = new Map<string, SidebarCardModel>();
  for (const row of rows) {
    let card = cardByProjectId.get(row.projectId);
    if (!card) {
      card = {
        projectId: row.projectId,
        stageGroups: [],
        tasks: [],
        aggregateSignal: null,
        attentionCount: 0,
        visibleTaskCount: 0,
        hue: projectHueName(row.projectId),
      };
      cardByProjectId.set(row.projectId, card);
      cards.push(card);
    }

    if (row.kind === 'stage-group') {
      card.stageGroups.push({ stage: row.stage, label: row.label, count: row.count });
      continue;
    }
    if (row.kind !== 'task') continue;

    card.tasks.push({ projectId: row.projectId, taskId: row.taskId });
    const signal = signalByTaskId?.get(row.taskId) ?? null;
    if (signal !== null && signal !== 'completed') {
      if (
        card.aggregateSignal === null ||
        LIVE_SIGNAL_PRIORITY[signal] < LIVE_SIGNAL_PRIORITY[card.aggregateSignal]
      ) {
        card.aggregateSignal = signal;
      }
    }
    if (attentionTaskIds?.has(row.taskId)) card.attentionCount += 1;
  }

  // Single definition of the visible count: exactly the rendered task rows.
  for (const card of cards) {
    card.visibleTaskCount = card.tasks.length;
  }
  return cards;
}

/**
 * The fixed project-identity palette (spec #120): a stable hash of the
 * project id picks one of these eight hues, implemented with the existing
 * per-theme palette variables, so light/dark contrast comes from the theme
 * tokens.
 */
export const PROJECT_HUES = [
  'jade',
  'blue',
  'purple',
  'amber',
  'cyan',
  'violet',
  'orange',
  'red',
] as const;

export type ProjectHue = (typeof PROJECT_HUES)[number];

/**
 * The CSS tokens one project hue renders with: strong foreground, the
 * identity dot, and `color-mix` soft backgrounds for the card tint, the
 * left rail and the identity chip. All derived from the per-theme
 * `--<hue>-11` / `--<hue>-9` variables — never hardcoded colors.
 */
export type ProjectHueTokens = {
  /** `var(--<hue>-11)`: text and chip letter color. */
  fg: string;
  /** `var(--<hue>-9)`: the identity dot color. */
  dot: string;
  /** Soft card-tint background (`color-mix` of `fg` at 12%). */
  softBg: string;
  /** The card's left rail (`color-mix` of `fg` at 35%). */
  rail: string;
  /** The identity chip background (`color-mix` of `fg` at 14%). */
  chipBg: string;
};

/**
 * djb2-style string hash: deterministic across renders and processes, so a
 * project keeps its hue everywhere the sidebar shows it.
 */
function hashProjectId(projectId: string): number {
  let hash = 5381;
  for (let i = 0; i < projectId.length; i += 1) {
    hash = ((hash * 33) ^ projectId.charCodeAt(i)) >>> 0;
  }
  return hash;
}

/** The stable palette member for a project id. */
export function projectHueName(projectId: string): ProjectHue {
  return PROJECT_HUES[hashProjectId(projectId) % PROJECT_HUES.length];
}

/** The CSS tokens for a project's stable hue (see `ProjectHueTokens`). */
export function projectHue(projectId: string): ProjectHueTokens {
  return hueTokensFor(projectHueName(projectId));
}

function hueTokensFor(hue: ProjectHue): ProjectHueTokens {
  const fg = `var(--${hue}-11)`;
  return {
    fg,
    dot: `var(--${hue}-9)`,
    softBg: `color-mix(in srgb, ${fg} 12%, transparent)`,
    rail: `color-mix(in srgb, ${fg} 35%, transparent)`,
    chipBg: `color-mix(in srgb, ${fg} 14%, transparent)`,
  };
}
