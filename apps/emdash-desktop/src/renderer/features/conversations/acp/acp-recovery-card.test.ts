import { describe, expect, it } from 'vitest';
import type { AcpLoadError } from './acp-chat-store';
import {
  buildSubmissionRecoveryDiagnostic,
  categorizeLoadError,
  categorizeSubmissionFailure,
  RECOVERY_ACTIONS_FOR_SUBMISSION,
  RECOVERY_DIAGNOSTIC_MESSAGE_MAX_CHARS,
  recoveryActionsForLoadError,
} from './acp-recovery-card';
import type { FailedAcpSubmission } from './acp-submission-recovery';
import { createSubmissionSnapshot } from './acp-submission-recovery';

function submission(
  error: string,
  errorKind: FailedAcpSubmission['errorKind']
): FailedAcpSubmission {
  return {
    ...createSubmissionSnapshot({
      localId: 'submission:1',
      kind: 'direct',
      text: 'hello',
      attachments: [],
    }),
    error,
    errorKind,
  };
}

// ── categorizeSubmissionFailure — typed evidence only ─────────────────────────

describe('categorizeSubmissionFailure', () => {
  it.each([
    'session-unavailable',
    'conversation_not_found',
    'invalid_state',
    'prompt_failed',
  ] as const)(
    'classifies %s as provider — a local session/runtime connectivity failure',
    (errorKind) => {
      expect(categorizeSubmissionFailure(errorKind)).toBe('provider');
    }
  );

  it('classifies unknown as unknown — the one shape with no typed evidence at all', () => {
    expect(categorizeSubmissionFailure('unknown')).toBe('unknown');
  });

  it('never produces authentication or rate-limit — no typed submission-level evidence exists for them', () => {
    const kinds: FailedAcpSubmission['errorKind'][] = [
      'session-unavailable',
      'conversation_not_found',
      'invalid_state',
      'prompt_failed',
      'unknown',
    ];
    for (const kind of kinds) {
      const category = categorizeSubmissionFailure(kind);
      expect(category).not.toBe('authentication');
      expect(category).not.toBe('rate-limit');
    }
  });
});

// ── RECOVERY_ACTIONS_FOR_SUBMISSION — actions appear only when executable ────

describe('RECOVERY_ACTIONS_FOR_SUBMISSION', () => {
  it('always offers retry, edit, discard, and copy-diagnostic — #22 guarantees every entry supports them', () => {
    expect(RECOVERY_ACTIONS_FOR_SUBMISSION).toEqual([
      'retry',
      'edit',
      'discard',
      'copy-diagnostic',
    ]);
  });

  it('never offers sign-in or change-model — neither an auth flow nor a model list is reachable here', () => {
    expect(RECOVERY_ACTIONS_FOR_SUBMISSION).not.toContain('sign-in');
    expect(RECOVERY_ACTIONS_FOR_SUBMISSION).not.toContain('change-model');
  });
});

// ── buildSubmissionRecoveryDiagnostic — redacted and bounded, never silently ──

describe('buildSubmissionRecoveryDiagnostic', () => {
  it('includes the category, submission kind, and failure kind', () => {
    const text = buildSubmissionRecoveryDiagnostic(
      submission('ACP session is not connected', 'session-unavailable'),
      'provider'
    );
    expect(text).toContain('Category: provider');
    expect(text).toContain('Submission kind: direct');
    expect(text).toContain('Failure kind: session-unavailable');
    expect(text).toContain('ACP session is not connected');
  });

  // ── The two exact leak shapes fixed earlier in this batch (redact.ts) ──────

  it('fully redacts a JSON-embedded secret with an escaped quote mid-value (the "\\"-escaped-quote leak)', () => {
    const text = buildSubmissionRecoveryDiagnostic(
      submission('Request failed: {"apiKey": "abc\\"def"}', 'prompt_failed'),
      'provider'
    );
    expect(text).not.toContain('abc');
    expect(text).not.toContain('def');
    expect(text).toContain('[REDACTED]');
  });

  it('never lets a raw control character in a malformed value swallow a later secret', () => {
    const raw = '{"apiKey":"abc\ndef no closing here ... "token":"realsecret123"}';
    const text = buildSubmissionRecoveryDiagnostic(submission(raw, 'prompt_failed'), 'provider');
    expect(text).not.toContain('realsecret123');
    expect(text).toContain('"token":"[REDACTED]"');
  });

  it('bounds a very long message and makes the truncation visible rather than silent', () => {
    const huge = 'x'.repeat(RECOVERY_DIAGNOSTIC_MESSAGE_MAX_CHARS + 500);
    const text = buildSubmissionRecoveryDiagnostic(submission(huge, 'prompt_failed'), 'provider');
    expect(text).toContain('(truncated)');
    // The bounded text itself must actually be shorter than the raw message —
    // otherwise "(truncated)" would be a lie.
    expect(text.length).toBeLessThan(huge.length);
  });

  it('does not mark a short message as truncated', () => {
    const text = buildSubmissionRecoveryDiagnostic(
      submission('short message', 'prompt_failed'),
      'provider'
    );
    expect(text).not.toContain('truncated');
  });
});

// ── categorizeLoadError — the only path to 'authentication' ───────────────────

describe('categorizeLoadError', () => {
  it('classifies auth_required as authentication', () => {
    const loadError: AcpLoadError = { kind: 'auth_required', message: 'sign in required' };
    expect(categorizeLoadError(loadError)).toBe('authentication');
  });

  it('classifies every other load error as provider', () => {
    const loadError: AcpLoadError = { kind: 'generic', message: 'spawn failed' };
    expect(categorizeLoadError(loadError)).toBe('provider');
  });
});

// ── recoveryActionsForLoadError — mirrors AcpChatPanel's existing gating ──────

describe('recoveryActionsForLoadError', () => {
  it('offers sign-in only when a CLI login method is genuinely reachable', () => {
    const loadError: AcpLoadError = { kind: 'auth_required', message: 'sign in required' };
    expect(recoveryActionsForLoadError(loadError, true)).toEqual(['sign-in', 'retry']);
    expect(recoveryActionsForLoadError(loadError, false)).toEqual(['retry']);
  });

  it('never offers sign-in for a non-auth load error, even if a sign-in method happens to be reachable', () => {
    const loadError: AcpLoadError = { kind: 'generic', message: 'spawn failed' };
    expect(recoveryActionsForLoadError(loadError, true)).toEqual(['retry']);
  });

  it('never offers edit, discard, or change-model — no submission snapshot or model list exists yet', () => {
    const authError: AcpLoadError = { kind: 'auth_required', message: 'sign in required' };
    const genericError: AcpLoadError = { kind: 'generic', message: 'spawn failed' };
    for (const actions of [
      recoveryActionsForLoadError(authError, true),
      recoveryActionsForLoadError(genericError, true),
    ]) {
      expect(actions).not.toContain('edit');
      expect(actions).not.toContain('discard');
      expect(actions).not.toContain('change-model');
    }
  });
});
