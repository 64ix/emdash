import { describe, expect, it } from 'vitest';
import { workflowStages } from './tasks';

describe('workflowStages', () => {
  it('is the Feature Board pipeline plus the out-of-flow Triage stage', () => {
    expect(workflowStages.options).toEqual([
      'idea',
      'exploring',
      'spec',
      'implementing',
      'review',
      'shipped',
      'triage',
    ]);
  });

  it('no longer accepts the retired grilled/tickets/pr stage names', () => {
    expect(workflowStages.safeParse('grilled').success).toBe(false);
    expect(workflowStages.safeParse('tickets').success).toBe(false);
    expect(workflowStages.safeParse('pr').success).toBe(false);
  });
});
