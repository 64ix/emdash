/**
 * acp-recovery-card — the app-layer half of ticket #39's typed recovery
 * cards (spec #18): failed-submission and session-load classification,
 * their executable action sets, and a bounded/redacted "Copy diagnostic"
 * payload. `packages/chat-ui`'s `state/turn-recovery.ts` owns the other half
 * (turn/tool-outcome classification) — see that module's doc for why the two
 * halves cannot share a runtime classifier function across the package
 * boundary, only the `RecoveryCategory`/`RecoveryAction` *type* vocabulary
 * (imported here with `import type` only, which TypeScript always erases —
 * a real runtime `import` of `@emdash/chat-ui` from this file would break
 * the app's `node` vitest project the same way `acp-permission-presentation.ts`'s
 * doc already documents: the chat-ui bundle touches `document` at import
 * time, and this module (like that one) must stay usable from a plain
 * React/MobX seam and unit-testable without a DOM).
 *
 * ── Deriving from typed evidence, not message strings ────────────────────────
 *
 * `categorizeSubmissionFailure` reads only `FailedAcpSubmission.errorKind`
 * (`acp-submission-recovery.ts`'s typed tag, preserved from the original
 * `Result` error's `.type` — never `.error`, the human-readable message).
 * Every recognized `errorKind` describes the local session/runtime
 * connectivity boundary failing (the prompt never even reached a settled
 * turn), so all of them map to 'provider' — there is no typed sub-signal
 * that distinguishes an authentication or rate-limit failure at the
 * submission layer either. `'unknown'` is the one submission-failure shape
 * with genuinely no typed evidence (an opaque thrown exception) — see
 * `SubmissionFailureKind`'s doc for why that, and only that, case yields it.
 *
 * `categorizeLoadError` reads `AcpChatStore.loadError.kind`, which is itself
 * derived from `AcpStartError.errorType` (a real `AcpRuntimeError` tag from
 * session start/resume) — see `acp-chat-store.ts`. This is the *only* place
 * in the whole recovery-card system that can ever classify 'authentication',
 * because `auth_required` is exclusively a session-start failure, never a
 * settled turn outcome (see `turn-recovery.ts`'s doc). Neither function here
 * ever produces 'rate-limit' — no typed evidence for it exists anywhere in
 * this codebase's ACP layer (see `RecoveryCategory`'s doc in `@emdash/chat-ui`).
 *
 * ── Why submission cards, but not load-error cards, get retry/edit/discard ──
 *
 * A failed submission still holds ticket #22's recoverable snapshot — Retry/
 * Edit/Discard act on exactly that, and are therefore always executable for
 * every `FailedAcpSubmission` regardless of category. A session-load failure
 * has no submission snapshot at all (no prompt was ever captured); its
 * Sign-in/Retry gating is already implemented directly in `AcpChatPanel`
 * (gated on a genuinely reachable `cliAuthMethod`) — `recoveryActionsForLoadError`
 * exists to make that same, already-correct gating rule a pure, independently
 * testable function, not to replace the existing render path.
 */
import type { RecoveryAction, RecoveryCategory } from '@emdash/chat-ui';
import type { AcpLoadError } from './acp-chat-store';
import { summarizePermissionText } from './acp-permission-presentation';
import type { FailedAcpSubmission, SubmissionFailureKind } from './acp-submission-recovery';

/** Max characters kept in the diagnostic's bounded message field — see `buildSubmissionRecoveryDiagnostic`. */
export const RECOVERY_DIAGNOSTIC_MESSAGE_MAX_CHARS = 2000;

/**
 * A failed submission always has ticket #22's recoverable snapshot behind it
 * — Retry/Edit/Discard are executable for every category. Sign in and
 * change model are never offered here: neither a reachable auth flow nor a
 * model-choice control is visible at the submission layer (see module doc).
 */
export const RECOVERY_ACTIONS_FOR_SUBMISSION: readonly RecoveryAction[] = [
  'retry',
  'edit',
  'discard',
  'copy-diagnostic',
];

/**
 * Classify a failed submission's typed evidence into a recovery category.
 * See module doc for why every recognized `errorKind` maps to 'provider' and
 * only an opaque thrown exception ('unknown' `errorKind`) yields 'unknown'.
 */
export function categorizeSubmissionFailure(errorKind: SubmissionFailureKind): RecoveryCategory {
  return errorKind === 'unknown' ? 'unknown' : 'provider';
}

/**
 * Bounded, redacted plain-text diagnostic for a failed submission's "Copy
 * diagnostic" action. Reuses `acp-permission-presentation.ts`'s
 * `summarizePermissionText` — the same redact-before-bound helper already
 * backing every other copyable field in this folder (permission command/
 * content/diff text) — rather than a bespoke serializer, per this ticket's
 * "must reuse that redaction/bounding machinery" guardrail.
 *
 * Truncation is never silent: when the (already redacted) message exceeds
 * `RECOVERY_DIAGNOSTIC_MESSAGE_MAX_CHARS`, the copied text says so explicitly
 * — a silently truncated "Copy diagnostic" was itself treated as a defect
 * earlier in this batch (see the diff/permission Copy actions' own
 * fullText/truncated convention).
 */
export function buildSubmissionRecoveryDiagnostic(
  submission: FailedAcpSubmission,
  category: RecoveryCategory
): string {
  const message = summarizePermissionText(submission.error, RECOVERY_DIAGNOSTIC_MESSAGE_MAX_CHARS);
  const lines = [
    `Category: ${category}`,
    `Submission kind: ${submission.kind}`,
    `Failure kind: ${submission.errorKind}`,
    `Message: ${message.text}${message.truncated ? ' … (truncated)' : ''}`,
  ];
  return lines.join('\n');
}

/**
 * Classify a session-load failure — the only path to 'authentication' in
 * the whole recovery-card system (see module doc). Every other load error
 * (spawn/initialize/new-session/provider-unsupported/invalid-state, all
 * flattened to `AcpLoadError`'s `'generic'` kind by `acp-chat-store.ts`) is
 * 'provider': each describes the local runtime/process failing to start,
 * never an authentication or rate-limit signal.
 */
export function categorizeLoadError(loadError: AcpLoadError): RecoveryCategory {
  return loadError.kind === 'auth_required' ? 'authentication' : 'provider';
}

/**
 * The executable action set for a session-load failure — mirrors
 * `AcpChatPanel`'s existing Sign in/Retry gating exactly (see module doc):
 * Sign in only when a CLI login method is genuinely reachable for the
 * active provider, Retry always. Never Edit/Discard (no submission snapshot
 * exists yet) and never change-model (a session that never started exposes
 * no model list to switch between).
 */
export function recoveryActionsForLoadError(
  loadError: AcpLoadError,
  hasReachableSignIn: boolean
): readonly RecoveryAction[] {
  if (loadError.kind === 'auth_required' && hasReachableSignIn) return ['sign-in', 'retry'];
  return ['retry'];
}
