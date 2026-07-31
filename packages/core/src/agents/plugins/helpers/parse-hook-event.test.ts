import { describe, expect, it } from 'vitest';
import { defaultHookEventParser } from './parse-hook-event';

describe('defaultHookEventParser', () => {
  it('preserves the submitted prompt on canonical start events', () => {
    expect(defaultHookEventParser('start', { prompt: 'Fix the title behavior' })).toEqual({
      kind: 'status',
      type: 'start',
      prompt: 'Fix the title behavior',
      lastAssistantMessage: undefined,
      title: undefined,
      message: undefined,
    });
  });

  it('does not coerce non-string prompt payloads', () => {
    expect(defaultHookEventParser('start', { prompt: 42 })).toMatchObject({
      kind: 'status',
      type: 'start',
      prompt: undefined,
    });
  });
});
