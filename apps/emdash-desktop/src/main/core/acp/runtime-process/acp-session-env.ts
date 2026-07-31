/**
 * Builds the trusted env override merged into an ACP session-start/resume
 * input by the main process (see `withProviderEnv` in `host.ts`).
 *
 * `EMDASH_TASK_ID` lets agent CLIs discover the task they are running in —
 * e.g. to stamp the `Emdash-Task: <task-id>` Task Marker line into a Spec or
 * Map issue body they publish (see docs/agents/issue-tracker.md). It is not
 * sourced from the host's ambient environment, so it never needs to be added
 * to an env passthrough allowlist: it is a value the trusted main process
 * already knows for every task-scoped ACP session, exactly like the
 * `EMDASH_TASK_ID` merged into task-scoped PTY sessions via `taskEnvVars`
 * (see `apps/emdash-desktop/src/main/core/workspaces/workspace-env.ts`).
 *
 * `taskId` is applied last so it cannot be shadowed by a user-configured
 * per-provider env var (Settings), mirroring the precedence already used for
 * the PTY path where `taskEnvVars` is spread after `providerVars`.
 */
export function buildAcpSessionEnv(
  taskId: string,
  providerEnv: Record<string, string> | undefined
): Record<string, string> {
  return { ...providerEnv, EMDASH_TASK_ID: taskId };
}
