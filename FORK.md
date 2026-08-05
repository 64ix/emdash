# Fork notes — 64ix/emdash (« fork-main »)

Fork of [generalaction/emdash](https://github.com/generalaction/emdash) carrying the
feature-workflow kanban used by agent-cockpit. Specs and backlog live in the
`agent-cockpit` repo (wayfinder → grill → spec → tickets flow); one feature = one
spec = one PR onto `fork-main`.

## Branch model

- `main` — pristine mirror of `upstream/main`. Never commit here.
- `fork-main` — default working branch: `main` + our commits. Rebase onto upstream
  release tags (`git fetch upstream --tags && git rebase <tag>`). Every branch is cut
  from here, and `origin/HEAD` is repointed at it locally (see "Local clone
  invariants") so tooling that reads the repo's default branch gets `fork-main`.

> [!WARNING]
> **Every fork PR must target `fork-main`, on `64ix/emdash`.** Both halves fail
> silently — nothing errors either way.
>
> *Wrong repo:* `gh` resolves a fork's base repo to the **parent**, so an unqualified
> `gh pr create` opens the PR on `generalaction/emdash`. That is how **PR #2976**
> happened: a worktree cut off `main` (the app's project `defaultBranch` was
> `origin/main` at the time), a fix nobody asked for, written against upstream's
> version rather than ours, proposed to upstream.
>
> *Wrong branch:* the PR shows as merged, but the code never reaches the branch the app
> is built from, so the feature is simply absent at runtime, and the weekly Upstream
> Sync's `git merge --ff-only upstream/main` starts failing because `main` can no
> longer fast-forward.
>
> Before you edit, check what you are standing on:
>
> ```bash
> git merge-base --is-ancestor origin/fork-main HEAD || echo "WRONG BASE — rebase onto origin/fork-main"
> ```
>
> Before opening a PR, name both explicitly; after, read the base back:
>
> ```bash
> gh pr create --repo 64ix/emdash --base fork-main   # never rely on either default
> gh pr view <n> --json baseRefName -q .baseRefName   # must print: fork-main
> ```
>
> After merging anything, confirm it actually landed:
>
> ```bash
> git fetch origin && git log --oneline origin/main..origin/fork-main | head
> git log --oneline origin/fork-main..origin/main   # MUST be empty
> ```
>
> `.github/workflows/main-mirror-guard.yml` checks this **daily** (and on
> `workflow_dispatch`), opening an issue with remediation commands when `main` drifts.
> It cannot be push-triggered: for push events GitHub loads the workflow file from the
> pushed branch, and `main` mirrors upstream, so it will never carry the guard. The
> daily run is therefore a safety net, not a merge-time gate — **the base check above
> is still yours to do.**
>
> **Happened once:** PR #13 ([Spec #11] Auto-generated Conversation Titles) was merged
> to `main`. The feature was missing from every build for a day with no error anywhere;
> the fix was a cherry-pick onto `fork-main` plus restoring `main` to the upstream sha.

## Local clone invariants

The repo carries the guard script, its Claude Code registration and these docs. The
invariants below live in `.git/config`, in `~/.codex/` and in the emdash app's database,
so **they do not travel with the repo** — that gap is what produced PR #2976. One
idempotent command applies them per clone, and reports what only you can do:

```bash
sh scripts/fork-setup.sh
```

It refuses to run against a checkout whose `origin` is not `64ix/emdash`. What it does,
should you want it by hand:

```bash
git remote set-head origin fork-main            # origin/HEAD -> fork-main, not main
git remote set-url --push upstream DISABLED     # `git push upstream` fails loudly; fetch still works
git config remote.origin.gh-resolved base       # what `gh repo set-default 64ix/emdash` writes
```

plus the Codex registration below, `chmod +x` on the guard, and a read-only check of the
app's `defaultBranch`. Verify:

```bash
git symbolic-ref refs/remotes/origin/HEAD       # refs/remotes/origin/fork-main
git remote -v | grep upstream                   # push URL must read DISABLED
git config --get remote.origin.gh-resolved      # base
sh scripts/fork-setup.sh --check-codex          # trust status of the Codex hook
```

GitHub's default branch for the fork is already `fork-main`, so a clone made today gets
`origin/HEAD` right on its own; `set-head` is there to repair checkouts predating that,
and this one had drifted. It matters more than it looks: agent harnesses derive "the
repo's main branch" from `origin/HEAD` and state it in their session preamble, so a stale
ref tells every agent to target `main` before it has read a line of these docs. The
`--repo` risk is the one no default fixes — `gh` resolves a fork's base repo to the
**parent** regardless.

**In the emdash app**, the project's `defaultBranch` must be `fork-main` and its
`baseRemote` `origin` (Project settings; stored in
`project_settings.base_project_settings_json`, not in `.emdash.json`). The app cuts
every task worktree from `getDefaultBranch()`, so a stale value here silently starts
every agent on upstream's code — no doc can compensate. The older
`projects.base_ref` column is only the fallback when `defaultBranch` is unset.

**Agent guard.** `.claude/hooks/guard-fork-remote.sh` is one `PreToolUse` script shared
by both agents. It blocks pushes to `upstream`, gh writes aimed at
`generalaction/emdash`, and any `gh pr create` that does not pass
`--repo 64ix/emdash --base fork-main`, explaining the correct form on stderr. Reads of
upstream stay allowed, and so does merely mentioning the strings — rules are anchored at
command position within each `;`/`&`/`|` segment. It accepts `tool_input.command` as a
string or as an argv array, and no-ops unless the session's cwd resolves to a checkout
whose `origin` is `64ix/emdash` (matching the remote, not a path, covers every worktree).
Test it without an agent:

```bash
printf '{"cwd":"%s","tool_input":{"command":"gh pr create --title x"}}' "$PWD" |
  .claude/hooks/guard-fork-remote.sh; echo "exit=$?"   # expect 2 + the guidance
```

*Claude Code* registers it per project in `.claude/settings.json`. Both files are
tracked (the script force-added past the `.claude/` ignore rule), so they reach every
worktree — nothing to redo per clone.

*Codex* (verified on codex-cli 0.146.0) has **no project-scoped hook source**: neither
`.codex/hooks.json`, nor `.codex/config.toml`, nor a root `hooks.json` is read. The only
non-plugin surface is `~/.codex/hooks.json`, whose format matches Claude Code's:

```json
{ "hooks": { "PreToolUse": [ { "matcher": "Bash|shell|exec_command|local_shell",
  "hooks": [ { "type": "command",
    "command": "/absolute/path/to/emdash/.claude/hooks/guard-fork-remote.sh" } ] } ] } }
```

That registration is global, which is exactly why the script gates on `origin` — in any
other repo it exits 0 before looking at the command. Being outside the repo, it is a
per-machine invariant like the git config above.

> [!IMPORTANT]
> A Codex hook does not run until it is **trusted**: it starts as
> `trustStatus: untrusted`, and an untrusted hook is skipped **silently** — the command
> runs unguarded and nothing is logged. Approve it in the `codex` TUI's startup hook
> review; the decision is recorded as `hook_trust` in `~/.codex/config.toml`. Trust is
> keyed by a hash of the hook, so **editing the script drops it back to `modified` and
> it must be re-approved.** Check the live state at any time with:
>
> ```bash
> { printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"p","version":"0"}}}\n'
>   printf '{"jsonrpc":"2.0","id":2,"method":"hooks/list","params":{"cwds":["%s"]}}\n' "$PWD"
>   perl -e 'select undef,undef,undef,6'
> } | codex app-server 2>/dev/null | grep '"id":2' |
>   jq -r '.result.data[0].hooks[] | "\(.trustStatus)\t\(.command)"'
> ```

## Automation

- `.github/workflows/fork-ci.yml` — typecheck + lint + tests on push/PR to `fork-main`.
  Run it after every upstream rebase before pushing.
- `.github/workflows/upstream-sync.yml` — weekly: fast-forwards `main` from upstream and
  opens/updates an issue when upstream commits touch the touchpoint files below.
  Keep its path list in sync with the table below.

## What we add

**Feature workflow board**: `tasks.workflow_stage` column + `workflowStages` enum
(`idea → grilled → spec → tickets → implementing → pr → shipped`, Matt Pocock
pipeline), orthogonal to emdash's own `tasks.status`. Kanban view per project,
reachable via the project titlebar dropdown → "Feature Board". Session counts per
card come from the existing `conversations`-per-task model.

## Core touchpoints (rebase conflict hotspots)

Keep this list current — everything else we write must stay additive.

| File | Change |
|------|--------|
| `apps/emdash-desktop/src/main/db/schema.ts` | `workflowStage` column on `tasks` |
| `apps/emdash-desktop/src/shared/core/tasks/tasks.ts` | `workflowStages` enum, `Task.workflowStage` |
| `apps/emdash-desktop/src/main/core/tasks/utils/utils.ts` | row → Task mapping |
| `apps/emdash-desktop/src/main/core/tasks/task-service.ts` | bind `updateTaskWorkflowStage` |
| `apps/emdash-desktop/src/main/core/tasks/controller.ts` | RPC method |
| `apps/emdash-desktop/src/renderer/features/tasks/stores/task-store.ts` | optimistic `updateWorkflowStage` |
| `apps/emdash-desktop/src/renderer/app/view-registry.ts` | register `board` view |
| `apps/emdash-desktop/src/renderer/features/projects/components/project-titlebar.tsx` | "Feature Board" menu entry |
| `apps/emdash-desktop/src/shared/telemetry.ts` | `FocusView` + `board_viewed` |
| `apps/emdash-desktop/src/renderer/lib/stores/navigation-store.ts` | `viewEvents` map |
| test DDL fixtures (`legacy-port/**/relational.test.ts`, `service.test.ts`, `createTask.test.ts`, `renameTask.test.ts`) | mirror the `tasks` DDL / row shape |
| `apps/emdash-desktop/vitest.config.ts` | `FORK_CI` exclude for PTY integration tests |
| `apps/emdash-desktop/package.json` | `package:fork` script (see "Personal macOS builds") |
| `.claude/settings.json` | `hooks.PreToolUse` → `guard-fork-remote.sh` (upstream write guard) |

Additive (no conflict risk): `features/board/`, `operations/updateTaskWorkflowStage.ts`,
`drizzle/0020_*.sql`, `scripts/fork-setup.sh`, `.claude/hooks/guard-fork-remote.sh`
(force-added: `.claude/` is gitignored, but tracking it is what puts the guard in every
worktree).

⚠️ Migration numbering: upstream also generates `drizzle/00NN_*.sql`. On every rebase,
check for a collision with our migrations and renumber ours (regenerate with
`pnpm db:generate`) if upstream claimed the slot.

## Dev setup gotchas

- Electron postinstall may fail silently (zip extract). Fix: download via
  `@electron/get`, extract with `ditto`, write `node_modules/electron/path.txt`
  containing `Electron.app/Contents/MacOS/Electron`.
- Build workspace packages before typechecking the app:
  `pnpm exec nx run-many -t build --projects "packages/*"`.
- Isolated dev DB: `EMDASH_DB_FILE=<path> pnpm dev` (real emdash data lives in
  `~/Library/Application Support/emdash/`).
- `pnpm run package:mac|linux|win` is broken in the monorepo layout: `electron` is a
  range (`^40.7.0`) hoisted to the workspace root, so electron-builder aborts with
  *"Cannot compute electron version from installed node modules"*. Only
  `scripts/release/build.ts` works, because it resolves the version itself and passes
  `electronVersion` into the config (`build.ts:78`). `electron-builder.fork.config.ts`
  does the same resolution inline.
- electron-builder's dependency collector mishandles the `node-linker=hoisted` layout
  in three ways, each of which kills the packaged app at boot while `pnpm dev` works
  fine: (1) a version conflict resolved in the app's or a workspace package's own
  `node_modules` is flattened to the root's (wrong) version — glob 7 shadowing
  glob 13 broke `import { globIterate }` in `@emdash/core` and `import { glob }` in
  `out/main`; (2) nested conflict copies (`node_modules/x/node_modules/y`) are
  dropped — node-fetch 2 lost its whatwg-url 5 and crashed on whatwg-url 16 requiring
  the unpackaged `@exodus/bytes`; (3) a root package whose only consumers are nested
  is never visited — open 11's closure (`default-browser`, …) was absent.
  `electron-builder.fork.config.ts` compensates with generated `files` mappings: it
  walks the runtime graph with Node's real upward resolution, re-adds every non-root
  `node_modules` it traverses, and maps root packages the collector's naive walk
  can't reach. Audit a candidate asar before installing it: extract with
  `pnpm exec asar extract` (beware: `extract-file` writes into the CURRENT directory)
  and check that every packaged package.json's deps resolve at a compatible version
  from its location. Upstream escapes all of this by luck: their root hoist happened
  to resolve glob@10, which still had the named exports.

## Personal macOS builds (auto-update from this fork)

A packaged build is a normal `Emdash.app` you can keep in `/Applications` instead of
living in `pnpm dev`. Two things need care.

**The update feed.** `electron-builder.config.ts` publishes to `generalaction/emdash`
+ `releases.emdash.sh`, and the updater reads that feed from the `app-update.yml`
embedded at packaging time (there is no `setFeedURL` anywhere in the code). A fork
build using it would offer upstream's next stable release and silently replace our
features on install. `electron-builder.fork.config.ts` overrides `publish` to point at
`64ix/emdash` and nothing else.

**Code signing.** On macOS `electron-updater` hands the install to Squirrel.Mac, which
validates the downloaded bundle against the running app's designated requirement. An
unsigned build downloads the update and then fails at install, so a fork build that
wants working auto-updates must be signed — with the *same* identity every time,
starting with the first build you actually install. A self-signed identity is enough
for personal use.

One-time setup (already done on the original machine; `~/.emdash-fork-signing/` holds
the key, so it is per-machine):

```bash
D=~/.emdash-fork-signing && mkdir -p "$D" && chmod 700 "$D"
openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
  -keyout "$D/signing.key" -out "$D/signing.crt" -config "$D/openssl.cnf"
/usr/bin/openssl pkcs12 -export -inkey "$D/signing.key" -in "$D/signing.crt" \
  -out "$D/signing.p12" -passout pass:emdash-fork -name "Emdash Fork Signing"
security create-keychain -p "$(openssl rand -hex 24 | tee "$D/keychain-password")" \
  "$D/fork-signing.keychain-db"
security import "$D/signing.p12" -k "$D/fork-signing.keychain-db" -P emdash-fork \
  -T /usr/bin/codesign -A
security set-key-partition-list -S apple-tool:,apple:,codesign: \
  -s -k "$(cat "$D/keychain-password")" "$D/fork-signing.keychain-db"
```

`codesign` resolves identities through the user's keychain search list, so the
dedicated keychain has to be appended to it — neither `--keychain` nor `CSC_KEYCHAIN`
is enough on its own. `build-fork.sh` does this idempotently on every run.

`openssl.cnf` must set `extendedKeyUsage = critical,codeSigning` and
`basicConstraints = critical,CA:false`. The certificate is then still
`CSSMERR_TP_NOT_TRUSTED` and `codesign` reports "no identity found" until it is
trusted for code signing — this step needs your login password, so it cannot be
scripted from an agent:

```bash
security add-trusted-cert -r trustRoot -p codeSign \
  -k "$HOME/Library/Keychains/login.keychain-db" ~/.emdash-fork-signing/signing.crt
```

Scope: trust is limited to `codeSign` (not TLS) and to this user account. Anything
signed with that key is treated as validly signed on this machine, so keep
`~/.emdash-fork-signing/` at `chmod 700`.

Then build and, optionally, publish a release on `64ix/emdash`:

```bash
pnpm run package:fork -- --version 1.2.0
pnpm run package:fork -- --version 1.2.0 --publish
```

The version is injected via `extraMetadata`, never committed — `package.json` keeps
upstream's value so rebases stay clean. Rules: plain `x.y.z`, strictly increasing
(`allowDowngrade` is `false`), no prerelease suffix (`allowPrerelease` is `false` off
the canary channel), and above upstream's line — upstream lives in `1.1.x`, so `1.2.0`,
`1.3.0`, … are ours.

**How `--publish` sequences a release.** It mirrors the CI pipeline
(`scripts/release/prepare-release.ts` → build → `finalize-release.ts`): the GitHub
release is created as a **draft** *before* packaging, the two macOS publishers upload
the dmg, the zip, their blockmaps and the `latest-mac.yml` the updater reads into it,
and only then is it published — which is the moment GitHub creates the `v<version>`
tag, from the exact commit that was packaged. Consequences worth knowing:

- An interrupted or failed build leaves a draft and no tag. Re-running the same
  `--version` reuses that draft, so recovery is just running the command again.
- The script refuses to publish from a dirty working tree, or a `HEAD` that is not
  pushed yet: the tag has to describe what was actually built. `EMDASH_FORK_ALLOW_DIRTY=1`
  overrides the first.
- It refuses to touch a version that is already published, so re-releasing is
  deliberate: pass `--republish` to upload into an existing published release.
- Before publishing the draft it asserts `latest-mac.yml` is among the assets, and
  leaves the release as a draft if it is not.

That last guard exists because the failure it prevents is silent. Publishing 1.2.6
without the draft step produced this, twice over:

```text
creating GitHub release  reason=release doesn't exist tag=v1.2.6
creating GitHub release  reason=release doesn't exist tag=v1.2.6
⨯ HttpError: 422 Unprocessable Entity … "Published releases must have a valid tag"
```

Both publishers raced to create the same release; one POST won and the others got a
422 whose message points at the tag, which is not the problem — it is a concurrent
creation conflict. The release existed, but only one blockmap had uploaded and
`latest-mac.yml` was never regenerated (the copy left in `release/` still described
the *previous* version). `electron-updater` resolves such a release as the latest one
and then 404s on the channel manifest, so the update never happens and nothing in the
app reports an error. If you ever see a fork release whose asset list is short, that
is what happened; the fix is to delete the stray assets and re-run with `--republish`.

## Fork releases in CI (macOS + Windows)

`.github/workflows/release-fork.yml` builds the personal fork for macOS arm64 and
Windows x64 in parallel. It creates a draft release first, uploads both platforms to
that draft, checks the complete asset list, and only then publishes it. A failed job
therefore leaves an updater-invisible draft that can be inspected or retried.

The Windows artifacts are intentionally unsigned until the fork owns a Windows
code-signing certificate. `electron-builder.fork.windows.config.ts` drops the upstream
Azure identity and sets `verifyUpdateCodeSignature: false`, which is what keeps
`publisherName: General Action, Inc.` out of the packaged `app-update.yml` — left in,
`NsisUpdater` would run `verifySignature` against it and refuse every update, since our
installers carry no signature at all. Windows SmartScreen still warns on a manual
install.

The macOS job uses the same self-signed identity as local fork builds. Export the
existing PKCS#12 file into these repository secrets once:

```bash
base64 -i ~/.emdash-fork-signing/signing.p12 | gh secret set FORK_MACOS_CERTIFICATE_P12 --repo 64ix/emdash
gh secret set FORK_MACOS_CERTIFICATE_PASSWORD --repo 64ix/emdash
```

The second command prompts for the password without printing it (the PKCS#12 was
exported with `-passout pass:emdash-fork`, see the setup above). The workflow imports
the certificate into an ephemeral keychain, trusts it only for code signing, verifies
the packaged app, and deletes the keychain even when the job fails.

One deliberate difference from the local setup: on the runner the trust setting goes
into the **admin** domain under `sudo`
(`security add-trusted-cert -d -k /Library/Keychains/System.keychain`). Writing the user
domain — the local recipe — needs an authorization the runner has no GUI to grant, so
the step would hang and then fail. Trust evaluation reads both domains, so `codesign` is
equally satisfied, and the runner is discarded afterwards either way.

Dispatch a release only from `fork-main`, using a plain version greater than every
published fork and upstream stable version:

```bash
gh workflow run release-fork.yml --repo 64ix/emdash --ref fork-main -f version=1.2.8
```

Both platform jobs run `scripts/release/verify-fork-feed.ts` against the `app-update.yml`
inside the bundle they just packaged. That file is written at packaging time and the app
has no `setFeedURL`, so an artifact built with the upstream config would offer upstream's
next stable release and replace the fork's features on install, reporting nothing
anywhere. Asserting on the embedded manifest — not on the config we meant to pass —
catches a mistyped `--config`, a fork config spread from the wrong base, and a publisher
name electron-builder resolved on its own.

Required final assets are the arm64 DMG and ZIP with both blockmaps and
`latest-mac.yml`, plus the x64 NSIS EXE, MSI, EXE blockmap, and `latest.yml`. The
finalize job refuses to publish if any one is absent. The workflow never publishes to
upstream or Cloudflare R2 and does not mutate the version in `package.json`.

### The native-module rebuild, and why v1.2.8 was withdrawn

Both platform jobs pass `--project-root "$GITHUB_WORKSPACE"` to `rebuild-native.ts`. It is
load-bearing. `@electron/rebuild` needs two facts to agree, and under pnpm's hoisted linker
no single directory carries both: the `package.json` whose prod dependencies *name* the
native modules (the app's) and the `node_modules` they physically *live* in (the workspace
root's, because they are hoisted out of the app). Given only a `buildPath` it uses it for
both, so the app directory answers "not installed", the workspace root answers "not a
dependency", and either way it rebuilds nothing, prints success, and exits 0 in about a
second. Upstream never hits this: `build.ts` packages from a `pnpm deploy --legacy --prod`
tree where both facts hold at once. The fork workflow cannot use that tree, because it must
package with the fork config, whose file mappings are relative to the app directory.

A missed rebuild is invisible until the app is launched. electron-builder runs with
`npmRebuild: false`, so it packages whatever `pnpm install` compiled — and on CI that is the
runner's *system Node*, because `scripts/postinstall.ts` skips electron-rebuild whenever `CI`
is set. Electron keeps its own `NODE_MODULE_VERSION` namespace, so the two can never
coincidentally agree: Electron 40 requires 143 where Node 24 produces 137. The packaged app
throws on its first `require('better-sqlite3')` and never opens a window.

**Happened once:** v1.2.8 shipped exactly that, and every guard waved it through —
`codesign --verify` signs a bundle that cannot boot, and `verify-mac.ts` checks for a module
named `sqlite3`, which this app does not use, so it only *warns* when it is absent. The
release was published, caught, and reverted to a draft within minutes; the tag and draft were
deleted and the fix shipped as v1.2.9, a version bump rather than a re-cut of 1.2.8, because
a client that had already updated would never re-download the same version.

`scripts/release/verify-native-abi.ts` now runs on both platforms after packaging. It is the
real test rather than a proxy: it runs the *packaged* Electron binary as Node
(`ELECTRON_RUN_AS_NODE=1`, which reports Electron's module version) and `dlopen`s the packaged
`.node` files. If they load there, they load in the app. Because it runs after upload, a
failure leaves an updater-invisible draft rather than a shipped release.

**Shared state with the official app.** The fork build keeps upstream's identity —
`Emdash.app`, `com.emdash.stable`, data in `~/Library/Application Support/emdash/`.
So it replaces a `/Applications/Emdash.app` installed from emdash.sh and shares its
database, which our migrations will upgrade. Back that directory up before the first
launch. Because the signing identity differs from General Action's, macOS will also
ask once to let the app reach the `emdash Safe Storage` keychain item holding the
encrypted secrets. To run both side by side instead, build the canary variant
(`VITE_BUILD=canary` in `.env.production` + `electron-builder.canary.config.ts`):
separate app name, bundle id and `emdash-canary/` data directory.
