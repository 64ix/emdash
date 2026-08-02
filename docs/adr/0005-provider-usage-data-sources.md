# Provider Usage: read the CLIs' own credentials/artifacts, no emdash-side accounts

Usage Gauges (account-level rate-limit meters for Claude and Codex) get
their data by piggybacking on what the provider CLIs already have on the
local machine — emdash never runs its own auth flow and never persists a
credential. Approach ported from nimbalyst (MIT), which proved both paths
in production:

- **Claude — OAuth usage API.** Read Claude Code's OAuth access token the
  way the CLI itself resolves it (macOS Keychain via `security`, falling
  back to `<config dir>/.credentials.json`, honoring `CLAUDE_CONFIG_DIR`)
  and call `https://api.anthropic.com/api/oauth/usage`, which returns
  utilization % and reset times for the 5-hour, 7-day, and 7-day-Opus
  windows. The API is undocumented but is what nimbalyst and ClaudeBar
  ship on; it is the only source for the weekly windows. The token stays
  in main-process memory only.
- **Codex — local session-file parsing.** Parse recent files under
  `~/.codex/sessions` (honoring `CODEX_HOME`) for `token_count` events
  carrying `rate_limits` (primary/secondary windows, used %, resets). No
  credential is touched. Trade-off: data is only as fresh as the last
  Codex turn — accepted, since the gauge only matters when Codex is in
  use. The Codex app-server account API (nimbalyst's primary path) was
  rejected for now: emdash has no app-server client and the extra infra
  isn't worth it for a meter.
- **Local machine only.** SSH workspaces consume the remote host's
  accounts; reading remote credentials/sessions over SFTP was rejected
  (multi-account ambiguity, latency, security surface). In the common
  same-account-everywhere case the Claude API figure is global anyway.
- **Activity-aware polling.** Immediate refresh when a prompt is sent to
  the provider, periodic poll (~30 min) while active, sleep after ~60 min
  idle — no background traffic when emdash sits unused.

Also rejected: parsing `~/.claude` transcripts for Claude (no reliable
weekly data), shelling out to a `claude usage` command (unstable output),
and calling the ChatGPT backend with `~/.codex/auth.json` (second
undocumented API, more fragile). Lives as a dedicated main-process domain
(`src/main/core/provider-usage/`), not a plugin capability — two adapters
don't justify extending the plugin capability schema; revisit if a third
provider grows a usage source.
