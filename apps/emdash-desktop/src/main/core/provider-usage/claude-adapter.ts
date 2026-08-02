import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { err, ok, type Result } from '@emdash/shared';
import type { ProviderUsageError, ProviderUsageSnapshot } from '@shared/core/provider-usage';
import type { ProviderUsageAdapter } from './types';

type ClaudeCredentials = { claudeAiOauth?: { accessToken?: string } };
type ClaudeEnvironment = Record<string, string | undefined>;

export type ClaudeUsageAdapterDependencies = {
  env?: ClaudeEnvironment;
  platform?: NodeJS.Platform;
  homeDir?: string;
  readTextFile?: (path: string) => Promise<string>;
  userName?: string;
  readKeychain?: (service: string, account: string) => Promise<string | null>;
  http?: typeof fetch;
  now?: () => Date;
};

const execFileAsync = promisify(execFile);
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

export class ClaudeUsageAdapter implements ProviderUsageAdapter {
  readonly provider = 'claude' as const;
  private readonly env: ClaudeEnvironment;
  private readonly platform: NodeJS.Platform;
  private readonly homeDir: string;
  private readonly userName: string;
  private readonly readTextFile: (path: string) => Promise<string>;
  private readonly readKeychain: (service: string, account: string) => Promise<string | null>;
  private readonly http: typeof fetch;
  private readonly now: () => Date;

  constructor(deps: ClaudeUsageAdapterDependencies = {}) {
    this.env = deps.env ?? process.env;
    this.platform = deps.platform ?? process.platform;
    this.homeDir = deps.homeDir ?? homedir();
    this.userName = deps.userName ?? userInfo().username;
    this.readTextFile = deps.readTextFile ?? ((path) => readFile(path, 'utf8'));
    this.readKeychain = deps.readKeychain ?? readMacOsKeychain;
    this.http = deps.http ?? fetch;
    this.now = deps.now ?? (() => new Date());
  }

  async isAvailable(): Promise<boolean> {
    return (await this.resolveAccessToken()) !== null;
  }

  async read(): Promise<Result<ProviderUsageSnapshot, ProviderUsageError>> {
    const accessToken = await this.resolveAccessToken();
    if (!accessToken) {
      return err({
        code: 'authentication',
        message: 'Claude Code credentials are unavailable.',
      });
    }

    let response: Response;
    try {
      response = await this.http(USAGE_URL, {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${accessToken}`,
          'anthropic-beta': 'oauth-2025-04-20',
        },
      });
    } catch {
      return err({ code: 'network', message: 'Claude usage could not be refreshed.' });
    }

    if (!response.ok) {
      return err(
        response.status === 401 || response.status === 403
          ? { code: 'authentication', message: 'Claude Code authentication has expired.' }
          : { code: 'network', message: `Claude usage request failed (${response.status}).` }
      );
    }

    try {
      const payload = (await response.json()) as unknown;
      const windows = parseClaudeWindows(payload);
      if (!windows) {
        return err({ code: 'malformed-data', message: 'Claude returned an unknown usage format.' });
      }
      return ok({ provider: this.provider, windows, lastUpdated: this.now().toISOString() });
    } catch {
      return err({ code: 'malformed-data', message: 'Claude returned invalid usage data.' });
    }
  }

  private configDir(): string {
    return (this.env.CLAUDE_CONFIG_DIR || join(this.homeDir, '.claude')).normalize('NFC');
  }

  private async resolveAccessToken(): Promise<string | null> {
    if (this.platform === 'darwin') {
      const account = claudeKeychainAccount(this.env, this.userName);
      for (const service of claudeKeychainServices(this.env, this.configDir())) {
        const raw = await this.readKeychain(service, account).catch(() => null);
        const token = parseAccessToken(raw);
        if (token) return token;
      }
    }

    const raw = await this.readTextFile(join(this.configDir(), '.credentials.json')).catch(
      () => null
    );
    return parseAccessToken(raw);
  }
}

async function readMacOsKeychain(service: string, account: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(
      'security',
      ['find-generic-password', '-a', account, '-w', '-s', service],
      { timeout: 5_000 }
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

function claudeKeychainServices(env: ClaudeEnvironment, configDir: string): string[] {
  const secureStorageDir = env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  if (secureStorageDir !== undefined) {
    const normalized = secureStorageDir.trim().normalize('NFC');
    return normalized
      ? [scopedKeychainService(normalized)]
      : ['Claude Code-credentials', 'Claude Code'];
  }
  if (env.CLAUDE_CONFIG_DIR) return [scopedKeychainService(configDir)];
  return ['Claude Code-credentials', 'Claude Code'];
}

function scopedKeychainService(configDir: string): string {
  const scope = createHash('sha256').update(configDir).digest('hex').slice(0, 8);
  return `Claude Code-credentials-${scope}`;
}

function claudeKeychainAccount(env: ClaudeEnvironment, fallbackUserName: string): string {
  const account = env.USER || fallbackUserName;
  return /^[a-zA-Z0-9._-]+$/.test(account) ? account : 'claude-code-user';
}

function parseAccessToken(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as ClaudeCredentials;
    const token = parsed.claudeAiOauth?.accessToken;
    return typeof token === 'string' && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

function parseClaudeWindows(payload: unknown): ProviderUsageSnapshot['windows'] | null {
  if (!isRecord(payload)) return null;
  const definitions = [
    ['five_hour', '5-hour session', true],
    ['seven_day', '7-day weekly', false],
    ['seven_day_opus', '7-day Opus', false],
  ] as const;
  const windows: ProviderUsageSnapshot['windows'] = [];
  for (const [id, label, primary] of definitions) {
    const value = payload[id];
    if (value === null || value === undefined) continue;
    if (!isRecord(value) || !Number.isFinite(value.utilization)) return null;
    if (
      value.resets_at !== null &&
      (typeof value.resets_at !== 'string' || !Number.isFinite(Date.parse(value.resets_at)))
    ) {
      return null;
    }
    windows.push({
      id,
      label,
      primary,
      utilization: clampPercent(value.utilization as number),
      resetsAt: value.resets_at as string | null,
    });
  }
  return windows.some((window) => window.primary) ? windows : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}
