import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import type {
  AcpFs,
  AcpProcessHandle,
  AcpTerminalExit,
  AcpTerminalProcess,
} from '@emdash/core/acp';
import { resolveWindowsCommandSpec } from '@emdash/core/exec';
import type { AcpRuntimeProcessHost } from '../runtime/types';

type ChildProcessSpawnSpec = {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
};

/**
 * Node cannot spawn Windows .cmd/.bat shims directly. Route only those files
 * (and bare command names that resolve to shims via PATHEXT) through cmd.exe,
 * quoting each argv token explicitly instead of enabling `shell: true`.
 * Canonical implementation: resolveWindowsCommandSpec in @emdash/core/exec.
 */
export function resolveChildProcessSpawnSpec(
  spec: ChildProcessSpawnSpec,
  platform: NodeJS.Platform = process.platform
): Pick<ChildProcessSpawnSpec, 'command' | 'args'> {
  return resolveWindowsCommandSpec(spec, platform);
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
