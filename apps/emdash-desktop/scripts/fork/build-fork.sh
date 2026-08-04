#!/usr/bin/env bash
#
# Personal macOS build of the fork, signed with a local self-signed identity so
# that Squirrel.Mac accepts in-place updates, and wired to the 64ix/emdash
# update feed (see electron-builder.fork.config.ts).
#
# Usage:
#   scripts/fork/build-fork.sh --version 1.2.0             # build only
#   scripts/fork/build-fork.sh --version 1.2.0 --publish   # + GitHub release
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
  sed -n '3,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

VERSION=""
PUBLISH="never"
SKIP_BUILD=0

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

if [ "$PUBLISH" = "always" ]; then
  if [ -z "${GH_TOKEN:-}" ]; then
    command -v gh >/dev/null 2>&1 || die "--publish needs GH_TOKEN or the gh CLI"
    GH_TOKEN="$(gh auth token)"
    export GH_TOKEN
  fi
  [ -n "${GH_TOKEN:-}" ] || die "could not resolve a GitHub token"
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
