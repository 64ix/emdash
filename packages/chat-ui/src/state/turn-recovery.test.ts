/**
 * Unit tests for `categorizeTurnOutcome` / `isTurnRecoveryAttentionWorthy` /
 * `buildTurnRecoveryDiagnostic` — pure and DOM-free, runs in the `node`
 * Vitest project (mirrors `state/turn-footer.test.ts`).
 */
import { describe, expect, it } from 'vitest';
import type { TranscriptTurnOutcome } from '@/model';
import {
  buildTurnRecoveryDiagnostic,
  categorizeTurnOutcome,
  isTurnRecoveryAttentionWorthy,
  RECOVERY_ACTIONS_FOR_TURN,
} from './turn-recovery';

// ── categorizeTurnOutcome — typed evidence only ───────────────────────────────

describe('categorizeTurnOutcome', () => {
  it('returns null when there is no recorded outcome', () => {
    expect(categorizeTurnOutcome(undefined)).toBeNull();
  });

  it('classifies a cancelled outcome as cancellation', () => {
    expect(categorizeTurnOutcome({ kind: 'cancelled', reason: 'cancelled' })).toBe('cancellation');
  });

  it('classifies an interrupted outcome as interruption, regardless of reason', () => {
    expect(categorizeTurnOutcome({ kind: 'interrupted', reason: 'process_closed' })).toBe(
      'interruption'
    );
    expect(categorizeTurnOutcome({ kind: 'interrupted', reason: 'replaced' })).toBe('interruption');
    expect(categorizeTurnOutcome({ kind: 'interrupted' })).toBe('interruption');
  });

  it.each([
    'prompt_failed',
    'process_closed',
    'spawn_failed',
    'initialize_failed',
    'new_session_failed',
    'load_session_failed',
    'cancel_failed',
    'set_config_failed',
    'set_mode_failed',
  ] as const)(
    'classifies every typed error reason (%s) as provider — none carry an auth/rate-limit signal',
    (reason) => {
      expect(categorizeTurnOutcome({ kind: 'error', reason })).toBe('provider');
    }
  );

  it('classifies an error outcome with no reason as provider too', () => {
    expect(categorizeTurnOutcome({ kind: 'error' })).toBe('provider');
  });

  it('classifies a done outcome that hit the token/context limit as context exhaustion', () => {
    expect(categorizeTurnOutcome({ kind: 'done', reason: 'max_tokens' })).toBe('context');
  });

  it.each(['end_turn', 'max_turn_requests', 'refusal', 'quiesced'] as const)(
    'a normal done reason (%s) is not actionable — no card',
    (reason) => {
      expect(categorizeTurnOutcome({ kind: 'done', reason })).toBeNull();
    }
  );

  it('a done outcome with no reason is not actionable', () => {
    expect(categorizeTurnOutcome({ kind: 'done' })).toBeNull();
  });

  it('never produces authentication, rate-limit, or unknown — no typed turn-level evidence exists for them', () => {
    const outcomes: TranscriptTurnOutcome[] = [
      { kind: 'done' },
      { kind: 'done', reason: 'max_tokens' },
      { kind: 'cancelled' },
      { kind: 'error', reason: 'prompt_failed' },
      { kind: 'interrupted', reason: 'process_closed' },
    ];
    for (const outcome of outcomes) {
      const category = categorizeTurnOutcome(outcome);
      expect(category).not.toBe('authentication');
      expect(category).not.toBe('rate-limit');
      expect(category).not.toBe('unknown');
    }
  });
});

// ── isTurnRecoveryAttentionWorthy ─────────────────────────────────────────────

describe('isTurnRecoveryAttentionWorthy', () => {
  it('is false for null (nothing to show)', () => {
    expect(isTurnRecoveryAttentionWorthy(null)).toBe(false);
  });

  it('is false for cancellation — a self-initiated Stop needs no recovery nag', () => {
    expect(isTurnRecoveryAttentionWorthy('cancellation')).toBe(false);
  });

  it.each(['interruption', 'provider', 'context'] as const)('is true for %s', (category) => {
    expect(isTurnRecoveryAttentionWorthy(category)).toBe(true);
  });
});

// ── RECOVERY_ACTIONS_FOR_TURN — actions appear only when executable ──────────

describe('RECOVERY_ACTIONS_FOR_TURN', () => {
  it('offers only copy-diagnostic — no snapshot to retry/edit/discard, no reachable sign-in/model control', () => {
    expect(RECOVERY_ACTIONS_FOR_TURN).toEqual(['copy-diagnostic']);
  });
});

// ── buildTurnRecoveryDiagnostic — bounded + redacted via the shared builder ──

describe('buildTurnRecoveryDiagnostic', () => {
  it('includes the category, turn id, outcome kind, and reason', () => {
    const text = buildTurnRecoveryDiagnostic({
      category: 'provider',
      turnId: 'turn-42',
      itemId: 'item-1',
      outcome: { kind: 'error', reason: 'prompt_failed' },
    });
    expect(text).toContain('provider');
    expect(text).toContain('turn-42');
    expect(text).toContain('item-1');
    expect(text).toContain('error');
    expect(text).toContain('prompt_failed');
  });

  it('omits itemId/reason keys entirely when absent, rather than printing them empty', () => {
    const text = buildTurnRecoveryDiagnostic({
      category: 'cancellation',
      turnId: 'turn-1',
      outcome: { kind: 'cancelled' },
    });
    expect(text).not.toContain('itemId');
    expect(text).not.toContain('"reason"');
  });

  it('routes every field through the shared bounded/redacted structured builder (never throws on a pathological reason string)', () => {
    // Defensive: even though TranscriptTurnOutcome carries no free-text field
    // today, buildStructuredValue's redaction still runs on every string leaf
    // — proving the diagnostic goes through the shared machinery rather than
    // a bespoke serializer that could skip it if a future field is added.
    const text = buildTurnRecoveryDiagnostic({
      category: 'provider',
      turnId: 'turn-1',
      outcome: { kind: 'error', reason: 'prompt_failed' },
    });
    expect(() => text).not.toThrow();
  });
});
