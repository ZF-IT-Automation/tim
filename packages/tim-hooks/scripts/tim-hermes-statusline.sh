#!/usr/bin/env bash
# tim-hermes-statusline.sh — Hermes TUI status bar (JSON stdout for hermes-cli patch)
# Reads ~/.tim/.session-cache (tim-hermes-session-cache.sh). No stdin from Hermes.
# Install: symlink to ~/.hermes/agent-hooks/ + apply hermes-cli-tim-statusline.patch
set -euo pipefail

TIM_CLI="${TIM_CLI:-/home/bbbee/projects/tim/packages/tim-cli/dist/cli.js}"
CACHE="${TIM_CACHE_DIR:-$HOME/.tim}/.session-cache"

SESSION_ID=""
CWD="${HOME}"

if [[ -f "$CACHE" ]]; then
  cache_age=$(($(date +%s) - $(stat -c %Y "$CACHE" 2>/dev/null || echo 0)))
  if [[ "$cache_age" -lt 3600 ]]; then
    SESSION_ID=$(jq -r '.session_id // empty' "$CACHE" 2>/dev/null || true)
    CWD=$(jq -r '.cwd // empty' "$CACHE" 2>/dev/null || true)
  fi
fi
[[ -z "$CWD" ]] && CWD="${HOME}"

args=(statusline --format hermes --cwd "$CWD")
[[ -n "$SESSION_ID" ]] && args+=(--session "$SESSION_ID")

out=$(node "$TIM_CLI" "${args[@]}" 2>/dev/null || true)
if [[ -z "$out" ]]; then
  echo '{}'
else
  echo "$out"
fi
exit 0
