# Auto-approve in ACP via the provider's own spawn bypass, scoped by the connection pool key

**Status:** accepted — OpenCode chatUI parity (Spec "OpenCode chatUI parity").

The conversation-level "Auto-approve permissions" toggle was silently
ignored by ACP conversations: it was persisted, surfaced on the
conversation object, and dropped at the ACP start input — every tool
permission still reached the UI for a manual click. Two candidate
mechanisms: (a) auto-respond to every permission request inside the
session manager (provider-agnostic, per-conversation by construction), or
(b) launch the provider's ACP process with its own bypass, mirroring the
TUI path.

**Decision:** (b). OpenCode accepts `OPENCODE_PERMISSION={"*":"allow"}` as
an environment override applied after config files, so the provider's own
`deny` rules in `opencode.json` survive — something an emdash-side
auto-response cannot promise (it would allow anything the provider chooses
to ask about). The TUI path already uses the same env override, keeping
the two conversation surfaces consistent.

**Consequence:** ACP connections are pooled per provider + workspace, and
the env applies per process. The pool key therefore gains the
conversation's auto-approve flag, so one conversation's setting never leaks
into another conversation of the same workspace (two `opencode acp`
processes can coexist per workspace when the conversations differ).

**General gap note:** the wire field and the pool-key change are
provider-agnostic and benefit every ACP-capable provider; only OpenCode
gets the env lever today (Claude and Codex ACP adapters have no equivalent
flag — wiring them is out of scope for now).
