import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  activateChatLink,
  artifactPreviewDenialTitle,
  blockedChatLinkTitle,
} from './chat-link-activation';

const mocks = vi.hoisted(() => ({
  getWorkspaceForTask: vi.fn(),
  openFileInTaskEditor: vi.fn(),
  confirmOpenExternalLink: vi.fn(),
  toast: vi.fn(),
  clipboardWriteText: vi.fn(),
  previewArtifact: vi.fn(),
  showModal: vi.fn(),
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

vi.mock('@renderer/lib/modal/modal-provider', () => ({
  showModal: mocks.showModal,
}));

vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    app: {
      clipboardWriteText: mocks.clipboardWriteText,
    },
    workspace: {
      files: {
        previewArtifact: mocks.previewArtifact,
      },
    },
  },
}));

const CONTEXT = { projectId: 'p1', taskId: 't1' };

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('activateChatLink', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getWorkspaceForTask.mockReturnValue({
      path: '/Users/dev/workspace',
      workspaceId: 'ws1',
    });
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

  it('surfaces a rejected activation as an error toast instead of an unhandled rejection', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      mocks.openFileInTaskEditor.mockRejectedValue(new Error('rpc exploded'));
      activateChatLink({ href: 'docs/readme.md', itemId: 'i1', source: 'prose-link' }, CONTEXT);
      await flush();
      // Let any microtask-queued unhandledRejection listeners run.
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(mocks.toast).toHaveBeenCalledTimes(1);
      const call = mocks.toast.mock.calls[0][0];
      expect(call.title).toBe('Could not open link');
      expect(call.description).toBe('docs/readme.md');
      expect(call.variant).toBe('destructive');
      expect(call.action.label).toBe('Copy');
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  // ── local-artifact preview (ticket #21) ────────────────────────────────────

  describe('local artifact preview', () => {
    const IMAGE_PATH = '/Users/dev/Desktop/chart.png';

    it('previews an image artifact resolved directly by the main-process policy', async () => {
      mocks.previewArtifact.mockResolvedValue({
        success: true,
        data: {
          status: 'ok',
          kind: 'image',
          dataUrl: 'data:image/png;base64,AAAA',
          mimeType: 'image/png',
          size: 4,
          resolvedPath: IMAGE_PATH,
        },
      });

      activateChatLink({ href: IMAGE_PATH, itemId: 'i1', source: 'resource-link' }, CONTEXT);
      await flush();

      expect(mocks.previewArtifact).toHaveBeenCalledWith('p1', 'ws1', IMAGE_PATH, false);
      expect(mocks.showModal).toHaveBeenCalledWith('artifactPreviewModal', {
        name: 'chart.png',
        path: IMAGE_PATH,
        artifact: { kind: 'image', dataUrl: 'data:image/png;base64,AAAA', mimeType: 'image/png' },
      });
      expect(mocks.toast).not.toHaveBeenCalled();
    });

    it('previews a text artifact with its content type', async () => {
      const path = '/Users/dev/Desktop/notes.md';
      mocks.previewArtifact.mockResolvedValue({
        success: true,
        data: {
          status: 'ok',
          kind: 'text',
          content: '# hello',
          contentType: 'markdown',
          size: 7,
          resolvedPath: path,
        },
      });

      activateChatLink({ href: path, itemId: 'i1', source: 'resource-link' }, CONTEXT);
      await flush();

      expect(mocks.showModal).toHaveBeenCalledWith('artifactPreviewModal', {
        name: 'notes.md',
        path,
        artifact: { kind: 'text', content: '# hello', contentType: 'markdown' },
      });
    });

    it('asks for confirmation outside every trusted root, then previews once confirmed', async () => {
      mocks.previewArtifact
        .mockResolvedValueOnce({
          success: true,
          data: { status: 'needs-confirmation', kind: 'image', resolvedPath: IMAGE_PATH },
        })
        .mockResolvedValueOnce({
          success: true,
          data: {
            status: 'ok',
            kind: 'image',
            dataUrl: 'data:image/png;base64,AAAA',
            mimeType: 'image/png',
            size: 4,
            resolvedPath: IMAGE_PATH,
          },
        });

      activateChatLink({ href: IMAGE_PATH, itemId: 'i1', source: 'resource-link' }, CONTEXT);
      await flush();

      expect(mocks.previewArtifact).toHaveBeenCalledTimes(1);
      expect(mocks.previewArtifact).toHaveBeenNthCalledWith(1, 'p1', 'ws1', IMAGE_PATH, false);
      expect(mocks.showModal).toHaveBeenCalledWith(
        'confirmActionModal',
        expect.objectContaining({
          title: 'Preview file outside the workspace?',
          description: IMAGE_PATH,
          confirmLabel: 'Preview',
        })
      );

      // Simulate the user confirming in the dialog.
      const confirmCall = mocks.showModal.mock.calls.find(
        (call) => call[0] === 'confirmActionModal'
      );
      confirmCall?.[1].onSuccess();
      await flush();

      expect(mocks.previewArtifact).toHaveBeenCalledTimes(2);
      expect(mocks.previewArtifact).toHaveBeenNthCalledWith(2, 'p1', 'ws1', IMAGE_PATH, true);
      expect(mocks.showModal).toHaveBeenCalledWith('artifactPreviewModal', {
        name: 'chart.png',
        path: IMAGE_PATH,
        artifact: { kind: 'image', dataUrl: 'data:image/png;base64,AAAA', mimeType: 'image/png' },
      });
    });

    it.each([
      'invalid-path',
      'traversal',
      'symlink-escape',
      'missing',
      'directory',
      'oversized',
      'type-mismatch',
      'unsupported-content',
    ] as const)('reports a %s denial with the resolved target and a copy action', async (reason) => {
      mocks.previewArtifact.mockResolvedValue({
        success: true,
        data: { status: 'denied', reason, resolvedPath: IMAGE_PATH },
      });

      activateChatLink({ href: IMAGE_PATH, itemId: 'i1', source: 'resource-link' }, CONTEXT);
      await flush();

      expect(mocks.showModal).not.toHaveBeenCalled();
      expect(mocks.toast).toHaveBeenCalledTimes(1);
      const call = mocks.toast.mock.calls[0][0];
      expect(call.title).toBe(artifactPreviewDenialTitle(reason));
      expect(call.description).toBe(IMAGE_PATH);
      expect(call.variant).toBe('destructive');
      expect(call.action.label).toBe('Copy');

      call.action.onClick();
      expect(mocks.clipboardWriteText).toHaveBeenCalledWith(IMAGE_PATH);
    });

    it('falls back to the requested path when a denial has no resolved path', async () => {
      mocks.previewArtifact.mockResolvedValue({
        success: true,
        data: { status: 'denied', reason: 'invalid-path' },
      });

      activateChatLink({ href: IMAGE_PATH, itemId: 'i1', source: 'resource-link' }, CONTEXT);
      await flush();

      expect(mocks.toast.mock.calls[0][0].description).toBe(IMAGE_PATH);
    });

    it('reports an RPC-level failure as a distinct "could not preview" toast', async () => {
      mocks.previewArtifact.mockResolvedValue({
        success: false,
        error: { type: 'not_found', entity: 'filesystem', detail: undefined },
      });

      activateChatLink({ href: IMAGE_PATH, itemId: 'i1', source: 'resource-link' }, CONTEXT);
      await flush();

      expect(mocks.showModal).not.toHaveBeenCalled();
      expect(mocks.toast).toHaveBeenCalledTimes(1);
      const call = mocks.toast.mock.calls[0][0];
      expect(call.title).toBe('Could not preview file');
      expect(call.description).toBe(IMAGE_PATH);
    });

    it('reports a rejected confirm-then-preview call without an unhandled rejection', async () => {
      const unhandled = vi.fn();
      process.on('unhandledRejection', unhandled);
      try {
        mocks.previewArtifact
          .mockResolvedValueOnce({
            success: true,
            data: { status: 'needs-confirmation', kind: 'image', resolvedPath: IMAGE_PATH },
          })
          .mockRejectedValueOnce(new Error('rpc exploded'));

        activateChatLink({ href: IMAGE_PATH, itemId: 'i1', source: 'resource-link' }, CONTEXT);
        await flush();

        const confirmCall = mocks.showModal.mock.calls.find(
          (call) => call[0] === 'confirmActionModal'
        );
        confirmCall?.[1].onSuccess();
        await flush();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(mocks.toast).toHaveBeenCalledTimes(1);
        expect(mocks.toast.mock.calls[0][0].title).toBe('Could not preview file');
        expect(unhandled).not.toHaveBeenCalled();
      } finally {
        process.off('unhandledRejection', unhandled);
      }
    });

    it('never reaches the local-artifact path for a workspace-relative traversal, even with a previewable extension', async () => {
      activateChatLink(
        { href: 'docs/../../Desktop/chart.png', itemId: 'i1', source: 'prose-link' },
        CONTEXT
      );
      await flush();

      expect(mocks.previewArtifact).not.toHaveBeenCalled();
      expect(mocks.toast).toHaveBeenCalledTimes(1);
      expect(mocks.toast.mock.calls[0][0].title).toBe(blockedChatLinkTitle('outside-workspace'));
    });
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

describe('artifactPreviewDenialTitle', () => {
  it('gives every denial reason a non-empty, explicit title — never a blank pane', () => {
    const reasons = [
      'invalid-path',
      'traversal',
      'symlink-escape',
      'missing',
      'directory',
      'oversized',
      'type-mismatch',
      'unsupported-content',
    ] as const;
    const titles = reasons.map(artifactPreviewDenialTitle);
    expect(titles.every((title) => title.length > 0)).toBe(true);
  });
});
