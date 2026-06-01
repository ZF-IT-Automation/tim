#!/usr/bin/env bash
# tim-claude-session-start.sh — Claude Code SessionStart hook (TIM project auto-load).
# Reads cwd from the SessionStart payload, resolves nearest .tim-project (walk-up),
# emits additionalContext directive. Requires: jq, node. Override path with TIM_CLI.
set -euo pipefail

TIM_CLI="${TIM_CLI:-/home/bbbee/projects/tim/packages/tim-cli/dist/cli.js}"

payload="$(cat -)"
cwd=$(printf '%s' "$payload" | jq -r '.cwd // empty')
[[ -z "$cwd" ]] && exit 0

directive=$(node "$TIM_CLI" resolve-project --cwd "$cwd" --format directive 2>/dev/null || true)
[[ -z "$directive" ]] && exit 0

jq -n --arg ctx "$directive" \
  '{hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: $ctx}}'
