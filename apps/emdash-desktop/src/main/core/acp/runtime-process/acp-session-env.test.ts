import { describe, expect, it } from 'vitest';
import { buildAcpSessionEnv } from './acp-session-env';

describe('buildAcpSessionEnv', () => {
  it('injects EMDASH_TASK_ID for the task the session is attached to', () => {
    const env = buildAcpSessionEnv('task-123', undefined);
    expect(env.EMDASH_TASK_ID).toBe('task-123');
  });

  it('merges in per-provider env configured in Settings', () => {
    const env = buildAcpSessionEnv('task-123', { ANTHROPIC_BASE_URL: 'https://example.test' });
    expect(env.ANTHROPIC_BASE_URL).toBe('https://example.test');
    expect(env.EMDASH_TASK_ID).toBe('task-123');
  });

  it('keeps EMDASH_TASK_ID authoritative over a same-named provider setting', () => {
    const env = buildAcpSessionEnv('task-123', { EMDASH_TASK_ID: 'spoofed-task' });
    expect(env.EMDASH_TASK_ID).toBe('task-123');
  });
});
