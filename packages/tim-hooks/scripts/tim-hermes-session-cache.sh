#!/usr/bin/env bash
# tim-hermes-session-cache.sh — Hermes pre_llm_call: cache session_id + cwd for status bar
# Output: {} (no prompt injection). Register before tim-hermes-statusline refresh.
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

payload="$(cat)"
session_id=$(printf '%s' "$payload" | jq -r '.session_id // empty')
cwd=$(printf '%s' "$payload" | jq -r '.cwd // empty')

[[ -z "$session_id" && -z "$cwd" ]] && { printf '{}\n'; exit 0; }

cache_dir="${TIM_CACHE_DIR:-$HOME/.tim}"
mkdir -p "$cache_dir"
jq -n \
  --arg sid "$session_id" \
  --arg cwd "${cwd:-$HOME}" \
  '{session_id: $sid, cwd: $cwd, ts: (now | todate)}' \
  > "${cache_dir}/.session-cache"

printf '{}\n'
exit 0
