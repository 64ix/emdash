/**
 * Browser-mode tests for the "not resumable on this device" affordance
 * (spec #130, ticket #137): a synced conversation without a local session
 * (imported from another machine) is explicitly marked in the conversation
 * list, while resumable ones render no mark. The predicate itself
 * (`ConversationStore.isResumable`) is covered by the node-level
 * conversation-resumability tests.
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConversationResumabilityBadge } from '@renderer/features/conversations/conversation-resumability-badge';

beforeAll(() => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

describe('ConversationResumabilityBadge', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
  });

  it('marks the conversation as not resumable on this device', async () => {
    await act(async () => {
      root.render(<ConversationResumabilityBadge />);
    });

    const badge = host.querySelector('[data-testid="conversation-not-resumable"]');
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toContain('not resumable on this device');
    // The tooltip explains the next step.
    expect(badge?.getAttribute('title')).toContain('start a new session');
  });
});
