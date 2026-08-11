import { win32 } from 'node:path';

export type CommandSpec = { command: string; args: string[] };

function getEnvValue(env: Record<string, string | undefined>, key: string): string | undefined {
  const normalizedKey = key.toLowerCase();
  const entry = Object.entries(env).find(
    ([candidate]) => candidate.toLowerCase() === normalizedKey
  );
  return entry?.[1];
}

/** Quote a single argv token for the cmd.exe command line. */
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

/** True for a bare command name (no path separators, no extension), e.g. `npm`. */
function isBareWindowsCommand(command: string): boolean {
  return !command.includes('/') && !command.includes('\\') && win32.extname(command) === '';
}

/**
 * Node cannot spawn Windows .cmd/.bat shims (or bare npm-style command names that
 * only resolve to shims via PATHEXT) directly — it fails with EINVAL. Route those
 * through cmd.exe and quote each argv token explicitly instead of enabling
 * `shell: true`.
 *
 * Real executables (.exe, absolute paths, etc.) and non-Windows platforms are
 * returned unchanged.
 */
export function resolveWindowsCommandSpec(
  spec: { command: string; args: string[]; env?: Record<string, string | undefined> },
  platform: NodeJS.Platform = process.platform
): CommandSpec {
  if (platform !== 'win32') return { command: spec.command, args: spec.args };

  const extension = win32.extname(spec.command).toLowerCase();
  const needsCmdExe =
    extension === '.cmd' || extension === '.bat' || isBareWindowsCommand(spec.command);
  if (!needsCmdExe) return { command: spec.command, args: spec.args };

  const commandLine = [spec.command, ...spec.args].map(quoteForCmdExe).join(' ');
  const command =
    getEnvValue(spec.env ?? {}, 'ComSpec') ??
    getEnvValue(process.env, 'ComSpec') ??
    'C:\\Windows\\System32\\cmd.exe';
  return {
    command,
    args: ['/d', '/s', '/c', wrapCmdExeCommandLine(commandLine)],
  };
}
