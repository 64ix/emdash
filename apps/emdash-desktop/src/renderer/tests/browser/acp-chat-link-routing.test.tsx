/**
 * Browser-mode regression test for chat link routing (spec #18, ticket #20).
 *
 * Mounts the real `ChatTranscript` (the exact component `AcpChatPanel` renders)
 * with the real `activateChatLink` wired as `onActivateLink`, seeds it with a
 * Markdown message containing a workspace-relative link, an external https
 * link, and a `javascript:` link, plus a resource-link row pointing at another
 * workspace file. Only the far side-effect boundaries (task editor, external-
 * link confirmation, toast) are mocked; classification and dispatch run for
 * real.
 *
 * This reproduces the original defect directly: before ticket #20, an
 * unclassified prose link fell through to a raw `<a target="_blank">` and a
 * resource-link's `external` target called `window.open` directly, either of
 * which could hand Electron's window-open policy a target it denies by
 * creating an empty child window instead of a supported action. Every
 * assertion below spies on `window.open` and asserts it is never called.
 */
import { createChatContext, createChatState } from '@emdash/chat-ui';
import type {
  ChatContext,
  ChatMessage,
  ChatResourceLink,
  ChatState,
  TranscriptTurn,
} from '@emdash/chat-ui';
import React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { activateChatLink } from '@renderer/features/conversations/acp/chat-link-activation';
import { ChatTranscript, type ChatCommands } from '@renderer/lib/chat/chat-transcript';

const mocks = vi.hoisted(() => ({
  getWorkspaceForTask: vi.fn(),
  openFileInTaskEditor: vi.fn(),
  confirmOpenExternalLink: vi.fn(),
  toast: vi.fn(),
  clipboardWriteText: vi.fn(),
}));

vi.mock('@renderer/features/tasks/stores/task-selectors', () => ({
  getWorkspaceForTask: mocks.getWorkspaceForTask,
}));

vi.mock('@renderer/features/tasks/stores/open-file-in-file-editor', () => ({
  openFileInTaskEditor: mocks.openFileInTaskEditor,
}));

vi.mock('@renderer/lib/open-external-link', () => ({
  confirmOpenExternalLink: mocks.confirmOpenExternalLink,
}));

vi.mock('@renderer/lib/hooks/use-toast', () => ({
  toast: mocks.toast,
}));

vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    app: {
      clipboardWriteText: mocks.clipboardWriteText,
    },
  },
}));

const TASK_CONTEXT = { projectId: 'p1', taskId: 't1' };

const MESSAGE_TEXT =
  'Open the [workspace file](docs/readme.md), visit [the docs](https://example.com/docs), ' +
  'or trigger [a bad link](javascript:alert(1)).';

const RESOURCE_LINK: ChatResourceLink = {
  kind: 'resource-link',
  id: 'rl-1',
  uri: 'reports/summary.csv',
  name: 'summary.csv',
  target: { kind: 'workspace-file', path: 'reports/summary.csv' },
};

const MESSAGE: ChatMessage = {
  kind: 'message',
  id: 'msg-1',
  seq: 0,
  role: 'assistant',
  text: MESSAGE_TEXT,
};

const TURNS: TranscriptTurn[] = [
  {
    id: 'turn-1',
    seq: 0,
    initiator: 'agent',
    items: [
      MESSAGE as TranscriptTurn['items'][number],
      RESOURCE_LINK as unknown as TranscriptTurn['items'][number],
    ],
    outcome: { kind: 'done' },
  },
];

// ── DOM helpers ───────────────────────────────────────────────────────────────

const nextPaint = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function waitFor<T>(fn: () => T | null | undefined, frames = 60): Promise<T> {
  for (let i = 0; i < frames; i++) {
    const value = fn();
    if (value) return value;
    await nextPaint();
  }
  throw new Error('Timed out waiting for condition');
}

type Mounted = {
  host: HTMLDivElement;
  root: Root;
  ctx: ChatContext;
  state: ChatState;
};

function mountChatTranscript(commands: ChatCommands): Mounted {
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;top:0;left:0;width:800px;height:600px;';
  document.body.appendChild(host);

  const ctx = createChatContext({});
  const state = createChatState(ctx, { uri: 'link-routing-test' });
  state.transcript.history.seed(TURNS);

  const root = createRoot(host);
  root.render(React.createElement(ChatTranscript, { context: ctx, state, commands }));

  return { host, root, ctx, state };
}

function unmount(mounted: Mounted): void {
  mounted.root.unmount();
  mounted.ctx.dispose();
  mounted.state.dispose();
  document.body.removeChild(mounted.host);
}

