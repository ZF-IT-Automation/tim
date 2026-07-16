#!/usr/bin/env bash
# tim-cursor-inject.sh — print the TIM load directive for a workspace, for the
# orchestrator to prepend to Cursor's first prompt (Cursor has no SessionStart hook).
# Usage: tim-cursor-inject.sh <project-dir>
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
# shellcheck source=lib/resolve-tim-cli.sh
source "$SCRIPT_DIR/lib/resolve-tim-cli.sh"
cwd="${1:-$PWD}"
run_tim_cli resolve-project --cwd "$cwd" --format directive 2>/dev/null || true
