#!/usr/bin/env bash
# tim-cursor-inject.sh — print the TIM load directive for a workspace, for the
# orchestrator to prepend to Cursor's first prompt (Cursor has no SessionStart hook).
# Usage: tim-cursor-inject.sh <project-dir>
set -euo pipefail
TIM_CLI="${TIM_CLI:-/home/bbbee/projects/tim/packages/tim-cli/dist/cli.js}"
cwd="${1:-$PWD}"
node "$TIM_CLI" resolve-project --cwd "$cwd" --format directive 2>/dev/null || true
