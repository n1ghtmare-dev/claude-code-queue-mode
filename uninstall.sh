#!/usr/bin/env bash
# Claude Code Queue Mode — restore the original Claude Code files (macOS / Linux).
set -euo pipefail
exec bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/install.sh" --unpatch "$@"
