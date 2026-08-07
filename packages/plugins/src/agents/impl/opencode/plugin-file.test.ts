import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { PluginFs } from '@emdash/core/agents/plugins';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { provider } from './index';
import { OPENCODE_PLUGIN_CONTENT } from './plugin-file';

function createMemoryFs(): PluginFs & { files: Map<string, string> } {
  const files = new Map<string, string>();

  return {
    files,
    async read(path) {
      return files.get(path) ?? null;
    },
    async write(path, content) {
      files.set(path, content);
    },
    async delete(path) {
      files.delete(path);
    },
    async exists(path) {
      return files.has(path);
    },
    async list(path) {
      return [...files.keys()].filter((file) => file.startsWith(path));
    },
  };
}

const HOOK_EVENT = {
  type: 'message.updated',
  properties: {
    sessionID: 'ses_abc',
    info: { id: 'msg_user_1', role: 'user', sessionID: 'ses_abc', time: { created: 1 } },
  },
};

const TEXT_PART_EVENT = {
  type: 'message.part.updated',
  properties: {
    sessionID: 'ses_abc',
    part: {
      type: 'text',
      text: 'Fix the flaky permission tests',
      messageID: 'msg_user_1',
      sessionID: 'ses_abc',
      id: 'prt_1',
    },
    time: 2,
  },
};

type Hook = { event: (input: { event: Record<string, unknown> }) => Promise<void> };

describe('opencode plugin hooks', () => {
  it('installs the emdash notifications plugin into the OpenCode workspace plugin path', async () => {
    const fs = createMemoryFs();

    const written = await provider.behavior.plugins?.installPlugin(fs, {
      kind: 'workspace',
      path: '/workspace',
    });

    expect(written).toEqual(['.opencode/plugins/emdash-notifications.js']);
    const content = await fs.read('.opencode/plugins/emdash-notifications.js');
    expect(content).toContain('export const EmdashNotifications');
    expect(content).toContain('X-Emdash-Event-Type');
    expect(content).toContain("type: 'start'");
    expect(content).toContain('getSubmittedPrompt');
    expect(content).toContain("event.type === 'message.part.updated'");
  });

  it('declares the start hook event so prompt-submit title capture applies', () => {
    expect(provider.capabilities.hooks).toMatchObject({
      kind: 'plugin',
      supportedEvents: expect.arrayContaining(['start']),
    });
  });

  describe('embedded plugin behavior', () => {
    let hooks: Hook;
    let fetchMock: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      const dir = await mkdtemp(join(tmpdir(), 'opencode-plugin-test-'));
      const file = join(dir, 'emdash-notifications.mjs');
      await writeFile(file, OPENCODE_PLUGIN_CONTENT);
      const mod = (await import(pathToFileURL(file).href)) as {
        EmdashNotifications: () => Promise<Hook>;
      };
      await rm(dir, { recursive: true, force: true });
      hooks = await mod.EmdashNotifications();
      fetchMock = vi.fn().mockResolvedValue({});
      vi.stubGlobal('fetch', fetchMock);
      vi.stubEnv('EMDASH_HOOK_PORT', '4242');
      vi.stubEnv('EMDASH_HOOK_TOKEN', 'secret');
      vi.stubEnv('EMDASH_PTY_ID', 'pty-1');
    });

    afterEach(() => {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    });

    it('posts a canonical start event with the user prompt', async () => {
      await hooks.event({ event: HOOK_EVENT });
      await hooks.event({ event: TEXT_PART_EVENT });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://127.0.0.1:4242/hook');
      expect(init.method).toBe('POST');
      expect((init.headers as Record<string, string>)['X-Emdash-Event-Type']).toBe('start');
      expect((init.headers as Record<string, string>)['X-Emdash-Pty-Id']).toBe('pty-1');
      expect(JSON.parse(String(init.body))).toEqual({
        prompt: 'Fix the flaky permission tests',
      });
    });

    it('captures the prompt only once per user message', async () => {
      await hooks.event({ event: HOOK_EVENT });
      await hooks.event({ event: TEXT_PART_EVENT });
      await hooks.event({ event: TEXT_PART_EVENT });

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('ignores text parts of assistant messages', async () => {
      await hooks.event({ event: HOOK_EVENT });
      await hooks.event({
        event: {
          type: 'message.part.updated',
          properties: {
            sessionID: 'ses_abc',
            part: {
              type: 'text',
              text: 'Let me look at that.',
              messageID: 'msg_assistant_1',
              sessionID: 'ses_abc',
              id: 'prt_2',
            },
          },
        },
      });

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('keeps the existing notification events intact', async () => {
      await hooks.event({
        event: { type: 'session.idle', properties: { sessionID: 'ses_abc' } },
      });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const init = fetchMock.mock.calls[1][1] as RequestInit;
      expect((init.headers as Record<string, string>)['X-Emdash-Event-Type']).toBe('notification');
      expect(JSON.parse(String(init.body))).toMatchObject({
        notification_type: 'idle_prompt',
      });
    });

    it('skips empty prompts without posting', async () => {
      await hooks.event({ event: HOOK_EVENT });
      await hooks.event({
        event: {
          ...TEXT_PART_EVENT,
          properties: {
            ...TEXT_PART_EVENT.properties,
            part: { ...TEXT_PART_EVENT.properties.part, text: '   ' },
          },
        },
      });

      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
