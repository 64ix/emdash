#!/usr/bin/env bash
#
# Personal macOS build of the fork, signed with a local self-signed identity so
# that Squirrel.Mac accepts in-place updates, and wired to the 64ix/emdash
# update feed (see electron-builder.fork.config.ts).
#
# Usage:
#   scripts/fork/build-fork.sh --version 1.2.0                        # build only
#   scripts/fork/build-fork.sh --version 1.2.0 --publish              # + GitHub release
#   scripts/fork/build-fork.sh --version 1.2.0 --publish --republish  # into a published one
#
# With --publish the GitHub release is created as a draft *before* packaging and
# published once every asset is in place, so it is never visible to updaters
# while incomplete and concurrent publishers never race to create it. The
# v<version> tag is created by GitHub when the draft is published, so an
# interrupted build leaves neither a tag nor a usable release behind.
#
# The version is injected through electron-builder's extraMetadata, never
# committed: apps/emdash-desktop/package.json keeps upstream's value so rebases
# onto upstream tags stay conflict-free. Use a plain x.y.z above upstream's
# latest (upstream lives in 1.1.x, so 1.2.0, 1.3.0, ... are ours). A prerelease
# suffix would be ignored by the updater: allowPrerelease is false on the stable
# channel.
#
# One-time setup of the signing identity is documented in FORK.md.

set -euo pipefail

SIGNING_DIR="${EMDASH_FORK_SIGNING_DIR:-$HOME/.emdash-fork-signing}"
KEYCHAIN="$SIGNING_DIR/fork-signing.keychain-db"
KEYCHAIN_PASSWORD_FILE="$SIGNING_DIR/keychain-password"
CERT="$SIGNING_DIR/signing.crt"
IDENTITY="${EMDASH_FORK_IDENTITY:-Emdash Fork Signing}"

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REPO_ROOT="$(cd "$APP_DIR/../.." && pwd)"

die() {
  echo "build-fork: $*" >&2
  exit 1
}

usage() {
  sed -n '3,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

VERSION=""
PUBLISH="never"
SKIP_BUILD=0
REPUBLISH=0

while [ $# -gt 0 ]; do
  case "$1" in
    --version)
      [ $# -ge 2 ] || die "--version needs a value"
      VERSION="$2"
      shift 2
      ;;
    --publish)
      PUBLISH="always"
      shift
      ;;
    --skip-build)
      SKIP_BUILD=1
      shift
      ;;
    --republish)
      REPUBLISH=1
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    --)
      # `pnpm run package:fork -- --version x.y.z` forwards the separator itself.
      shift
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

[ -n "$VERSION" ] || die "--version is required (e.g. --version 1.2.0)"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] ||
  die "version must be a plain x.y.z; prereleases are ignored by the stable channel"

[ "$(uname -s)" = "Darwin" ] || die "this script builds the macOS artifacts only"

# --- signing identity -------------------------------------------------------

[ -f "$KEYCHAIN" ] || die "signing keychain missing at $KEYCHAIN (see FORK.md)"
[ -f "$KEYCHAIN_PASSWORD_FILE" ] || die "keychain password file missing at $KEYCHAIN_PASSWORD_FILE"

# codesign resolves identities through the user's keychain search list only —
# passing --keychain, or CSC_KEYCHAIN, is not enough on its own. Append ours once.
if ! security list-keychains -d user | grep -qF "$KEYCHAIN"; then
  echo "build-fork: adding $KEYCHAIN to the user keychain search list"
  # shellcheck disable=SC2046
  security list-keychains -d user -s $(security list-keychains -d user | tr -d ' "') "$KEYCHAIN"
fi

security unlock-keychain -p "$(cat "$KEYCHAIN_PASSWORD_FILE")" "$KEYCHAIN"

if ! security find-identity -v -p codesigning "$KEYCHAIN" | grep -qF "$IDENTITY"; then
  cat >&2 <<EOF
build-fork: "$IDENTITY" exists but macOS does not trust it for code signing yet.

Run this once (it asks for your login password), then re-run this script:

  security add-trusted-cert -r trustRoot -p codeSign \\
    -k "\$HOME/Library/Keychains/login.keychain-db" "$CERT"

EOF
  exit 1
fi

export CSC_KEYCHAIN="$KEYCHAIN"
export CSC_NAME="$IDENTITY"
export CSC_IDENTITY_AUTO_DISCOVERY=true

# --- publish credentials ----------------------------------------------------

# Must match the `publish` block in electron-builder.fork.config.ts: the
# publishers upload to that repository, and the release prepared below has to be
# the one they find.
REPO="${EMDASH_FORK_REPO:-64ix/emdash}"
TAG="v$VERSION"
DRAFT_TO_PUBLISH=0

