# Managed Skill reach via `skills.paths` injection, no per-provider mirroring yet

**Status:** accepted — OpenCode chatUI parity (Spec "OpenCode chatUI parity").

Managed Skills (installed from the emdash Skills library into the shared
root `~/.agentskills`) must actually reach the agent CLIs. OpenCode's skill
discovery covers `.opencode/skills`, `~/.config/opencode/skills`,
`.claude/skills`, `.agents/skills` and the `skills.paths` config key — but
not the shared root — so library installs were dead weight for OpenCode,
and for every provider whose discovery list the root is absent from.

**Decision:** for OpenCode, point `skills.paths` at the shared root in the
`opencode.json` file emdash already manages (merge-safe: user-provided
paths preserved and deduplicated, no other keys touched). Provider-native
skill directories stay untouched — Provider-Native Skills remain
provider-owned.

**Why not upstream's `jan/eng-1803`** (detection + per-provider mirroring +
external-skill adoption + SSH support)? It is unapproved upstream, 14
commits across 57 files, and its commits conflict mechanically with the
fork's base. The slice chosen here is one config key. When eng-1803 lands
via the weekly upstream sync (and is approved), revisit: its mirroring
subsumes `skills.paths` (managed skills then get mirrored into each
provider's native directory) and the injection can be dropped without
migration.

**Trade-off accepted:** OpenCode is the only provider wired this way today
(Claude and Codex still don't see Managed Skills in ACP). Injection is
OpenCode-native, cheap, and fully reversible.
