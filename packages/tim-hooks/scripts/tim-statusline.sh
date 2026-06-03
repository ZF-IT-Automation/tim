#!/usr/bin/env bash
# tim-statusline.sh — debug helper: one-line TIM status (stdin JSON optional, like Claude Code)
# Hermes TUI bar: use tim-hermes-statusline.sh + hermes-cli-tim-statusline.patch instead.
set -euo pipefail

TIM_CLI="${TIM_CLI:-/home/bbbee/projects/tim/packages/tim-cli/dist/cli.js}"
node "$TIM_CLI" statusline 2>/dev/null || true
