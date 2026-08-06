import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { win32 } from 'node:path';
import type {
  AcpFs,
  AcpProcessHandle,
  AcpTerminalExit,
  AcpTerminalProcess,
} from '@emdash/core/acp';
import type { AcpRuntimeProcessHost } from '../runtime/types';

type ChildProcessSpawnSpec = {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
};

function getEnvValue(env: Record<string, string | undefined>, key: string): string | undefined {
  const normalizedKey = key.toLowerCase();
  const entry = Object.entries(env).find(
    ([candidate]) => candidate.toLowerCase() === normalizedKey
  );
  return entry?.[1];
}

function quoteForCmdExe(input: string): string {
  if (input.length === 0) return '""';
  if (!/[\s"^&|<>()%!]/.test(input)) return input;
  return `"${input
    .replace(/%/g, '%%')
    .replace(/!/g, '^!')
    .replace(/(["^&|<>()])/g, '^$1')}"`;
}

function wrapCmdExeCommandLine(commandLine: string): string {
  return commandLine.startsWith('"') ? `"${commandLine}"` : commandLine;
}

/**
 * Node cannot spawn Windows .cmd/.bat shims directly. Route only those files through
 * cmd.exe and quote each argv token explicitly instead of enabling `shell: true`.
 */
export function resolveChildProcessSpawnSpec(
  spec: ChildProcessSpawnSpec,
  platform: NodeJS.Platform = process.platform
): Pick<ChildProcessSpawnSpec, 'command' | 'args'> {
  if (platform !== 'win32') return { command: spec.command, args: spec.args };

  const extension = win32.extname(spec.command).toLowerCase();
  if (extension !== '.cmd' && extension !== '.bat') {
    return { command: spec.command, args: spec.args };
  }

  const commandLine = [spec.command, ...spec.args].map(quoteForCmdExe).join(' ');
  const command =
    getEnvValue(spec.env, 'ComSpec') ??
    getEnvValue(process.env, 'ComSpec') ??
    'C:\\Windows\\System32\\cmd.exe';
  return {
    command,
    args: ['/d', '/s', '/c', wrapCmdExeCommandLine(commandLine)],
  };
}

class ChildProcessHandle implements AcpProcessHandle {
  constructor(private readonly child: ReturnType<typeof spawn>) {}

  get stdin() {
    if (!this.child.stdin) throw new Error('ChildAcpProcessHost: child has no stdin');
    return this.child.stdin;
  }

  get stdout() {
    if (!this.child.stdout) throw new Error('ChildAcpProcessHost: child has no stdout');
    return this.child.stdout;
  }

  get stderr() {
    return this.child.stderr ?? undefined;
  }

  get exitCode() {
    return this.child.exitCode;
  }

  onExit(cb: (code: number | null) => void): void {
    this.child.on('exit', (code) => cb(code));
  }

  onError(cb: (err: Error) => void): void {
    this.child.on('error', cb);
  }

  kill(signal?: NodeJS.Signals): void {
    this.child.kill(signal ?? 'SIGTERM');
  }
}

class ChildTerminalProcess extends EventEmitter implements AcpTerminalProcess {
  private _exitCode: number | null = null;

  constructor(private readonly child: ReturnType<typeof spawn>) {
    super();
    child.on('exit', (code, signal) => {
      this._exitCode = code;
      this.emit('exit', { exitCode: code, signal: signal ?? null } satisfies AcpTerminalExit);
    });
    child.on('error', (err) => this.emit('error', err));
  }

  get stdout() {
    if (!this.child.stdout) throw new Error('ChildTerminalProcess: child has no stdout');
    return this.child.stdout;
  }

  get stderr() {
    return this.child.stderr ?? undefined;
  }

  get exitCode() {
    return this._exitCode;
  }

  onExit(cb: (status: AcpTerminalExit) => void): void {
    this.on('exit', cb);
  }

  onError(cb: (err: Error) => void): void {
    this.on('error', cb);
  }

  kill(signal?: NodeJS.Signals): void {
    this.child.kill(signal ?? 'SIGTERM');
  }
}

const fsPort: AcpFs = {
  readFile: (path, encoding) => readFile(path, encoding),
  writeFile: (path, content, encoding) => writeFile(path, content, encoding),
  mkdir: (path, opts) => mkdir(path, opts),
};

export class ChildAcpProcessHost implements AcpRuntimeProcessHost {
  readonly fs = fsPort;

  async spawn(spec: {
    command: string;
    args: string[];
    env: Record<string, string>;
    cwd: string;
  }): Promise<AcpProcessHandle> {
    const resolved = resolveChildProcessSpawnSpec(spec);
    const child = spawn(resolved.command, resolved.args, {
      cwd: spec.cwd,
      env: spec.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    if (!child.stdin || !child.stdout) {
      throw new Error('ChildAcpProcessHost: failed to spawn process - no stdio streams');
    }
    return new ChildProcessHandle(child);
  }

  async spawnTerminal(spec: {
    command: string;
    args: string[];
    env: Record<string, string>;
    cwd: string;
  }): Promise<AcpTerminalProcess> {
    const resolved = resolveChildProcessSpawnSpec(spec);
    const child = spawn(resolved.command, resolved.args, {
      cwd: spec.cwd,
      env: spec.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (!child.stdout) {
      throw new Error('ChildAcpProcessHost: failed to spawn terminal - no stdout stream');
    }
    return new ChildTerminalProcess(child);
  }
}
