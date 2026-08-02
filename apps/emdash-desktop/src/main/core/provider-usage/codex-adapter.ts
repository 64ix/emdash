import { open, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { err, ok, type Result } from '@emdash/shared';
import type { ProviderUsageError, ProviderUsageSnapshot } from '@shared/core/provider-usage';
import type { ProviderUsageAdapter } from './types';

export type CodexUsageAdapterDependencies = {
  env?: Record<string, string | undefined>;
  homeDir?: string;
  maxFiles?: number;
  maxFileBytes?: number;
};

type RecentFile = { path: string; mtimeMs: number };

const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;

export class CodexUsageAdapter implements ProviderUsageAdapter {
  readonly provider = 'codex' as const;
  private readonly env: Record<string, string | undefined>;
  private readonly homeDir: string;
  private readonly maxFiles: number;
  private readonly maxFileBytes: number;

  constructor(deps: CodexUsageAdapterDependencies = {}) {
    this.env = deps.env ?? process.env;
    this.homeDir = deps.homeDir ?? homedir();
    this.maxFiles = deps.maxFiles ?? 5;
    this.maxFileBytes = deps.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  }

  async isAvailable(): Promise<Result<boolean, ProviderUsageError>> {
    try {
      return ok((await stat(this.sessionsDir())).isDirectory());
    } catch (error) {
      if (isFileNotFoundError(error)) return ok(false);
      return err({
        code: 'unreadable-data',
        message: 'Codex sessions could not be inspected.',
      });
    }
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
    await visit(this.sessionsDir(), 0);
    return found.sort((left, right) => right.mtimeMs - left.mtimeMs).slice(0, this.maxFiles);
  }

  private sessionsDir(): string {
    return join(this.env.CODEX_HOME || join(this.homeDir, '.codex'), 'sessions');
  }

  private async readFileSnapshot(file: RecentFile): Promise<ProviderUsageSnapshot | null> {
    const content = await readFileTail(file.path, this.maxFileBytes);
    if (!content) return null;
    let lineEnd = content.length;
    while (lineEnd > 0) {
      const lineStart = content.lastIndexOf('\n', lineEnd - 1);
      const line = content.slice(lineStart + 1, lineEnd).trim();
      lineEnd = lineStart;
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

async function readFileTail(path: string, maxBytes: number): Promise<string | null> {
  const handle = await open(path, 'r').catch(() => null);
  if (!handle) return null;
  try {
    const metadata = await handle.stat();
    const boundedBytes = Math.max(1, maxBytes);
    const tailStart = Math.max(0, metadata.size - boundedBytes);
    const readStart = tailStart > 0 ? tailStart - 1 : 0;
    const buffer = Buffer.alloc(metadata.size - readStart);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await handle.read(
        buffer,
        bytesRead,
        buffer.length - bytesRead,
        readStart + bytesRead
      );
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    let content = buffer.subarray(0, bytesRead).toString('utf8');
    if (tailStart > 0) {
      const firstNewline = content.indexOf('\n');
      if (firstNewline < 0) return null;
      content = content.slice(firstNewline + 1);
    }
    return content;
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
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

  const primary = parseCodexWindow(payload.rate_limits.primary, 'primary', 'Primary', true);
  if (!primary) return null;
  const windows: ProviderUsageSnapshot['windows'] = [primary];
  const secondaryValue = payload.rate_limits.secondary;
  if (secondaryValue !== null && secondaryValue !== undefined) {
    const secondary = parseCodexWindow(secondaryValue, 'secondary', 'Secondary', false);
    if (!secondary) return null;
    windows.push(secondary);
  }
  const timestamp = typeof event.timestamp === 'string' ? Date.parse(event.timestamp) : NaN;
  return {
    provider: 'codex',
    windows,
    lastUpdated: new Date(Number.isFinite(timestamp) ? timestamp : fallbackTimestamp).toISOString(),
  };
}

function parseCodexWindow(
  value: unknown,
  id: string,
  label: string,
  primary: boolean
): ProviderUsageSnapshot['windows'][number] | null {
  if (!isRecord(value) || !Number.isFinite(value.used_percent)) return null;
  let resetsAt: string | null = null;
  if (value.resets_at !== null && value.resets_at !== undefined) {
    if (!Number.isFinite(value.resets_at)) return null;
    const resetDate = new Date((value.resets_at as number) * 1_000);
    if (!Number.isFinite(resetDate.getTime())) return null;
    resetsAt = resetDate.toISOString();
  }
  return {
    id,
    label,
    primary,
    utilization: clampPercent(value.used_percent as number),
    resetsAt,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFileNotFoundError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function clampPercent(value: number): number {
  return Math.max(0, Math.min(100, value));
}
