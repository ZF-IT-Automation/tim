#!/usr/bin/env bash
# tim-statusline.sh — debug helper: one-line TIM status (stdin JSON optional, like Claude Code)
# Hermes TUI bar: use tim-hermes-statusline.sh + hermes-cli-tim-statusline.patch instead.
set -euo pipefail

SCRIPT_PATH="${BASH_SOURCE[0]}"
while [[ -L "$SCRIPT_PATH" ]]; do
  SCRIPT_LINK_DIR="$(cd -P "$(dirname "$SCRIPT_PATH")" && pwd)"
  SCRIPT_PATH="$(readlink "$SCRIPT_PATH")"
  [[ "$SCRIPT_PATH" == /* ]] || SCRIPT_PATH="$SCRIPT_LINK_DIR/$SCRIPT_PATH"
done
SCRIPT_DIR="$(cd -P "$(dirname "$SCRIPT_PATH")" && pwd)"
unset SCRIPT_PATH SCRIPT_LINK_DIR
# shellcheck source=lib/resolve-tim-cli.sh
source "$SCRIPT_DIR/lib/resolve-tim-cli.sh"
run_tim_cli statusline 2>/dev/null || true
