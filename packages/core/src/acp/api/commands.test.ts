import { describe, expect, it } from 'vitest';
import { acpStartInputSchema } from './commands';

function makeBaseInput() {
  return {
    conversationId: 'conversation-1',
    projectId: 'project-1',
    taskId: 'task-1',
    providerId: 'opencode',
    workspaceId: 'workspace-1',
    cwd: '/tmp/workspace',
    sessionId: null,
    model: null,
  };
}

describe('acpStartInputSchema', () => {
  it('accepts an optional effort field', () => {
    const parsed = acpStartInputSchema.parse({ ...makeBaseInput(), effort: 'high' });
    expect(parsed.effort).toBe('high');
  });

  it('accepts a null effort field', () => {
    const parsed = acpStartInputSchema.parse({ ...makeBaseInput(), effort: null });
    expect(parsed.effort).toBeNull();
  });

  it('omits effort when absent', () => {
    const parsed = acpStartInputSchema.parse(makeBaseInput());
    expect(parsed.effort).toBeUndefined();
  });
});
