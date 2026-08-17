#!/usr/bin/env bash
# Validates the Rust from WSL by driving the Windows toolchain over interop.
# Without this, every Rust mistake costs a full round trip through the user.
set -euo pipefail
bash "$(dirname "${BASH_SOURCE[0]}")/sync-windows.sh" >/dev/null
cd /mnt/c/Users/sams/source/janja-share/apps/desktop/src-tauri
exec /mnt/c/Users/sams/.cargo/bin/cargo.exe check --message-format short "$@"