describe('ACP chat link routing (browser)', () => {
  let windowOpenSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getWorkspaceForTask.mockReturnValue({ path: '/Users/dev/workspace' });
    mocks.clipboardWriteText.mockResolvedValue({ success: true });
    // Real window.open would try to pop a real browser window; track calls
    // without letting any through, since the point of this test is that it's
    // never called at all.
    windowOpenSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
  });

  afterEach(() => {
    windowOpenSpy.mockRestore();
  });

  it('routes a workspace-relative prose link to the existing task editor', async () => {
    const commands: ChatCommands = {
      onActivateLink: (arg) => activateChatLink(arg, TASK_CONTEXT),
    };
    const mounted = mountChatTranscript(commands);

    const link = await waitFor(() =>
      Array.from(mounted.host.querySelectorAll('a')).find((a) =>
        a.textContent?.includes('workspace file')
      )
    );

    link.click();
    await flush();

    expect(mocks.openFileInTaskEditor).toHaveBeenCalledWith(
      'p1',
      't1',
      '/Users/dev/workspace/docs/readme.md'
    );
    expect(mocks.confirmOpenExternalLink).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(windowOpenSpy).not.toHaveBeenCalled();

    unmount(mounted);
  });

  it('routes an https prose link through the existing external-link confirmation', async () => {
    const commands: ChatCommands = {
      onActivateLink: (arg) => activateChatLink(arg, TASK_CONTEXT),
    };
    const mounted = mountChatTranscript(commands);

    const link = await waitFor(() =>
      Array.from(mounted.host.querySelectorAll('a')).find((a) => a.textContent?.includes('docs'))
    );

    link.click();
    await flush();

    expect(mocks.confirmOpenExternalLink).toHaveBeenCalledWith('https://example.com/docs');
    expect(mocks.openFileInTaskEditor).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(windowOpenSpy).not.toHaveBeenCalled();

    unmount(mounted);
  });

  it('blocks a javascript: prose link with a resolved target and a copy action instead of opening a window', async () => {
    const commands: ChatCommands = {
      onActivateLink: (arg) => activateChatLink(arg, TASK_CONTEXT),
    };
    const mounted = mountChatTranscript(commands);

    const link = await waitFor(() =>
      Array.from(mounted.host.querySelectorAll('a')).find((a) =>
        a.textContent?.includes('bad link')
      )
    );

    link.click();
    await flush();

    expect(mocks.openFileInTaskEditor).not.toHaveBeenCalled();
    expect(mocks.confirmOpenExternalLink).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledTimes(1);

    const toastArg = mocks.toast.mock.calls[0][0];
    expect(toastArg.description).toBe('javascript:alert(1)');
    expect(toastArg.variant).toBe('destructive');
    expect(toastArg.action.label).toBe('Copy');

    // No child window was ever created — this is the original regression.
    expect(windowOpenSpy).not.toHaveBeenCalled();

    unmount(mounted);
  });

  it('routes a middle-click (auxclick) on a prose link through the same typed contract as a left click', async () => {
    // Middle-click dispatches `auxclick`, not `click` — Chromium's own
    // preventDefault()-only-on-click guard would never see it. A real `<a
    // href>` left unguarded here would still fall back to the browser's
    // native "open link in background tab" behavior for the raw,
    // unclassified href instead of running the typed link-action contract.
    const commands: ChatCommands = {
      onActivateLink: (arg) => activateChatLink(arg, TASK_CONTEXT),
    };
    const mounted = mountChatTranscript(commands);

    const link = await waitFor(() =>
      Array.from(mounted.host.querySelectorAll('a')).find((a) =>
        a.textContent?.includes('workspace file')
      )
    );

    const auxEvent = new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 });
    link.dispatchEvent(auxEvent);
    await flush();

    expect(mocks.openFileInTaskEditor).toHaveBeenCalledWith(
      'p1',
      't1',
      '/Users/dev/workspace/docs/readme.md'
    );
    expect(auxEvent.defaultPrevented).toBe(true);
    expect(windowOpenSpy).not.toHaveBeenCalled();

    unmount(mounted);
  });

  it('routes a resource-link row through the same typed contract as prose links', async () => {
    const commands: ChatCommands = {
      onActivateLink: (arg) => activateChatLink(arg, TASK_CONTEXT),
    };
    const mounted = mountChatTranscript(commands);

    const row = await waitFor(
      () => mounted.host.querySelector<HTMLElement>('[role="button"]') ?? undefined
    );

    row.click();
    await flush();

    expect(mocks.openFileInTaskEditor).toHaveBeenCalledWith(
      'p1',
      't1',
      '/Users/dev/workspace/reports/summary.csv'
    );
    expect(windowOpenSpy).not.toHaveBeenCalled();

    unmount(mounted);
  });

  it('never opens an unapproved child window across every link on the panel', async () => {
    const commands: ChatCommands = {
      onActivateLink: (arg) => activateChatLink(arg, TASK_CONTEXT),
    };
    const mounted = mountChatTranscript(commands);

    await waitFor(() => (mounted.host.querySelectorAll('a').length >= 3 ? true : null));

    const anchors = Array.from(mounted.host.querySelectorAll('a'));
    const row = mounted.host.querySelector<HTMLElement>('[role="button"]');
    expect(row).not.toBeNull();

    for (const anchor of anchors) {
      anchor.click();
      await flush();
    }
    row!.click();
    await flush();

    expect(windowOpenSpy).not.toHaveBeenCalled();

    unmount(mounted);
  });
});
