#!/usr/bin/env bash
# tim-hermes-statusline.sh — Hermes TUI status bar (JSON stdout for hermes-cli patch)
# Project from nearest .tim-project walk-up only (tim statusline / resolve-project). No session cache.
# Install: symlink to ~/.hermes/agent-hooks/ + apply hermes-cli-tim-statusline.patch
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
# shellcheck source=lib/resolve-tim-cli.sh
source "$SCRIPT_DIR/lib/resolve-tim-cli.sh"

# CWD: explicit env, else PWD (Hermes hook cwd is not piped here)
CWD="${TIM_STATUSLINE_CWD:-${PWD:-$HOME}}"
[[ -z "$CWD" ]] && CWD="${HOME}"

out=$(run_tim_cli statusline --format hermes --cwd "$CWD" 2>/dev/null || true)
if [[ -z "$out" ]]; then
  echo '{}'
else
  echo "$out"
fi
exit 0
