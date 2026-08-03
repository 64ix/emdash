/**
 * acp-attention-queue — ticket #33 (spec #18).
 *
 * Projects three independent "the agent needs the user" signals — outstanding
 * permission requests (ticket #32), submissions that failed to send (ticket
 * #22), and actionable turn/tool errors from the most recent activity — into
 * ONE deterministically ordered, deduplicated attention queue. Also declares
 * a `'question'` item kind as a typed extension point for a future
 * structured-question producer; nothing in this ticket ever constructs one
 * (see the ticket's "the model accepts a typed question item, but no
 * synthetic provider question lifecycle is introduced in this ticket"
 * acceptance criterion) but `buildAttentionQueue` already orders/dedupes it
 * correctly, proven by this module's own tests.
 *
 * Framework-free (no MobX/DOM/`@emdash/chat-ui` runtime import — types only)
 * so every function here is unit-testable from the `node` Vitest project.
 * `AcpChatStore.attentionQueue` follows the resynced-field convention
 * documented on `outline`/`changesFootprint`/`newEventCount`: it is an
 * explicit `observable.ref` field recomputed at every point one of these
 * three sources can change, never a lazy `computed` — see that field's doc
 * for why a `computed` here would go stale the same way ticket #34's outline
 * did before it was fixed.
 *
 * ── Why turn/tool errors are scoped to "the latest activity" ────────────────
 *
 * A turn's `outcome` and a tool call's `status` are durable — once a turn
 * settles as `'error'`, it stays that way in history forever, and the
 * conversation keeps going. Surfacing every error a long session ever had
 * would turn the sticky indicator into a permanent, ever-growing badge for
 * problems the user has already moved past — worse than not having one.
 * `deriveErrorAttentionSources` therefore only scans the single most
 * recently committed turn plus the in-flight active turn (if any): the
 * region a user who just scrolled away from the tail is most likely to have
 * missed, and the same region the `atBottom` reading-position signal (ticket
 * #37) already tracks. Older, already-passed errors are not "actionable"
 * anymore in the sense this queue cares about — this is a deliberate scoping
 * decision, not an oversight (see the ticket's PR notes).
 *
 * ── Why composer targets are always "visible" ────────────────────────────────
 *
 * The composer (and everything docked above it, including the existing
 * failed-submission banner and permission band) is a fixed footer — never
 * virtualized or scrolled away. `isAttentionTargetVisible` treats a
 * `'composer'` target as always visible for that reason: there is nothing to
 * scroll back to, so a failed submission never triggers the sticky
 * "offscreen" indicator on its own (it still counts toward the queue's total
 * and can still be reached through traversal).
 */

import type {
  TranscriptItem,
  TranscriptTurn,
  TranscriptTurnOutcome,
} from '@emdash/core/acp/client';
import { sanitizePermissionTitle } from './acp-permission-presentation';

// ── Model ─────────────────────────────────────────────────────────────────────

export type AttentionItemKind = 'permission' | 'question' | 'failed-submission' | 'error';

/** Where activating an attention item should land. */
export type AttentionTarget =
  | { readonly kind: 'transcript'; readonly itemId: string }
  | { readonly kind: 'composer' };

export interface AttentionItem {
  /** Globally unique and stable across recomputation — see the per-kind id prefix in `buildAttentionQueue`. */
  readonly id: string;
  readonly kind: AttentionItemKind;
  /** Bounded, single-line, already-sanitized summary for the sticky indicator. */
  readonly summary: string;
  readonly target: AttentionTarget;
}

export interface PermissionAttentionSource {
  readonly requestId: string;
  readonly itemId: string;
  /** Already-sanitized (e.g. `AcpChatStore.permissionQueue[n].title`). */
  readonly summary: string;
}

/** Typed extension point — see module doc. No producer constructs this today. */
export interface QuestionAttentionSource {
  readonly id: string;
  readonly itemId: string;
  readonly summary: string;
}

export interface FailedSubmissionAttentionSource {
  readonly localId: string;
  readonly summary: string;
}

export interface ErrorAttentionSource {
  readonly id: string;
  readonly itemId: string;
  readonly summary: string;
}

export interface AttentionQueueSources {
  readonly permissions: readonly PermissionAttentionSource[];
  /** Typed extension point (see module doc); defaults to empty. */
  readonly questions?: readonly QuestionAttentionSource[];
  readonly failedSubmissions: readonly FailedSubmissionAttentionSource[];
  readonly errors: readonly ErrorAttentionSource[];
}

// ── buildAttentionQueue ───────────────────────────────────────────────────────

function toItems(sources: AttentionQueueSources): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const p of sources.permissions) {
    items.push({
      id: `permission:${p.requestId}`,
      kind: 'permission',
      summary: p.summary,
      target: { kind: 'transcript', itemId: p.itemId },
    });
  }
  for (const q of sources.questions ?? []) {
    items.push({
      id: `question:${q.id}`,
      kind: 'question',
      summary: q.summary,
      target: { kind: 'transcript', itemId: q.itemId },
    });
  }
  for (const f of sources.failedSubmissions) {
    items.push({
      id: `failed-submission:${f.localId}`,
      kind: 'failed-submission',
      summary: f.summary,
      target: { kind: 'composer' },
    });
  }
  for (const e of sources.errors) {
    items.push({
      id: `error:${e.id}`,
      kind: 'error',
      summary: e.summary,
      target: { kind: 'transcript', itemId: e.itemId },
    });
  }
  return items;
}

