#!/usr/bin/env bash
# tim-session-start.sh — Hermes pre_llm_call hook (TIM session start + project auto-load)
# First turn: resolves .tim-project, starts TIM session, injects directive.
# Supports route_exchanges_to for sessions that live in TIM but not on local disk.
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

# ── resolve project from marker (cwd → walk up → global fallback) ──
project=""
directive=""

# Try local .tim-project first
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
  marker_json=$(cat "$local_marker")
  project=$(echo "$marker_json" | jq -r '.project // empty')
  directive=$(node "$TIM_CLI" resolve-project --cwd "$cwd" --format directive 2>/dev/null || true)
fi

# Global fallback: route_exchanges_to
if [[ -z "$project" ]]; then
  global_marker="$HOME/.tim-project"
  if [[ -f "$global_marker" ]]; then
    route=$(jq -r '.route_exchanges_to // empty' "$global_marker" 2>/dev/null || true)
    if [[ -n "$route" ]]; then
      project="$route"
      directive="📍 TIM project marker detected (global route_exchanges_to: $route).
This session is bound to TIM project $route.

ACTION: call tim_load_project(label=\"$route\") now to load the project brief from the TIM store. Do NOT ask which project, and do NOT run any hmem/active-project cwd→project resolution. The TIM marker is authoritative for this turn."
    fi
  fi
fi

[[ -z "$project" ]] && { printf '{}\n'; exit 0; }

# ── Start TIM session ──
if [[ -n "$session_key" ]]; then
  node "$TIM_CLI" hook session-start \
    --session "$session_key" \
    --cwd "$cwd" \
    --project "$project" \
    --tool "$tool" \
    --model "$model" 2>/dev/null || true

  # Store session in global marker's sessions map
  if [[ -f "$HOME/.tim-project" ]]; then
    tmp=$(mktemp)
    jq --arg proj "$project" --arg sid "$session_key" \
      '.sessions = (.sessions // {}) | .sessions[$proj] = $sid' \
      "$HOME/.tim-project" > "$tmp" && mv "$tmp" "$HOME/.tim-project"
  else
    # Create global marker if it doesn't exist
    jq -n --arg proj "$project" --arg sid "$session_key" \
      '{project: $proj, route_exchanges_to: $proj, sessions: {($proj): $sid}}' \
      > "$HOME/.tim-project"
  fi
fi

jq -n --arg ctx "$directive" '{context: $ctx}'
exit 0
