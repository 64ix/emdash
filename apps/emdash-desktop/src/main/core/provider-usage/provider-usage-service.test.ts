import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { err, ok } from '@emdash/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClaudeUsageAdapter } from './claude-adapter';
import { CodexUsageAdapter } from './codex-adapter';
import { ProviderUsageService } from './provider-usage-service';
import type { ProviderUsageAdapter } from './types';

const NOW = new Date('2026-08-02T10:00:00.000Z');

afterEach(() => {
  vi.useRealTimers();
});

describe('ProviderUsageService provider normalization', () => {
  it('reads Claude credentials from CLAUDE_CONFIG_DIR and normalizes every window', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'emdash-claude-usage-'));
    await writeFile(
      join(configDir, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: 'secret-token' } })
    );
    const http = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('Authorization')).toBe('Bearer secret-token');
      return Response.json({
        five_hour: { utilization: 37.5, resets_at: '2026-08-02T12:00:00.000Z' },
        seven_day: { utilization: 51, resets_at: '2026-08-08T00:00:00.000Z' },
        seven_day_opus: { utilization: 9, resets_at: '2026-08-09T00:00:00.000Z' },
      });
    });
    const service = new ProviderUsageService({
      adapters: [
        new ClaudeUsageAdapter({
          env: { CLAUDE_CONFIG_DIR: configDir },
          platform: 'linux',
          http: http as typeof fetch,
          now: () => NOW,
        }),
      ],
    });
    service.initialize({ claude: true, codex: true });

    expect(await service.getSnapshots()).toEqual([
      {
        provider: 'claude',
        lastUpdated: NOW.toISOString(),
        windows: [
          {
            id: 'five_hour',
            label: '5-hour session',
            primary: true,
            utilization: 37.5,
            resetsAt: '2026-08-02T12:00:00.000Z',
          },
          {
            id: 'seven_day',
            label: '7-day weekly',
            primary: false,
            utilization: 51,
            resetsAt: '2026-08-08T00:00:00.000Z',
          },
          {
            id: 'seven_day_opus',
            label: '7-day Opus',
            primary: false,
            utilization: 9,
            resetsAt: '2026-08-09T00:00:00.000Z',
          },
        ],
      },
    ]);
  });

  it('uses the macOS keychain before the credentials file without exposing the token', async () => {
    const readKeychain = vi.fn(async () =>
      JSON.stringify({ claudeAiOauth: { accessToken: 'keychain-secret' } })
    );
    const http = vi.fn(async () =>
      Response.json({
        five_hour: { utilization: 4, resets_at: null },
        seven_day: { utilization: 8, resets_at: null },
      })
    );
    const service = new ProviderUsageService({
      adapters: [
        new ClaudeUsageAdapter({
          env: {},
          platform: 'darwin',
          userName: 'test-user',
          readKeychain,
          readTextFile: vi.fn(async () => {
            throw new Error('file fallback must not run');
          }),
          http: http as typeof fetch,
          now: () => NOW,
        }),
      ],
    });
    service.initialize({ claude: true, codex: true });

    const snapshots = await service.getSnapshots();
    expect(readKeychain).toHaveBeenCalledWith('Claude Code-credentials', 'test-user');
    expect(JSON.stringify(snapshots)).not.toContain('keychain-secret');
  });

  it('falls back to the legacy unscoped macOS keychain service', async () => {
    const readKeychain = vi.fn(async (service: string) =>
      service === 'Claude Code'
        ? JSON.stringify({ claudeAiOauth: { accessToken: 'legacy-secret' } })
        : null
    );
    const service = new ProviderUsageService({
      adapters: [
        new ClaudeUsageAdapter({
          env: {},
          platform: 'darwin',
          userName: 'test-user',
          readKeychain,
          readTextFile: vi.fn(async () => {
            throw new Error('file fallback must not run');
          }),
          http: vi.fn(async () =>
            Response.json({ five_hour: { utilization: 4, resets_at: null } })
          ) as typeof fetch,
          now: () => NOW,
        }),
      ],
    });
    service.initialize({ claude: true, codex: true });

    await service.getSnapshots();

    expect(readKeychain).toHaveBeenNthCalledWith(1, 'Claude Code-credentials', 'test-user');
    expect(readKeychain).toHaveBeenNthCalledWith(2, 'Claude Code', 'test-user');
  });

  it('matches Claude Code keychain scoping and account validation', async () => {
    const configDir = await mkdtemp(join(tmpdir(), 'emdash-claude-keychain-'));
    const readKeychain = vi.fn(async () =>
      JSON.stringify({ claudeAiOauth: { accessToken: 'keychain-secret' } })
    );
    const adapter = new ClaudeUsageAdapter({
      env: { CLAUDE_CONFIG_DIR: configDir, USER: 'invalid account' },
      platform: 'darwin',
      readKeychain,
      readTextFile: vi.fn(async () => {
        throw new Error('file fallback must not run');
      }),
      http: vi.fn(async () =>
        Response.json({ five_hour: { utilization: 4, resets_at: null } })
      ) as typeof fetch,
      now: () => NOW,
    });
    const service = new ProviderUsageService({ adapters: [adapter] });
    service.initialize({ claude: true, codex: true });

    await service.getSnapshots();

    expect(readKeychain).toHaveBeenCalledWith(
      `Claude Code-credentials-${createHash('sha256')
        .update(configDir.normalize('NFC'))
        .digest('hex')
        .slice(0, 8)}`,
      'claude-code-user'
    );
  });

  it('lets CLAUDE_SECURESTORAGE_CONFIG_DIR override the keychain scope', async () => {
    const secureStorageDir = '/tmp/claude-secure-storage';
    const readKeychain = vi.fn(async () =>
      JSON.stringify({ claudeAiOauth: { accessToken: 'keychain-secret' } })
    );
    const service = new ProviderUsageService({
      adapters: [
        new ClaudeUsageAdapter({
          env: {
            CLAUDE_CONFIG_DIR: '/tmp/claude-config',
            CLAUDE_SECURESTORAGE_CONFIG_DIR: secureStorageDir,
            USER: 'test-user',
          },
          platform: 'darwin',
          readKeychain,
          http: vi.fn(async () =>
            Response.json({ five_hour: { utilization: 4, resets_at: null } })
          ) as typeof fetch,
          now: () => NOW,
        }),
      ],
    });
    service.initialize({ claude: true, codex: true });

    await service.getSnapshots();

    expect(readKeychain).toHaveBeenCalledWith(
      `Claude Code-credentials-${createHash('sha256')
        .update(secureStorageDir)
        .digest('hex')
        .slice(0, 8)}`,
      'test-user'
    );
  });

  it('treats an empty CLAUDE_CONFIG_DIR as Claude Code does', async () => {
    const readKeychain = vi.fn(async () =>
      JSON.stringify({ claudeAiOauth: { accessToken: 'keychain-secret' } })
    );
    const service = new ProviderUsageService({
      adapters: [
        new ClaudeUsageAdapter({
          env: { CLAUDE_CONFIG_DIR: '', USER: 'test-user' },
          platform: 'darwin',
          homeDir: '/home/test-user',
          readKeychain,
          http: vi.fn(async () =>
            Response.json({ five_hour: { utilization: 4, resets_at: null } })
          ) as typeof fetch,
          now: () => NOW,
        }),
      ],
    });
    service.initialize({ claude: true, codex: true });

    await service.getSnapshots();

    expect(readKeychain).toHaveBeenCalledWith('Claude Code-credentials', 'test-user');
  });

  it.each([
    {
      name: '401 response',
      response: () => new Response(null, { status: 401 }),
      code: 'authentication',
    },
    {
      name: 'malformed payload',
      response: () => Response.json({ five_hour: { utilization: 'unknown' } }),
      code: 'malformed-data',
    },
    {
      name: 'invalid reset timestamp',
      response: () =>
        Response.json({ five_hour: { utilization: 12, resets_at: 'not-a-timestamp' } }),
      code: 'malformed-data',
    },
  ])('surfaces a Claude $name as snapshot state', async ({ response, code }) => {
    const service = new ProviderUsageService({
      adapters: [
        new ClaudeUsageAdapter({
          platform: 'linux',
          readTextFile: async () => JSON.stringify({ claudeAiOauth: { accessToken: 'secret' } }),
          http: vi.fn(async () => response()) as typeof fetch,
          now: () => NOW,
        }),
      ],
      now: () => NOW.getTime(),
    });
    service.initialize({ claude: true, codex: true });

    const [snapshot] = await service.getSnapshots();
    expect(snapshot.error?.code).toBe(code);
    expect(snapshot.windows).toEqual([]);
  });

  it('uses CODEX_HOME, the newest usable file, and tolerates corrupt JSONL', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'emdash-codex-usage-'));
    const dayDir = join(codexHome, 'sessions', '2026', '08', '02');
    await mkdir(dayDir, { recursive: true });
    const oldPath = join(dayDir, 'rollout-old.jsonl');
    const corruptPath = join(dayDir, 'rollout-corrupt.jsonl');
    const newPath = join(dayDir, 'rollout-new.jsonl');
    await writeFile(oldPath, tokenCountEvent('2026-08-02T08:00:00.000Z', 12, 22));
    await writeFile(corruptPath, '{broken\n');
    await writeFile(
      newPath,
      `${JSON.stringify({ type: 'event_msg', payload: { type: 'token_count' } })}\n` +
        `${tokenCountEvent('2026-08-02T09:30:00.000Z', 44, 61)}\n{truncated`
    );
    await Promise.all([
      utimes(oldPath, new Date(1_000), new Date(1_000)),
      utimes(corruptPath, new Date(2_000), new Date(2_000)),
      utimes(newPath, new Date(3_000), new Date(3_000)),
    ]);
    const service = new ProviderUsageService({
      adapters: [new CodexUsageAdapter({ env: { CODEX_HOME: codexHome } })],
    });
    service.initialize({ claude: true, codex: true });

    expect(await service.getSnapshots()).toEqual([
      {
        provider: 'codex',
        lastUpdated: '2026-08-02T09:30:00.000Z',
        windows: [
          {
            id: 'primary',
            label: 'Primary',
            primary: true,
            utilization: 44,
            resetsAt: '2026-08-02T11:00:00.000Z',
          },
          {
            id: 'secondary',
            label: 'Secondary',
            primary: false,
            utilization: 61,
            resetsAt: '2026-08-09T10:00:00.000Z',
          },
        ],
      },
    ]);
  });

  it('resolves CODEX_HOME after login-shell environment capture', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'emdash-codex-late-env-'));
    const dayDir = join(codexHome, 'sessions', '2026', '08', '02');
    await mkdir(dayDir, { recursive: true });
    await writeFile(
      join(dayDir, 'rollout.jsonl'),
      tokenCountEvent('2026-08-02T09:30:00.000Z', 44, 61)
    );
    const env: Record<string, string | undefined> = {};
    const adapter = new CodexUsageAdapter({ env, homeDir: join(codexHome, 'unused-home') });

    env.CODEX_HOME = codexHome;
    const service = new ProviderUsageService({ adapters: [adapter] });
    service.initialize({ claude: true, codex: true });

    expect((await service.getSnapshots())[0]?.windows[0]?.utilization).toBe(44);
  });

  it('bounds the number of recent Codex session files read', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'emdash-codex-bounded-'));
    const dayDir = join(codexHome, 'sessions', '2026', '08', '02');
    await mkdir(dayDir, { recursive: true });
    const oldUsable = join(dayDir, 'rollout-old-usable.jsonl');
    await writeFile(oldUsable, tokenCountEvent('2026-08-02T08:00:00.000Z', 12, 22));
    await utimes(oldUsable, new Date(1_000), new Date(1_000));
    for (let index = 0; index < 6; index += 1) {
      const path = join(dayDir, `rollout-new-unusable-${index}.jsonl`);
      await writeFile(
        path,
        JSON.stringify({ type: 'event_msg', payload: { type: 'token_count' } })
      );
      await utimes(path, new Date(2_000 + index), new Date(2_000 + index));
    }
    const service = new ProviderUsageService({
      adapters: [new CodexUsageAdapter({ env: { CODEX_HOME: codexHome }, maxFiles: 5 })],
      now: () => NOW.getTime(),
    });
    service.initialize({ claude: true, codex: true });

    const [snapshot] = await service.getSnapshots();

    expect(snapshot.windows).toEqual([]);
    expect(snapshot.error?.code).toBe('unreadable-data');
  });

  it('silently omits providers whose local source is absent', async () => {
    const missingHome = join(tmpdir(), `emdash-codex-missing-${crypto.randomUUID()}`);
    const service = new ProviderUsageService({
      adapters: [new CodexUsageAdapter({ env: { CODEX_HOME: missingHome } })],
    });
    service.initialize({ claude: true, codex: true });
    expect(await service.getSnapshots()).toEqual([]);
  });
});