/**
 * Build the ordered, deduplicated attention queue.
 *
 * Ordering is entirely positional — permissions, then questions, then failed
 * submissions, then errors, each group in the caller's own (already
 * deterministic) order — rather than a sort with a comparator, so two items
 * introduced in the same recomputation always land in one predictable order
 * with no dependency on insertion timing or tie-break rules. A permission
 * (or, in future, a structured question) blocks the agent outright; a failed
 * submission risks losing the user's own message; a settled turn/tool error
 * is a diagnostic worth inspecting but nothing is actively blocked on it.
 *
 * Defends against a duplicate `id` reappearing across sources (e.g. a
 * producer bug, or the same request surfacing through two paths) by keeping
 * only the first occurrence — the same item must never appear twice.
 */
export function buildAttentionQueue(sources: AttentionQueueSources): AttentionItem[] {
  const seen = new Set<string>();
  const out: AttentionItem[] = [];
  for (const item of toItems(sources)) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

// ── Visibility ────────────────────────────────────────────────────────────────

/**
 * Whether an attention item's target is already sufficiently visible without
 * activating it. `atBottom` is the same signal `AcpChatStore.setAtBottom`
 * already tracks for ticket #37's reading-position feature — see the module
 * doc for why that is an honest proxy for "is the latest activity visible"
 * given this module's scoping of error sources to the latest turn(s).
 */
export function isAttentionTargetVisible(target: AttentionTarget, atBottom: boolean): boolean {
  return target.kind === 'composer' || atBottom;
}

// ── deriveErrorAttentionSources ───────────────────────────────────────────────

const SUMMARY_MAX_CHARS = 80;

function boundedSanitizedSummary(text: string): string {
  const clean = sanitizePermissionTitle(text).replace(/\s+/g, ' ').trim();
  if (clean.length <= SUMMARY_MAX_CHARS) return clean;
  return `${clean.slice(0, SUMMARY_MAX_CHARS - 1)}…`;
}

function isTurnLevelError(outcome: TranscriptTurnOutcome | undefined): boolean {
  return outcome?.kind === 'error' || outcome?.kind === 'interrupted';
}

/** Mirrors `turn-footer.ts`'s label choice so this summary never contradicts the turn's own footer. */
function turnErrorSummary(outcome: TranscriptTurnOutcome): string {
  const base = outcome.kind === 'interrupted' ? 'Turn interrupted' : 'Turn failed';
  return outcome.reason ? `${base} (${outcome.reason})` : base;
}

/**
 * A top-level transcript item's tool-error summary, or `null` when the item
 * is not a tool node or did not error. Only *top-level* `turn.items` entries
 * are considered (never nested `ToolNode.children`) — `chatState.transcript`'s
 * item-id map (see `state/transcript.ts#rebuildItemMap`) only indexes
 * top-level items, so a nested child's own id can never be resolved by
 * `scrollToTranscriptItem`. A `'tool-group'` whose own top-level status is
 * `'error'` already reflects an errored child in aggregate — this is the
 * addressable, jumpable row for that failure, not a second signal alongside it.
 */
function topLevelToolErrorSummary(item: TranscriptItem): string | null {
  if (item.kind === 'message' || item.kind === 'thinking' || item.kind === 'resource-link') {
    return null;
  }
  if (item.status !== 'error') return null;
  const label = item.kind === 'tool-group' ? item.label : item.title;
  return `Tool failed: ${boundedSanitizedSummary(label)}`;
}

function collectToolErrors(turn: TranscriptTurn, out: ErrorAttentionSource[]): void {
  for (const item of turn.items) {
    const summary = topLevelToolErrorSummary(item);
    if (summary) out.push({ id: `tool:${item.id}`, itemId: item.id, summary });
  }
}

/**
 * Derive actionable turn/tool error sources from the latest activity — see
 * the module doc for why this is scoped to `lastCommittedTurn`/`activeTurn`
 * rather than the full transcript. `activeTurn` never carries a settled
 * `outcome` (only committed turns do — see `state/transcript.ts`'s
 * `ActiveTurn.commit`), so only `lastCommittedTurn` is checked for a
 * turn-level error; both turns are scanned for top-level tool errors, since a
 * tool call can fail mid-turn independent of how the turn itself eventually
 * settles.
 */
export function deriveErrorAttentionSources(
  lastCommittedTurn: TranscriptTurn | null,
  activeTurn: TranscriptTurn | null
): ErrorAttentionSource[] {
  const out: ErrorAttentionSource[] = [];
  if (lastCommittedTurn) {
    if (isTurnLevelError(lastCommittedTurn.outcome)) {
      const anchor = lastCommittedTurn.items[0];
      if (anchor) {
        out.push({
          id: `turn:${lastCommittedTurn.id}`,
          itemId: anchor.id,
          summary: turnErrorSummary(lastCommittedTurn.outcome!),
        });
      }
    }
    collectToolErrors(lastCommittedTurn, out);
  }
  if (activeTurn) collectToolErrors(activeTurn, out);
  return out;
}
