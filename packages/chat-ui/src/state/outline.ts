/**
 * deriveTranscriptOutline — pure derivation of a transcript outline: one
 * entry per user prompt and one per assistant/agent turn, keyed by the same
 * stable canonical item ids the virtualizer already uses (`RenderUnit.itemId`
 * — see `core/units.ts`'s `unit()` helper). Callers pass an entry's `itemId`
 * straight to `ChatView.scrollToItem()`, which jumps through the existing
 * virtualizer/scroll-anchor seam even when the destination row is off-DOM —
 * no manual `scrollTop` math here.
 *
 * Ticket #34 (spec #18): "Navigate turns through a transcript outline".
 *
 * A user-initiated `TranscriptTurn` bundles the prompt message and the
 * agent's reply into the same turn (see ChatRoot's activeTurn synthesis in
 * `ChatRoot.tsx`). This module splits that back into up to two outline
 * entries so prompts and assistant turns can be listed and jumped to
 * independently:
 *
 *   - a `'prompt'` entry anchored on the turn's leading user message, when
 *     the turn was user-initiated;
 *   - a `'turn'` entry anchored on the first item produced after that prompt
 *     (or, for agent-initiated turns with no leading prompt, the turn's own
 *     first item) — only when the turn actually has such items.
 *
 * Recomputed fresh from `committedTurns`/`activeTurn`/`pendingPrompt` on every
 * call — never incrementally patched — so prepending older history (see
 * `AcpHistoryPagination` / `ChatView.loadOlder`) can never duplicate or
 * reorder already-derived entries: the same stable turn/item ids simply
 * reappear at the front of a freshly built array.
 */

import type { TranscriptItem, TranscriptMessage, TranscriptTurn } from '@/model';
import type { PendingPrompt } from './session-state';
import type { TurnStatus } from './transcript';

export type OutlineEntryStatus = 'current' | 'completed' | 'error' | 'cancelled';

/** `'prompt'` — a user message. `'turn'` — the assistant/agent activity that followed it. */
export type OutlineEntryRole = 'prompt' | 'turn';

export type OutlineEntry = {
  /**
   * Canonical `ChatItem` id this entry anchors to — matches `RenderUnit.itemId`,
   * so it can be passed directly to `ChatView.scrollToItem()`.
   */
  readonly itemId: string;
  /** The `TranscriptTurn.id` this entry was derived from. */
  readonly turnId: string;
  readonly role: OutlineEntryRole;
  /** Bounded, single-line preview text (see `PREVIEW_MAX_LENGTH`). */
  readonly preview: string;
  readonly status: OutlineEntryStatus;
};

const PREVIEW_MAX_LENGTH = 80;

function boundedPreview(text: string): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= PREVIEW_MAX_LENGTH) return collapsed;
  return `${collapsed.slice(0, PREVIEW_MAX_LENGTH - 1)}…`;
}

function isUserMessage(item: TranscriptItem): item is TranscriptMessage {
  return item.kind === 'message' && item.role === 'user';
}

function isAssistantMessage(item: TranscriptItem): item is TranscriptMessage {
  return item.kind === 'message' && item.role === 'assistant';
}

/**
 * Fallback single-line label for a 'turn' entry's preview when no assistant
 * message is present yet (still a tool call, or streaming has not produced
 * text). Every `ToolNode` variant carries either `title` (tool calls) or
 * `label` (tool groups) — see `packages/core/src/acp/models/turns/tool-calls.ts`.
 */
function itemPreviewLabel(item: TranscriptItem): string {
  if (item.kind === 'message') return boundedPreview(item.text);
  if (item.kind === 'thinking') return 'Thinking…';
  if (item.kind === 'tool-group') return boundedPreview(item.label);
  return boundedPreview(item.title);
}

/** Preview for a 'turn' entry: prefer the first assistant message's text. */
function turnPreview(items: readonly TranscriptItem[]): string {
  const message = items.find(isAssistantMessage);
  if (message) return boundedPreview(message.text);
  const first = items[0];
  return first ? itemPreviewLabel(first) : '';
}

/** Map a settled turn's outcome to the outline's four-state status vocabulary. */
function statusForOutcome(outcome: TranscriptTurn['outcome']): OutlineEntryStatus {
  if (!outcome || outcome.kind === 'done') return 'completed';
  if (outcome.kind === 'cancelled') return 'cancelled';
  // 'error' and 'interrupted' both represent an abnormal, non-user-cancelled
  // stop; the outline only distinguishes explicit cancellation from failure.
  return 'error';
}

/** Map the live `TurnStatus` (see `state/transcript.ts`) for the active turn. */
function activeStatus(turnStatus: TurnStatus): OutlineEntryStatus {
  if (turnStatus === 'cancelled') return 'cancelled';
  if (turnStatus === 'done') return 'completed';
  return 'current';
}

function pushEntriesForTurn(
  turn: TranscriptTurn,
  status: OutlineEntryStatus,
  out: OutlineEntry[]
): void {
  const items = turn.items;
  const first = items[0];
  const hasLeadingPrompt = turn.initiator === 'user' && !!first && isUserMessage(first);
  const rest = hasLeadingPrompt ? items.slice(1) : items;

  if (hasLeadingPrompt && first) {
    out.push({
      itemId: first.id,
      turnId: turn.id,
      role: 'prompt',
      preview: boundedPreview(first.text),
      status,
    });
  }

  const firstOfRest = rest[0];
  if (firstOfRest) {
    out.push({
      itemId: firstOfRest.id,
      turnId: turn.id,
      role: 'turn',
      preview: turnPreview(rest),
      status,
    });
  }
}

/**
 * Derive the full transcript outline from canonical chat-ui state.
 *
 * `committedTurns`/`activeTurn`/`turnStatus` mirror `TranscriptState` (see
 * `state/transcript.ts`); `pendingPrompt` mirrors `ChatSessionSnapshot.pendingPrompt`
 * (see `state/session-state.ts`) — the same three-way split `ChatRoot.tsx`'s
 * `activeUnits` memo already reconciles for rendering, applied here to build
 * the equivalent outline entries instead of render units.
 */
export function deriveTranscriptOutline(
  committedTurns: readonly TranscriptTurn[],
  activeTurn: TranscriptTurn | null,
  turnStatus: TurnStatus,
  pendingPrompt: PendingPrompt | null
): OutlineEntry[] {
  const out: OutlineEntry[] = [];

  for (const turn of committedTurns) {
    pushEntriesForTurn(turn, statusForOutcome(turn.outcome), out);
  }

  if (activeTurn) {
    pushEntriesForTurn(activeTurn, activeStatus(turnStatus), out);
  } else if (pendingPrompt) {
    // Mirrors ChatRoot's synthetic pending-prompt turn (see ChatRoot.tsx's
    // `activeUnits` memo): a prompt sent but not yet acknowledged by the agent.
    out.push({
      itemId: pendingPrompt.id,
      turnId: `pending:${pendingPrompt.id}:turn`,
      role: 'prompt',
      preview: boundedPreview(pendingPrompt.text),
      status: 'current',
    });
  }

  return out;
}
