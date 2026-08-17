#!/usr/bin/env bash
# Sync the WSL working copy to the Windows filesystem so cargo and Tauri can
# build natively. Only source is copied: each side keeps its own node_modules
# and its own Rust build cache.
set -euo pipefail

DEST="${WIN_DEST:-/mnt/c/Users/sams/source/janja-share}"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ ! -d "$(dirname "$DEST")" ]; then
  echo "[APP] destination parent $(dirname "$DEST") does not exist" >&2
  exit 1
fi

mkdir -p "$DEST"

rsync -a --delete \
  --exclude 'node_modules' \
  --exclude '.git' \
  --exclude 'dist' \
  --exclude 'target' \
  --exclude '.env' \
  --exclude '.env.local' \
  "$SRC/" "$DEST/"

echo "[APP] synced $SRC -> $DEST"
echo "[APP] on Windows: cd C:\\Users\\sams\\source\\janja-share && pnpm install"
