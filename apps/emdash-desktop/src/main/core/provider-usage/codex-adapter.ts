import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { err, ok, type Result } from '@emdash/shared';
import type { ProviderUsageError, ProviderUsageSnapshot } from '@shared/core/provider-usage';
import type { ProviderUsageAdapter } from './types';

export type CodexUsageAdapterDependencies = {
  env?: Record<string, string | undefined>;
  homeDir?: string;
  maxFiles?: number;
};

type RecentFile = { path: string; mtimeMs: number };

export class CodexUsageAdapter implements ProviderUsageAdapter {
  readonly provider = 'codex' as const;
  private readonly sessionsDir: string;
  private readonly maxFiles: number;

  constructor(deps: CodexUsageAdapterDependencies = {}) {
    const env = deps.env ?? process.env;
    const codexHome = env.CODEX_HOME || join(deps.homeDir ?? homedir(), '.codex');
    this.sessionsDir = join(codexHome, 'sessions');
    this.maxFiles = deps.maxFiles ?? 5;
  }

  async isAvailable(): Promise<boolean> {
    return stat(this.sessionsDir)
      .then((value) => value.isDirectory())
      .catch(() => false);
  }

  async read(): Promise<Result<ProviderUsageSnapshot, ProviderUsageError>> {
    const files = await this.recentFiles();
    for (const file of files) {
      const snapshot = await this.readFileSnapshot(file);
      if (snapshot) return ok(snapshot);
    }
    return err({
      code: 'unreadable-data',
      message: 'No Codex rate-limit data was found in recent local sessions.',
    });
  }

  private async recentFiles(): Promise<RecentFile[]> {
    const found: RecentFile[] = [];
    const visit = async (directory: string, depth: number): Promise<void> => {
      if (depth > 4 || found.length > 100) return;
      const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
      for (const entry of entries.sort((left, right) => right.name.localeCompare(left.name))) {
        if (found.length >= 100) break;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          await visit(path, depth + 1);
        } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          const metadata = await stat(path).catch(() => null);
          if (metadata) found.push({ path, mtimeMs: metadata.mtimeMs });
        }
      }
    };
    await visit(this.sessionsDir, 0);
    return found.sort((left, right) => right.mtimeMs - left.mtimeMs).slice(0, this.maxFiles);
  }

  private async readFileSnapshot(file: RecentFile): Promise<ProviderUsageSnapshot | null> {
    const content = await readFile(file.path, 'utf8').catch(() => null);
    if (!content) return null;
    const lines = content.split('\n');
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index].trim();
      if (!line) continue;
      try {
        const event = JSON.parse(line) as unknown;
        const parsed = parseCodexEvent(event, file.mtimeMs);
        if (parsed) return parsed;
      } catch {
        // Corrupt lines do not invalidate other recent session data.
      }
    }
    return null;
  }
}

function parseCodexEvent(event: unknown, fallbackTimestamp: number): ProviderUsageSnapshot | null {
  if (!isRecord(event)) return null;
  const payload =
    event.type === 'event_msg' && isRecord(event.payload)
      ? event.payload
      : event.type === 'token_count'
        ? event
        : null;
  if (!payload || payload.type !== 'token_count' || !isRecord(payload.rate_limits)) return null;

  const windows: ProviderUsageSnapshot['windows'] = [];
  for (const [id, label, primary] of [
    ['primary', 'Primary', true],
    ['secondary', 'Secondary', false],
  ] as const) {
    const value = payload.rate_limits[id];
    if (value === null || value === undefined) continue;
    if (!isRecord(value) || !Number.isFinite(value.used_percent)) continue;
    const resetsAt = Number.isFinite(value.resets_at)
      ? new Date((value.resets_at as number) * 1_000).toISOString()
      : null;
    windows.push({
      id,
      label,
      primary,
      utilization: clampPercent(value.used_percent as number),
      resetsAt,
    });
  }
  if (windows.length === 0) return null;
  if (!windows.some((window) => window.primary)) windows[0].primary = true;
  const timestamp = typeof event.timestamp === 'string' ? Date.parse(event.timestamp) : NaN;
  return {
    provider: 'codex',
    windows,
    lastUpdated: new Date(Number.isFinite(timestamp) ? timestamp : fallbackTimestamp).toISOString(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}
