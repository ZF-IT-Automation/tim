#!/usr/bin/env bash
# tim-session-start.sh — Hermes pre_llm_call hook (TIM session start + project auto-load)
# First turn: local .tim-project cwd-walk, else TIM session project_ref from DB (payload session_id).
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

project=""
directive=""

# 1. Local .tim-project (cwd walk up)
local_marker=$(node -e "
  const fs = require('fs');
  const path = require('path');
  let dir = '$cwd';
  while (true) {
    const p = path.join(dir, '.tim-project');
    if (fs.existsSync(p)) { process.stdout.write(p); break; }
    const next = path.dirname(dir);
    if (next === dir) break;
    dir = next;
  }
" 2>/dev/null || true)

if [[ -n "$local_marker" ]]; then
  project=$(node "$TIM_CLI" resolve-project --cwd "$cwd" --format label 2>/dev/null || true)
  directive=$(node "$TIM_CLI" resolve-project --cwd "$cwd" --format directive 2>/dev/null || true)
fi

# 2. TIM session in DB (Hermes session_id → metadata.project_ref)
if [[ -z "$project" && -n "$session_key" ]]; then
  project=$(node "$TIM_CLI" resolve-session --session "$session_key" --cwd "$cwd" --format label 2>/dev/null || true)
  if [[ -n "$project" ]]; then
    directive=$(node "$TIM_CLI" resolve-session --session "$session_key" --cwd "$cwd" --format directive 2>/dev/null || true)
  fi
fi

[[ -z "$project" ]] && { printf '{}\n'; exit 0; }

# End previous session if .tim-project marker has a different session ID
# Fire-and-forget: must never block the new session-start
if [[ -n "$local_marker" ]]; then
  old_session=$(jq -r '.session // empty' "$local_marker" 2>/dev/null || true)
  if [[ -n "$old_session" && "$old_session" != "$session_key" ]]; then
    node "$TIM_CLI" hook session-end --session "$old_session" 2>/dev/null &
  fi
fi

# Start / refresh TIM session subtree
if [[ -n "$session_key" ]]; then
  node "$TIM_CLI" hook session-start \
    --session "$session_key" \
    --cwd "$cwd" \
    --project "$project" \
    --tool "$tool" \
    --model "$model" 2>/dev/null || true
fi

jq -n --arg ctx "$directive" '{context: $ctx}'
exit 0
