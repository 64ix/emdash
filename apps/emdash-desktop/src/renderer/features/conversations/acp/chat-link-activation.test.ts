import { beforeEach, describe, expect, it, vi } from 'vitest';
import { activateChatLink, blockedChatLinkTitle } from './chat-link-activation';

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

const CONTEXT = { projectId: 'p1', taskId: 't1' };

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('activateChatLink', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getWorkspaceForTask.mockReturnValue({ path: '/Users/dev/workspace' });
    mocks.clipboardWriteText.mockResolvedValue({ success: true });
  });

  it('opens the existing task editor for a workspace-relative link', async () => {
    activateChatLink({ href: 'docs/readme.md', itemId: 'i1', source: 'prose-link' }, CONTEXT);
    await flush();

    expect(mocks.openFileInTaskEditor).toHaveBeenCalledWith(
      'p1',
      't1',
      '/Users/dev/workspace/docs/readme.md'
    );
    expect(mocks.confirmOpenExternalLink).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it('opens the existing task editor for an absolute in-workspace link from a resource row', async () => {
    activateChatLink(
      { href: '/Users/dev/workspace/src/foo.ts', itemId: 'i1', source: 'resource-link' },
      CONTEXT
    );
    await flush();

    expect(mocks.openFileInTaskEditor).toHaveBeenCalledWith(
      'p1',
      't1',
      '/Users/dev/workspace/src/foo.ts'
    );
  });

  it('routes http(s) links through the existing external-link confirmation', async () => {
    activateChatLink(
      { href: 'https://example.com/docs', itemId: 'i1', source: 'prose-link' },
      CONTEXT
    );
    await flush();

    expect(mocks.confirmOpenExternalLink).toHaveBeenCalledWith('https://example.com/docs');
    expect(mocks.openFileInTaskEditor).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
  });

  it('reports a blocked scheme with the resolved target and a copy action', async () => {
    activateChatLink({ href: 'javascript:alert(1)', itemId: 'i1', source: 'prose-link' }, CONTEXT);
    await flush();

    expect(mocks.openFileInTaskEditor).not.toHaveBeenCalled();
    expect(mocks.confirmOpenExternalLink).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledTimes(1);

    const call = mocks.toast.mock.calls[0][0];
    expect(call.title).toBe(blockedChatLinkTitle('unsupported-scheme'));
    expect(call.description).toBe('javascript:alert(1)');
    expect(call.variant).toBe('destructive');
    expect(call.action.label).toBe('Copy');

    call.action.onClick();
    expect(mocks.clipboardWriteText).toHaveBeenCalledWith('javascript:alert(1)');
  });

  it('reports an outside-workspace path as blocked with the resolved target', async () => {
    activateChatLink({ href: '/etc/passwd', itemId: 'i1', source: 'prose-link' }, CONTEXT);
    await flush();

    expect(mocks.openFileInTaskEditor).not.toHaveBeenCalled();
    const call = mocks.toast.mock.calls[0][0];
    expect(call.title).toBe(blockedChatLinkTitle('outside-workspace'));
    expect(call.description).toBe('/etc/passwd');
  });

  it('blocks every filesystem-shaped link when there is no active task context', async () => {
    activateChatLink({ href: 'docs/readme.md', itemId: 'i1', source: 'prose-link' }, null);
    await flush();

    expect(mocks.getWorkspaceForTask).not.toHaveBeenCalled();
    expect(mocks.openFileInTaskEditor).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledTimes(1);
    expect(mocks.toast.mock.calls[0][0].description).toBe('docs/readme.md');
  });

  it('still routes http(s) links through confirmation when there is no active task context', async () => {
    activateChatLink({ href: 'https://example.com', itemId: 'i1', source: 'prose-link' }, null);
    await flush();

    expect(mocks.confirmOpenExternalLink).toHaveBeenCalledWith('https://example.com/');
  });

  it('treats a task with no resolvable workspace the same as no active workspace', async () => {
    mocks.getWorkspaceForTask.mockReturnValue(undefined);
    activateChatLink({ href: 'docs/readme.md', itemId: 'i1', source: 'prose-link' }, CONTEXT);
    await flush();

    expect(mocks.openFileInTaskEditor).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledTimes(1);
  });
});

describe('blockedChatLinkTitle', () => {
  it('gives every block reason a distinct, human-readable title', () => {
    const reasons = [
      'malformed',
      'unsupported-scheme',
      'suspicious-authority',
      'outside-workspace',
    ] as const;
    const titles = reasons.map(blockedChatLinkTitle);
    expect(titles.every((title) => title.length > 0)).toBe(true);
  });
});
