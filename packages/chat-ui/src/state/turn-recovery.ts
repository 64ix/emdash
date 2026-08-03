/**
 * turn-recovery — classification for the turn-level slice of ticket #39's
 * typed recovery cards (spec #18), plus the bounded/redacted diagnostic text
 * behind their "Copy diagnostic" action.
 *
 * ── Deriving from typed evidence, not message strings ────────────────────────
 *
 * `categorizeTurnOutcome` reads only the discriminated `TranscriptTurnOutcome`
 * shape (`packages/core/.../models/turns/turn.ts`) — never a raw error
 * message:
 *   - `cancelled`             -> 'cancellation' (the user's own Stop; see
 *     `acp-chat-stop-controller.ts` and `SessionCell#settleTurn`'s
 *     `outcomeFromStopReason` — the runtime only ever settles this kind when
 *     the agent itself reports `stopReason: 'cancelled'`).
 *   - `interrupted`           -> 'interruption' (the turn was superseded by
 *     something other than the user — process closed, replaced — never
 *     self-initiated; distinct from cancellation on purpose, per the ticket).
 *   - `error`                 -> 'provider'. Every member of
 *     `errorTurnReasonSchema` (`prompt_failed`, `process_closed`,
 *     `spawn_failed`, `initialize_failed`, `new_session_failed`,
 *     `load_session_failed`, `cancel_failed`, `set_config_failed`,
 *     `set_mode_failed`) describes the agent/runtime itself breaking — there
 *     is no typed sub-signal that distinguishes an authentication or
 *     rate-limit failure from any other provider failure at this layer (see
 *     `RecoveryCategory`'s doc in `@/model`). Only `AcpStartError.errorType`
 *     at *session start* can ever produce `'authentication'` — that is a
 *     different failure surface (`AcpChatStore.loadError`), already handled
 *     by the app's existing Sign in/Retry overlay, and out of this function's
 *     domain.
 *   - `done` + `reason: 'max_tokens'` -> 'context'. `max_tokens` is a real ACP
 *     `StopReason` (`packages/core/.../models/session.ts`) meaning the
 *     model's context/token budget was exhausted mid-turn — worth surfacing
 *     even though the turn otherwise "succeeded". Every other `done` reason
 *     (`end_turn`, `max_turn_requests`, `refusal`, `quiesced`) is a normal
 *     completion with nothing to recover from.
 *   - no outcome (still-active, or replayed history with no explicit end)
 *     -> `null`: there is nothing settled to classify, so no card renders
 *     rather than guessing one (mirrors `deriveTurnFooter`'s own rule).
 *
 * ── Why turn/tool cards only ever offer 'copy-diagnostic' ─────────────────────
 *
 * Retry/Edit/Discard all act on ticket #22's recoverable *submission*
 * snapshot — a turn that reached `TranscriptTurnOutcome` already succeeded in
 * reaching the agent, so there is no snapshot left to act on (see this
 * ticket's "reuses the recoverable submission snapshot where applicable").
 * Sign in and change model both require a reachable host control this
 * package cannot see (an auth flow, a model list) — offering them here would
 * be exactly the "broken promise" the ticket warns against. `unknown` is
 * intentionally never produced by `categorizeTurnOutcome`: the discriminated
 * outcome union is exhaustive, so every reachable case above already has an
 * honest, typed label.
 */
import { buildStructuredValue, structuredLines } from '@components/rows/tools/tool/tool-structured';
import type { RecoveryAction, RecoveryCategory, TranscriptTurnOutcome } from '@/model';

/** Turn/tool-outcome cards never offer more than this — see module doc. */
export const RECOVERY_ACTIONS_FOR_TURN: readonly RecoveryAction[] = ['copy-diagnostic'];

/**
 * Classify a settled turn outcome into a recovery category, or `null` when
 * there is nothing actionable to show (no outcome yet, or a plain successful
 * completion). See module doc for the exact evidence behind each branch.
 */
export function categorizeTurnOutcome(
  outcome: TranscriptTurnOutcome | undefined
): RecoveryCategory | null {
  if (!outcome) return null;
  switch (outcome.kind) {
    case 'cancelled':
      return 'cancellation';
    case 'interrupted':
      return 'interruption';
    case 'error':
      return 'provider';
    case 'done':
      return outcome.reason === 'max_tokens' ? 'context' : null;
  }
}

/**
 * Whether a settled outcome's category is worth raising the sticky attention
 * indicator for. A self-initiated cancellation needs no recovery — the user
 * already knows, since they just clicked Stop — so it is deliberately
 * excluded, matching ticket #33's existing `deriveErrorAttentionSources`
 * behavior (which this function's app-layer counterpart in
 * `acp-attention-queue.ts` preserves; see that file for why the predicate is
 * duplicated locally there instead of imported from this package).
 */
export function isTurnRecoveryAttentionWorthy(category: RecoveryCategory | null): boolean {
  return category !== null && category !== 'cancellation';
}

/**
 * Bounded, redacted plain-text diagnostic for a settled turn's recovery card —
 * reuses ticket #30/#31's structured-value builder (`buildStructuredValue`/
 * `structuredLines`) so this diagnostic gets the exact same cycle/fan-out/
 * depth/huge-string caps and secret redaction as the generic tool inspector,
 * rather than a bespoke serializer. `TranscriptTurnOutcome` itself carries no
 * free-text message (see module doc), so no field here is expected to carry a
 * secret today — reusing the shared builder is still correct so a future
 * outcome field with real message content is redacted/bounded automatically,
 * with no renderer change required.
 */
export function buildTurnRecoveryDiagnostic(input: {
  category: RecoveryCategory;
  turnId: string;
  itemId?: string;
  outcome: TranscriptTurnOutcome;
}): string {
  const tree = buildStructuredValue({
    category: input.category,
    turnId: input.turnId,
    ...(input.itemId ? { itemId: input.itemId } : {}),
    outcomeKind: input.outcome.kind,
    ...(input.outcome.reason ? { reason: input.outcome.reason } : {}),
  });
  return structuredLines(tree).join('\n');
}
