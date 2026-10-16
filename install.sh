#!/usr/bin/env bash
# Claude Code Queue Mode — installer for macOS and Linux.
#
#   curl -fsSL https://raw.githubusercontent.com/n1ghtmare-dev/claude-code-queue-mode/main/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/n1ghtmare-dev/claude-code-queue-mode/main/install.sh | bash -s -- --unpatch
#
# From an extracted release archive:  bash install.sh   (bash uninstall.sh to remove)
set -euo pipefail

REPO="n1ghtmare-dev/claude-code-queue-mode"
ARCHIVE="https://github.com/$REPO/releases/latest/download/claude-code-queue-mode.tar.gz"

here=""
if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
  here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
fi

if [ -n "$here" ] && [ -f "$here/src/patch.js" ]; then
  src="$here/src"
else
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  echo "Downloading $ARCHIVE"
  curl -fsSL "$ARCHIVE" | tar -xz -C "$tmp"
  src="$tmp/claude-code-queue-mode/src"
fi

run_patcher() {
  if command -v node >/dev/null 2>&1; then
    node "$src/patch.js" "$@"
    return
  fi
  # No Node.js: run the patcher with the editor's own runtime.
  for e in \
    "/Applications/Cursor.app/Contents/MacOS/Cursor" \
    "$HOME/Applications/Cursor.app/Contents/MacOS/Cursor" \
    "/Applications/Visual Studio Code.app/Contents/MacOS/Electron" \
    "/Applications/Visual Studio Code.app/Contents/MacOS/Code" \
    "/Applications/Windsurf.app/Contents/MacOS/Electron" \
    "/usr/share/cursor/cursor" "/opt/Cursor/cursor" "/opt/cursor/cursor" \
    "/usr/share/code/code" "/usr/lib/code/code" "/opt/visual-studio-code/code"; do
    if [ -x "$e" ]; then
      ELECTRON_RUN_AS_NODE=1 "$e" "$src/patch.js" "$@"
      return
    fi
  done
  echo "Node.js was not found. Install it from https://nodejs.org and run this again." >&2
  exit 1
}

run_patcher "$@"
