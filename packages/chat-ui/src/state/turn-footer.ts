/**
 * turn-footer — pure derivation of the compact metadata footer shown after
 * each settled transcript turn (ticket #38, spec #18).
 *
 * Every committed turn with a recorded outcome (`done` / `cancelled` /
 * `error` / `interrupted`) gets exactly one footer row: a status label, a
 * turn-scoped Copy action, and — only when the runtime can genuinely
 * attribute them — duration and context/cost. Active (still-streaming)
 * turns never get a footer; the existing streaming/"Working…" presentation
 * (see `components/rows/working/working.def.tsx`) already carries the
 * active-turn narrative and is untouched by this module.
 *
 * Status reuses `statusForOutcome` from `state/turn-status.ts` so the footer
 * and the transcript outline (#34) can never disagree about what a turn was.
 *
 * ── Why `durationMs` / `context` / `cost` are never populated today ─────────
 *
 * `TranscriptTurn` (see `packages/core/src/acp/models/turns/turn.ts`) carries
 * no start/settle timestamp — only two ToolNode-derived presentation types
 * (`ChatThinking`, `ChatExecute`) carry any timing at all, and that is a
 * partial, sub-operation-only signal (file reads/edits, searches, fetches,
 * and MCP calls carry no timing whatsoever). Summing or spanning those
 * partial timestamps and presenting the result as "the turn's duration"
 * would silently *undercount* most turns and render a narrative that can be
 * wrong — worse than showing nothing (see ticket #38's guardrails, and the
 * identical decision already made for `ChatToolCall.durationMs` on generic
 * search/fetch/MCP/unknown tool calls in ticket #30). The same reasoning
 * applies to context/cost: `SessionUsage` (`packages/core/.../config.ts`) is
 * a cumulative session-wide total, never scoped to a single turn, so
 * attributing the running total to "this turn" would misrepresent it as
 * turn-specific spend.
 *
 * `TurnFooterData` still declares these fields (see `model.ts`) so a future,
 * genuine per-turn producer (e.g. an additive `TranscriptTurn.startedAt` /
 * `settledAt` timestamp recorded by the reducer, mirroring how thinking
 * segments already record `startedAt`) has somewhere to plug in without a
 * renderer change. `deriveTurnFooter` intentionally never sets them.
 */

import type {
  TranscriptItem,
  TranscriptMessage,
  TranscriptTurn,
  TranscriptTurnOutcome,
  TurnFooterCost,
  TurnFooterContext,
  TurnFooterData,
  TurnFooterStatus,
} from '@/model';
import { statusForOutcome } from './turn-status';

// ── Status label ──────────────────────────────────────────────────────────────

/**
 * Human-readable status line for a settled turn's exact outcome kind.
 *
 * Deliberately more specific than the coarse `TurnFooterStatus` grouping
 * (which folds 'interrupted' into 'error' for visual/status purposes) —
 * the label keeps "interrupted" distinct from "failed" so a user can tell
 * "the process died mid-turn" from "the agent reported an error".
 */
function buildStatusLabel(outcome: TranscriptTurnOutcome): string {
  const reason = outcome.reason ? ` (${outcome.reason})` : '';
  switch (outcome.kind) {
    case 'cancelled':
      return `Turn cancelled${reason}`;
    case 'error':
      return `Turn failed${reason}`;
    case 'interrupted':
      return `Turn interrupted${reason}`;
    case 'done':
      return `Turn completed${reason}`;
    default:
      return `Turn finished${reason}`;
  }
}

/** Narrow the shared 4-value narrative status to the 3 values a settled turn can have. */
function toFooterStatus(outcome: TranscriptTurnOutcome): TurnFooterStatus {
  const status = statusForOutcome(outcome);
  return status === 'current' ? 'completed' : status;
}

// ── Copy text ─────────────────────────────────────────────────────────────────

function isAssistantMessage(item: TranscriptItem): item is TranscriptMessage {
  return item.kind === 'message' && item.role === 'assistant';
}

/** The turn's own final assistant reply, when it produced one with real text. */
function lastAssistantReply(items: readonly TranscriptItem[]): string | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (isAssistantMessage(item) && item.text.trim().length > 0) return item.text;
  }
  return undefined;
}

/**
 * Plain-text payload for the footer's Copy action, scoped to exactly what the
 * footer summarizes: the status line, plus the turn's final assistant reply
 * when it produced one.
 */
function buildCopyText(statusLabel: string, items: readonly TranscriptItem[]): string {
  const reply = lastAssistantReply(items);
  return reply ? `${statusLabel}\n\n${reply}` : statusLabel;
}

// ── Formatting helpers (forward-compatible; see module doc) ──────────────────

/** `"Thought for Ns"`-style rounding, mirrored from `thinking.def.tsx`. */
export function formatFooterDuration(durationMs: number): string {
  if (durationMs < 1000) return 'under a second';
  return `${Math.floor(durationMs / 1000)}s`;
}

export function formatFooterContext(context: TurnFooterContext): string {
  const pct =
    context.contextSize > 0 ? Math.round((context.contextUsed / context.contextSize) * 100) : 0;
  return `${pct}% context`;
}

export function formatFooterCost(cost: TurnFooterCost): string {
  return `${cost.currency} ${cost.amount.toFixed(4)}`;
}

// ── deriveTurnFooter ──────────────────────────────────────────────────────────

/**
 * Derive the compact metadata footer for one settled turn.
 *
 * Returns `null` when the turn has no recorded outcome (e.g. replayed
 * history with no explicit end) — there is no honest status to show, so no
 * footer renders rather than guessing one.
 */
export function deriveTurnFooter(turn: TranscriptTurn): TurnFooterData | null {
  if (!turn.outcome) return null;
  const statusLabel = buildStatusLabel(turn.outcome);
  return {
    status: toFooterStatus(turn.outcome),
    statusLabel,
    copyText: buildCopyText(statusLabel, turn.items),
    // durationMs / context / cost intentionally omitted — see module doc.
  };
}
