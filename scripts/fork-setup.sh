#!/bin/sh
# Apply this fork's per-machine invariants. Idempotent: safe to re-run.
#
# The repo carries the guard script, its Claude Code registration and the docs.
# Everything below lives outside the repo — in `.git/config`, in `~/.codex/`, in
# the emdash app's database — so a fresh clone or a new machine starts without
# it. That gap is what produced generalaction/emdash#2976; see FORK.md →
# "Local clone invariants".
#
#   sh scripts/fork-setup.sh

set -u

FORK_REPO=64ix/emdash
WORK_BRANCH=fork-main
CODEX_HOME=${CODEX_HOME:-$HOME/.codex}

ok() { printf '  \033[32mok\033[0m    %s\n' "$1"; }
set_() { printf '  \033[36mset\033[0m   %s\n' "$1"; }
warn() { printf '  \033[33mwarn\033[0m  %s\n' "$1"; }
todo() { printf '  \033[35mtodo\033[0m  %s\n' "$1"; }
step() { printf '\n%s\n' "$1"; }

script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
repo=$(git -C "$script_dir" rev-parse --show-toplevel 2>/dev/null) || {
  printf 'not a git checkout: %s\n' "$script_dir" >&2
  exit 1
}

case $(git -C "$repo" remote get-url origin 2>/dev/null) in
  *"$FORK_REPO"*) ;;
  *)
    printf 'origin is not %s — wrong checkout, refusing to configure it.\n' "$FORK_REPO" >&2
    exit 1
    ;;
esac

# Report what Codex actually resolves, including each hook's trust status.
check_codex() {
  command -v codex >/dev/null 2>&1 || {
    printf 'codex not installed\n' >&2
    exit 1
  }
  printf 'Codex hooks for %s\n' "$repo"
  {
    printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"fork-setup","version":"0"}}}\n'
    printf '{"jsonrpc":"2.0","id":2,"method":"hooks/list","params":{"cwds":["%s"]}}\n' "$repo"
    perl -e 'select undef,undef,undef,6' 2>/dev/null || :
  } | codex app-server 2>/dev/null | grep '"id":2' |
    jq -r '.result.data[0].hooks[]? | "  \(.trustStatus)\t\(.eventName)\t\(.command)"'
  printf '\nAn "untrusted" hook is skipped silently. Approve it by running `codex` here.\n'
}

case ${1:-} in
  --check-codex)
    check_codex
    exit 0
    ;;
  -h | --help)
    printf 'usage: sh scripts/fork-setup.sh [--check-codex]\n'
    exit 0
    ;;
  '') ;;
  *)
    printf 'unknown argument: %s\n' "$1" >&2
    exit 2
    ;;
esac

printf 'Configuring %s\n' "$repo"

step 'git — upstream is read-only'
if [ "$(git -C "$repo" config --get remote.upstream.pushurl || true)" = DISABLED ]; then
  ok 'upstream push URL already DISABLED'
elif git -C "$repo" remote get-url upstream >/dev/null 2>&1; then
  git -C "$repo" remote set-url --push upstream DISABLED
  set_ 'upstream push URL -> DISABLED (fetch still works)'
else
  warn 'no upstream remote; add it with:'
  warn '  git remote add upstream https://github.com/generalaction/emdash.git'
fi

step "git — default branch is $WORK_BRANCH"
head_ref=$(git -C "$repo" symbolic-ref refs/remotes/origin/HEAD 2>/dev/null || true)
if [ "$head_ref" = "refs/remotes/origin/$WORK_BRANCH" ]; then
  ok "origin/HEAD already -> $WORK_BRANCH"
elif git -C "$repo" rev-parse --verify --quiet "refs/remotes/origin/$WORK_BRANCH" >/dev/null; then
  git -C "$repo" remote set-head origin "$WORK_BRANCH"
  set_ "origin/HEAD -> $WORK_BRANCH (was ${head_ref:-unset})"
else
  warn "no origin/$WORK_BRANCH ref yet — run git fetch origin, then re-run this script"
fi

step 'gh — base repo is the fork, not the parent'
if [ "$(git -C "$repo" config --get remote.origin.gh-resolved || true)" = base ]; then
  ok "gh resolves to $FORK_REPO"
else
  git -C "$repo" config remote.origin.gh-resolved base
  set_ "gh resolves to $FORK_REPO (what gh repo set-default writes)"
fi
warn 'this pins bare `gh issue ...`; `gh pr create` still needs --repo explicitly'

step 'guard script'
guard=$repo/.claude/hooks/guard-fork-remote.sh
if [ ! -f "$guard" ]; then
  warn "missing $guard — is this checkout up to date with $WORK_BRANCH?"
elif [ -x "$guard" ]; then
  ok 'executable'
else
  chmod +x "$guard"
  set_ 'made executable'
fi

step 'Codex — register the guard (it has no project-scoped hook source)'
if [ ! -f "$guard" ]; then
  warn 'skipped: guard script missing'
elif ! command -v jq >/dev/null 2>&1; then
  warn 'skipped: jq not found (needed to edit hooks.json without clobbering it)'
else
  hooks_file=$CODEX_HOME/hooks.json
  mkdir -p "$CODEX_HOME"
  [ -f "$hooks_file" ] || printf '{}\n' > "$hooks_file"
  before=$(cat "$hooks_file")
  updated=$(printf '%s' "$before" | jq --arg cmd "$guard" '
    .hooks //= {} |
    .hooks.PreToolUse = (
      ((.hooks.PreToolUse // []) | map(select(
        [.hooks[]?.command] | any(. == $cmd) | not
      ))) + [{
        matcher: "Bash|shell|exec_command|local_shell",
        hooks: [{ type: "command", command: $cmd }]
      }]
    )') || {
    warn "could not parse $hooks_file — left untouched"
    updated=
  }
  if [ -z "${updated:-}" ]; then
    :
  elif [ "$(printf '%s' "$before" | jq -S .)" = "$(printf '%s' "$updated" | jq -S .)" ]; then
    ok "already registered in $hooks_file"
  else
    printf '%s\n' "$updated" > "$hooks_file"
    set_ "registered in $hooks_file (other hooks preserved)"
  fi
  todo 'approve it once: run `codex` here and accept the startup hook review'
  todo 'an unapproved Codex hook is skipped SILENTLY; editing the guard re-arms this'
fi

step 'emdash app — worktree base branch'
found=
for db in "$HOME/Library/Application Support/emdash/"emdash*.db "$HOME/.config/emdash/"emdash*.db; do
  [ -f "$db" ] || continue
  command -v sqlite3 >/dev/null 2>&1 || break
  row=$(sqlite3 "$db" "select s.base_project_settings_json from projects p
    join project_settings s on s.project_id = p.id
    where p.path = '$repo';" 2>/dev/null) || continue
  [ -n "$row" ] || continue
  found=yes
  branch=$(printf '%s' "$row" | jq -r '.defaultBranch // "unset"' 2>/dev/null || echo '?')
  if [ "$branch" = "$WORK_BRANCH" ]; then
    ok "defaultBranch is $WORK_BRANCH ($(basename "$db"))"
  else
    warn "defaultBranch is '$branch', not $WORK_BRANCH ($(basename "$db"))"
    todo "fix it in the app's project settings — every task worktree is cut from it,"
    todo "and a stale value silently starts every agent on upstream's code"
  fi
done
[ -n "$found" ] || ok 'project not registered in the app here — nothing to check'

step 'Done. Read the Codex hook trust status back with:'
printf '  sh scripts/fork-setup.sh --check-codex\n'
