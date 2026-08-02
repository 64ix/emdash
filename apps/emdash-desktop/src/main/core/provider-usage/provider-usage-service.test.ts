import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
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
    expect(readKeychain).toHaveBeenCalledWith('Claude Code-credentials');
    expect(JSON.stringify(snapshots)).not.toContain('keychain-secret');
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
    await writeFile(
      join(dayDir, 'rollout-old.jsonl'),
      tokenCountEvent('2026-08-02T08:00:00.000Z', 12, 22)
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    await writeFile(join(dayDir, 'rollout-corrupt.jsonl'), '{broken\n');
    await new Promise((resolve) => setTimeout(resolve, 5));
    await writeFile(
      join(dayDir, 'rollout-new.jsonl'),
      `${JSON.stringify({ type: 'event_msg', payload: { type: 'token_count' } })}\n` +
        `${tokenCountEvent('2026-08-02T09:30:00.000Z', 44, 61)}\n{truncated`
    );
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
