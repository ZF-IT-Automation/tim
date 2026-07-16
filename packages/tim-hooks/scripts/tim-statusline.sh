#!/usr/bin/env bash
# tim-statusline.sh — debug helper: one-line TIM status (stdin JSON optional, like Claude Code)
# Hermes TUI bar: use tim-hermes-statusline.sh + hermes-cli-tim-statusline.patch instead.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
# shellcheck source=lib/resolve-tim-cli.sh
source "$SCRIPT_DIR/lib/resolve-tim-cli.sh"
run_tim_cli statusline 2>/dev/null || true
