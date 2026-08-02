import { describe, expect, it } from 'vitest';
import { buildClaudeHookConfig } from './hooks';

describe('buildClaudeHookConfig', () => {
  it('preserves the prompt in canonical UserPromptSubmit events', () => {
    const hooks = buildClaudeHookConfig();

    expect(hooks.parseHookEvent('start', { prompt: 'Fix conversation titles' })).toMatchObject({
      kind: 'status',
      type: 'start',
      prompt: 'Fix conversation titles',
    });
  });
});