if [ "$PUBLISH" = "always" ]; then
  # gh drives the prepare/finalize steps below, not just the token lookup, so it
  # is required even when GH_TOKEN comes from the environment.
  command -v gh >/dev/null 2>&1 || die "--publish needs the gh CLI"
  if [ -z "${GH_TOKEN:-}" ]; then
    GH_TOKEN="$(gh auth token)"
    export GH_TOKEN
  fi
  [ -n "${GH_TOKEN:-}" ] || die "could not resolve a GitHub token"
fi

# --- release, prepared as a draft before packaging --------------------------
#
# electron-builder packages two macOS targets (dmg, zip) and runs one GitHub
# publisher per target, concurrently. With no release for the tag they all decide
# "release doesn't exist, create it" in the same breath: one POST wins and the
# rest get HTTP 422 "Published releases must have a valid tag" — a concurrent
# creation conflict wearing a misleading message, since the tag is not the
# problem. Publishing 1.2.6 that way left a *published* release carrying one
# blockmap and no latest-mac.yml, the worst outcome on offer: electron-updater
# resolves the release as latest and then 404s on the manifest, so the update
# silently never happens and nothing anywhere reports an error.
#
# So the release is created up front, the way the CI pipeline already does it
# (scripts/release/prepare-release.ts) — the publishers then find it and only
# upload. Draft rather than published, for the same reason finalize-release.ts
# exists: a release must not be reachable by updaters until every asset is in.
# `releaseType: 'release'` stays in the config as the fallback for whoever
# bypasses this step.

if [ "$PUBLISH" = "always" ]; then
  # The tag has to describe the tree that was packaged, so target the exact
  # commit rather than a branch name that can move between now and the finalize
  # step at the end of this script.
  if [ -n "$(git -C "$REPO_ROOT" status --porcelain)" ] && [ "${EMDASH_FORK_ALLOW_DIRTY:-0}" != "1" ]; then
    die "working tree is dirty, so $TAG would not describe what gets built (set EMDASH_FORK_ALLOW_DIRTY=1 to publish anyway)"
  fi
  TARGET="$(git -C "$REPO_ROOT" rev-parse HEAD)"
  gh api "repos/$REPO/commits/$TARGET" --silent >/dev/null 2>&1 ||
    die "commit $TARGET is not on $REPO yet; push it before publishing $TAG"

  # "<isDraft> <assetCount>", or empty when no release exists for the tag.
  RELEASE_STATE="$(
    gh release view "$TAG" --repo "$REPO" \
      --json isDraft,assets -q '"\(.isDraft) \(.assets | length)"' 2>/dev/null || true
  )"

  if [ -z "$RELEASE_STATE" ]; then
    echo "build-fork: creating draft release $TAG at $TARGET"
    gh release create "$TAG" --repo "$REPO" --draft --target "$TARGET" \
      --title "Emdash fork $TAG (macOS arm64)" --generate-notes >/dev/null
    DRAFT_TO_PUBLISH=1
  elif [ "${RELEASE_STATE%% *}" = "true" ]; then
    echo "build-fork: reusing draft release $TAG (${RELEASE_STATE##* } asset(s) already uploaded)"
    DRAFT_TO_PUBLISH=1
  elif [ "$REPUBLISH" -eq 1 ]; then
    echo "build-fork: uploading into the published release $TAG (--republish)"
  else
    die "$TAG is already published on $REPO with ${RELEASE_STATE##* } asset(s); bump the version, or pass --republish to upload into it"
  fi
fi

# --- build ------------------------------------------------------------------

if [ "$SKIP_BUILD" -eq 0 ]; then
  echo "build-fork: building workspace (nx, cached)"
  (cd "$REPO_ROOT" && pnpm run build)
fi

echo "build-fork: packaging $VERSION (publish=$PUBLISH)"
cd "$APP_DIR"
pnpm exec electron-builder --mac \
  --config electron-builder.fork.config.ts \
  -c.extraMetadata.version="$VERSION" \
  --publish "$PUBLISH"

echo "build-fork: artifacts in $APP_DIR/release"

# --- finalize ---------------------------------------------------------------

if [ "$DRAFT_TO_PUBLISH" -eq 1 ]; then
  # The one asset the updater cannot do without. Missing it means the publishers
  # dropped something, so leave the release as a draft: invisible to updaters,
  # and re-runnable (the branch above reuses it) rather than half shipped.
  # Captured rather than piped into grep: `grep -q` exits on the first match, and
  # under `pipefail` the EPIPE that gives the upstream gh would fail the pipeline
  # precisely when the assertion passes.
  RELEASE_ASSETS="$(gh release view "$TAG" --repo "$REPO" --json assets -q '.assets[].name')"
  grep -qx 'latest-mac.yml' <<<"$RELEASE_ASSETS" ||
    die "latest-mac.yml never made it into $TAG; leaving it as a draft — electron-updater cannot use a release without the channel manifest"

  echo "build-fork: publishing $TAG (this is what creates the $TAG tag)"
  gh release edit "$TAG" --repo "$REPO" --draft=false --latest >/dev/null
fi
