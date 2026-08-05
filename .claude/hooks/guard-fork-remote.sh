#!/bin/sh
# PreToolUse guard for the 64ix/emdash fork. Shared by two agents:
#   - Claude Code — registered per-project in `.claude/settings.json`
#   - Codex       — registered per-user in `~/.codex/hooks.json` (Codex has no
#                   project-scoped hook source, so the cwd gate below is what
#                   keeps it inert in every other repo)
#
# Blocks the three ways an agent has actually sent work to the wrong place:
#   1. pushing to `upstream`
#   2. a gh write aimed at `generalaction/emdash`
#   3. `gh pr create` that does not name the fork and `fork-main` explicitly
#      (gh defaults a fork's base repo to the PARENT — that is how
#      generalaction/emdash#2976 was opened)
#
# Reads the PreToolUse JSON on stdin. exit 2 = block, stderr goes back to the
# agent, so every message says what to run instead.
#
# Never blocked: reads (gh pr/issue view|list|diff, gh api without a write
# --method, git fetch upstream), and merely *mentioning* any of these strings.
# The command is split into segments on `;`, `&`, `|` and newlines, and each
# rule is anchored at command position within its own segment — so
# `grep "gh pr create"`, docs quoting the strings, and
# `gh pr view -R generalaction/... && gh pr comment --repo 64ix/...` all pass,
# and one segment's repo flag cannot vouch for another's.

payload=$(cat) || exit 0

# Codex's shell tool may pass `command` as an argv array; join it on newlines
# rather than spaces so each element keeps its own command position.
cmd=$(printf '%s' "$payload" | jq -r '
  def flat: if type == "array" then map(tostring) | join("\n") else tostring end;
  (.tool_input.command // .tool_input.cmd // "") | flat' 2>/dev/null) || exit 0
[ -n "$cmd" ] || exit 0

# Scope gate. The Claude registration is already project-local, but the Codex
# one is global: do nothing unless this session is in a checkout of our fork.
# Matching on origin rather than on a path covers every worktree for free.
cwd=$(printf '%s' "$payload" | jq -r '.cwd // ""' 2>/dev/null)
[ -n "$cwd" ] || cwd=$PWD
case $(git -C "$cwd" remote get-url origin 2>/dev/null) in
  *64ix/emdash*) ;;
  *) exit 0 ;;
esac

has() { printf '%s' "$seg" | grep -qE "$1"; }

block() {
  printf 'BLOCKED by .claude/hooks/guard-fork-remote.sh\n\n%s\n' "$1" >&2
  exit 2
}

# Command position inside a segment: its start, or right after a `$(`.
AT='(^|\$\()[[:space:]]*'
Q='["'"'"']?'

GH_WRITE="${AT}gh[[:space:]]+[a-z-]+[[:space:]]+(create|edit|comment|close|reopen|merge|review|delete|ready|lock|transfer|sync|upload)([[:space:]]|\$)"
GH_API_WRITE="${AT}gh[[:space:]]+api.*(--method|-X)[[:space:]]*=?[[:space:]]*(POST|PUT|PATCH|DELETE)"
UPSTREAM="(--repo|-R)[[:space:]=]+${Q}generalaction/emdash|repos/generalaction/emdash|generalaction/emdash\.git"

set -f # a segment may contain `*`; do not let `for` glob it
segments=$(printf '%s' "$cmd" | tr ';&|' '\n\n\n')
IFS='
'
for seg in $segments; do
  [ -n "$seg" ] || continue

  if has "${AT}git[[:space:]]+push" &&
    { has "[[:space:]]upstream([[:space:]]|\$)" || has 'generalaction/emdash'; }; then
    block 'Never push to upstream (generalaction/emdash). It is a read-only remote:
fetch for rebases, nothing else. Push to origin (64ix/emdash) instead:

  git push -u origin <branch>'
  fi

  if { has "$GH_WRITE" || has "$GH_API_WRITE"; } && has "$UPSTREAM"; then
    block 'Write aimed at generalaction/emdash. Upstream is read-only — issues, PRs
and comments all live on the fork. Reading upstream is fine
(gh pr view/list/diff, gh issue view/list, gh api without a write --method,
git fetch upstream).

Retarget the fork:  --repo 64ix/emdash'
  fi

  if has "${AT}gh[[:space:]]+pr[[:space:]]+create"; then
    has "(--repo|-R)[[:space:]=]+${Q}64ix/emdash" ||
      block 'gh pr create without an explicit --repo. For a fork, gh resolves the base
repo to the PARENT (generalaction/emdash) — this is exactly how PR #2976
landed upstream. Always name the fork:

  gh pr create --repo 64ix/emdash --base fork-main --title ... --body ...'

    has "\-\-base[[:space:]=]+${Q}fork-main" ||
      block 'gh pr create without --base fork-main. `main` is a pristine mirror of
upstream and must never receive commits: merging there is a silent
failure — the PR reads as merged and the code never reaches the branch
the app is built from (happened with PR #13).

  gh pr create --repo 64ix/emdash --base fork-main --title ... --body ...

Then read the base back:  gh pr view <n> --json baseRefName -q .baseRefName'
  fi
done

exit 0
