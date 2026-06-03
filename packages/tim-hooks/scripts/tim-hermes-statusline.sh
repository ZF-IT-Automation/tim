#!/usr/bin/env bash
# tim-hermes-statusline.sh — Hermes TUI status bar (JSON stdout for hermes-cli patch)
# Project from nearest .tim-project walk-up only (tim statusline / resolve-project). No session cache.
# Install: symlink to ~/.hermes/agent-hooks/ + apply hermes-cli-tim-statusline.patch
set -euo pipefail

TIM_CLI="${TIM_CLI:-/home/bbbee/projects/tim/packages/tim-cli/dist/cli.js}"

# CWD: explicit env, else PWD (Hermes hook cwd is not piped here)
CWD="${TIM_STATUSLINE_CWD:-${PWD:-$HOME}}"
[[ -z "$CWD" ]] && CWD="${HOME}"

out=$(node "$TIM_CLI" statusline --format hermes --cwd "$CWD" 2>/dev/null || true)
if [[ -z "$out" ]]; then
  echo '{}'
else
  echo "$out"
fi
exit 0
