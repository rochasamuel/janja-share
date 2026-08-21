#!/usr/bin/env bash
# Sets the app version everywhere it lives, so a new build never ships under
# an old number. The installer's filename carries this version, and it is how
# a friend tells you which build they have.
#
#   bash scripts/bump-version.sh 0.2.0
#
# Four files hold it: tauri.conf.json is what the installer reads, Cargo.toml
# and Cargo.lock must agree or the next cargo run rewrites the lock, and the
# desktop package.json is kept in step so nothing reports a stale number.
set -euo pipefail

VERSION="${1:-}"
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "usage: $0 MAJOR.MINOR.PATCH" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DESKTOP="$ROOT/apps/desktop"

CURRENT="$(sed -n 's/^version = "\(.*\)"$/\1/p' "$DESKTOP/src-tauri/Cargo.toml" | head -1)"
if [ -z "$CURRENT" ]; then
  echo "could not read the current version from Cargo.toml" >&2
  exit 1
fi

# Anchored edits only: each file has exactly one line that is the app's own
# version, and a loose replacement would hit dependencies that happen to share
# the number.
sed -i "s/^version = \"$CURRENT\"$/version = \"$VERSION\"/" "$DESKTOP/src-tauri/Cargo.toml"
sed -i "0,/^  \"version\": \"$CURRENT\",$/s//  \"version\": \"$VERSION\",/" "$DESKTOP/src-tauri/tauri.conf.json"
sed -i "0,/^  \"version\": \"$CURRENT\",$/s//  \"version\": \"$VERSION\",/" "$DESKTOP/package.json"
# The lock entry is the [[package]] block named janja-share; only its own
# version line moves.
sed -i "/^name = \"janja-share\"$/{n;s/^version = \"$CURRENT\"$/version = \"$VERSION\"/}" "$DESKTOP/src-tauri/Cargo.lock"

echo "[APP] $CURRENT -> $VERSION"
grep -Hn "\"version\": \"$VERSION\"" "$DESKTOP/src-tauri/tauri.conf.json" "$DESKTOP/package.json"
grep -Hn "^version = \"$VERSION\"" "$DESKTOP/src-tauri/Cargo.toml"
grep -Hn -A1 "^name = \"janja-share\"$" "$DESKTOP/src-tauri/Cargo.lock" | grep "version"
echo "[APP] the installer will be named 'Janja Share_${VERSION}_x64-setup.exe'"
