#!/usr/bin/env bash
# tim-session-start.sh — Hermes pre_llm_call hook (TIM session start + project auto-load)
# First turn: resolves .tim-project, starts TIM session, injects directive.
# Requires: jq, node
set -euo pipefail

TIM_CLI="${TIM_CLI:-/home/bbbee/projects/tim/packages/tim-cli/dist/cli.js}"

payload="$(cat -)"
is_first=$(printf '%s' "$payload" | jq -r '.extra.is_first_turn // false')
parent=$(printf '%s' "$payload" | jq -r '.extra.parentUuid // .parent_session_id // empty')
cwd=$(printf '%s' "$payload" | jq -r '.cwd // empty')
session_key=$(printf '%s' "$payload" | jq -r '.session_id // empty')
model=$(printf '%s' "$payload" | jq -r '.model // "unknown"')
tool="hermes"

[[ -n "$parent" ]] && { printf '{}\n'; exit 0; }
[[ "$is_first" != "true" ]] && { printf '{}\n'; exit 0; }
[[ -z "$cwd" ]] && { printf '{}\n'; exit 0; }

# 1. Resolve project marker
directive=$(node "$TIM_CLI" resolve-project --cwd "$cwd" --format directive 2>/dev/null || true)
[[ -z "$directive" ]] && { printf '{}\n'; exit 0; }

# 2. Read marker to get current project
marker_json=$(node -e "
  const fs = require('fs');
  const path = require('path');
  let dir = '$cwd';
  while (true) {
    const p = path.join(dir, '.tim-project');
    if (fs.existsSync(p)) { process.stdout.write(fs.readFileSync(p,'utf8')); break; }
    const next = path.dirname(dir);
    if (next === dir) break;
    dir = next;
  }
" 2>/dev/null || true)

project=$(echo "$marker_json" | jq -r '.project // empty')

# 3. Start TIM session if we have a project
if [[ -n "$project" && -n "$session_key" ]]; then
  # Use tim_session_start MCP tool via the CLI
  node "$TIM_CLI" hook session-start \
    --session "$session_key" \
    --cwd "$cwd" \
    --project "$project" \
    --tool "$tool" \
    --model "$model" 2>/dev/null || true
fi

jq -n --arg ctx "$directive" '{context: $ctx}'
exit 0
