import { describe, expect, it } from 'vitest';
import type { AgentStatus } from '@shared/core/agents/agentEvents';
import { agentStatusNeedsAttention } from './agent-attention';

describe('agentStatusNeedsAttention', () => {
  it('flags awaiting-input, error, and completed as needing attention', () => {
    expect(agentStatusNeedsAttention('awaiting-input')).toBe(true);
    expect(agentStatusNeedsAttention('error')).toBe(true);
    expect(agentStatusNeedsAttention('completed')).toBe(true);
  });

  it('does not flag working (still in progress) or idle', () => {
    expect(agentStatusNeedsAttention('working')).toBe(false);
    expect(agentStatusNeedsAttention('idle')).toBe(false);
  });

  it('does not flag no status at all', () => {
    expect(agentStatusNeedsAttention(null)).toBe(false);
  });

  it('covers every AgentStatus member exhaustively (compile-time guarded)', () => {
    // Mirrors the exhaustive switch in agent-attention.ts: if a future
    // AgentStatus member is added without updating that switch, this file
    // fails to typecheck (not just this array going stale) since the switch
    // itself would no longer satisfy `(status: AgentStatus) => boolean`
    // without a `default`. This test just pins the *current* full set so a
    // silent runtime behavior change is still caught even before typecheck.
    const statuses: AgentStatus[] = ['idle', 'working', 'awaiting-input', 'error', 'completed'];
    expect(statuses.map((status) => agentStatusNeedsAttention(status))).toEqual([
      false,
      false,
      true,
      true,
      true,
    ]);
  });
});