describe('ProviderUsageService activity-aware polling', () => {
  it('refreshes on activity, polls while active, sleeps after idle, and wakes again', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const read = vi.fn(async () =>
      ok({
        provider: 'claude' as const,
        windows: [],
        lastUpdated: new Date().toISOString(),
      })
    );
    const adapter: ProviderUsageAdapter = {
      provider: 'claude',
      isAvailable: async () => true,
      read,
    };
    const service = new ProviderUsageService({
      adapters: [adapter],
      pollIntervalMs: 30 * 60_000,
      idleTimeoutMs: 60 * 60_000,
    });
    service.initialize({ claude: true, codex: true });

    await service.recordActivity('claude');
    expect(read).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(31 * 60_000);
    expect(read).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
    expect(read).toHaveBeenCalledTimes(2);
    await service.recordActivity('claude');
    expect(read).toHaveBeenCalledTimes(3);
    service.dispose();
  });

  it('keeps the last good snapshot when a transient refresh fails', async () => {
    const read = vi
      .fn()
      .mockResolvedValueOnce(
        ok({
          provider: 'claude' as const,
          windows: [
            {
              id: 'five_hour',
              label: '5-hour session',
              utilization: 30,
              resetsAt: null,
              primary: true,
            },
          ],
          lastUpdated: NOW.toISOString(),
        })
      )
      .mockResolvedValueOnce(err({ code: 'network' as const, message: 'offline' }));
    const service = new ProviderUsageService({
      adapters: [{ provider: 'claude', isAvailable: async () => true, read }],
    });
    service.initialize({ claude: true, codex: true });

    await service.refresh('claude');
    await service.refresh('claude');
    const [snapshot] = await service.getSnapshots();
    expect(snapshot.windows[0].utilization).toBe(30);
    expect(snapshot.lastUpdated).toBe(NOW.toISOString());
    expect(snapshot.error?.code).toBe('network');
  });

  it('stops polling a provider immediately when its gauge is hidden', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const read = vi.fn(async () =>
      ok({ provider: 'claude' as const, windows: [], lastUpdated: new Date().toISOString() })
    );
    const service = new ProviderUsageService({
      adapters: [{ provider: 'claude', isAvailable: async () => true, read }],
      pollIntervalMs: 30 * 60_000,
    });
    service.initialize({ claude: true, codex: true });

    await service.recordActivity('claude');
    await service.setVisibility('claude', false);
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);

    expect(read).toHaveBeenCalledTimes(1);
    service.dispose();
  });
});

function tokenCountEvent(timestamp: string, primary: number, secondary: number): string {
  return JSON.stringify({
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      rate_limits: {
        primary: {
          used_percent: primary,
          window_minutes: 300,
          resets_at: Date.parse('2026-08-02T11:00:00.000Z') / 1_000,
        },
        secondary: {
          used_percent: secondary,
          window_minutes: 10_080,
          resets_at: Date.parse('2026-08-09T10:00:00.000Z') / 1_000,
        },
      },
    },
  });
}
