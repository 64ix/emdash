import { describe, expect, it } from 'vitest';
import { agentStatusNeedsAttention } from './board-attention';

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
});
