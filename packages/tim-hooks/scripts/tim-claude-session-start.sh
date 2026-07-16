#!/usr/bin/env bash
# tim-claude-session-start.sh — Claude Code SessionStart hook (TIM project auto-load).
# Reads cwd from the SessionStart payload, resolves nearest .tim-project (walk-up),
# emits additionalContext directive. Requires: jq, node. Override path with TIM_CLI.
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

payload="$(cat -)"
cwd=$(printf '%s' "$payload" | jq -r '.cwd // empty')
[[ -z "$cwd" ]] && exit 0

directive=$(run_tim_cli resolve-project --cwd "$cwd" --format directive 2>/dev/null || true)
[[ -z "$directive" ]] && exit 0

jq -n --arg ctx "$directive" \
  '{hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: $ctx}}'
