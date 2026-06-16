#!/usr/bin/env bash
# tim-session-start.sh — Hermes pre_llm_call hook (TIM session start + project auto-load)
# First turn: .tim-project at cwd only (walk-up opt-in via --walk-up on resolve-project).
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
cwd_marker_prompt=""

# Cwd-only marker check (read-only prompt when missing)
if [[ ! -f "$cwd/.tim-project" && ! -f "$cwd/tim.json" ]]; then
  cwd_marker_prompt="📍 No TIM project marker at cwd ($cwd). findMarker defaults to cwd-only — create .tim-project here, or use tim resolve-project --walk-up from a repo subdir."
fi

local_marker=""
if [[ -f "$cwd/.tim-project" ]]; then
  local_marker="$cwd/.tim-project"
elif [[ -f "$cwd/tim.json" ]]; then
  local_marker="$cwd/tim.json"
fi

if [[ -n "$local_marker" ]]; then
  project=$(node "$TIM_CLI" resolve-project --cwd "$cwd" --format label 2>/dev/null || true)
  directive=$(node "$TIM_CLI" resolve-project --cwd "$cwd" --format directive 2>/dev/null || true)
fi

[[ -z "$project" ]] && [[ -z "$cwd_marker_prompt" ]] && { printf '{}\n'; exit 0; }

if [[ -n "$cwd_marker_prompt" ]]; then
  if [[ -n "$directive" ]]; then
    directive="${directive}
${cwd_marker_prompt}"
  else
    directive="$cwd_marker_prompt"
  fi
fi

[[ -z "$project" ]] && [[ -z "$directive" ]] && { printf '{}\n'; exit 0; }

# End previous session if .tim-project marker has a different session ID
# Fire-and-forget: must never block the new session-start
if [[ -n "$local_marker" ]]; then
  old_session=$(jq -r '.session // empty' "$local_marker" 2>/dev/null || true)
  if [[ -n "$old_session" && "$old_session" != "$session_key" ]]; then
    node "$TIM_CLI" hook session-end --session "$old_session" 2>/dev/null &
  fi
fi

# ── Root-level entries: metadata.type=rule + metadata.type=human ──
# Phase 0: pass --type (structured query via json_extract). The legacy
# --tag '#rule' / --tag '#human' form is still accepted by the CLI as a
# deprecated alias, but new code should use --type.
root_context=""
rules_text=$(node "$TIM_CLI" root-entries --type rule --format content 2>/dev/null || true)
human_text=$(node "$TIM_CLI" root-entries --type human --format content 2>/dev/null || true)

if [[ -n "$rules_text" ]]; then
  root_context+="
─── TIM Root Rules ───
$rules_text"
fi

if [[ -n "$human_text" ]]; then
  root_context+="
─── TIM Human Context ───
$human_text"
fi

# Merge root context with project directive
if [[ -n "$root_context" ]]; then
  directive="${directive}
${root_context}"
fi

# Start / refresh TIM session subtree.
# When the project was resolved from a local .tim-project marker (walk-up),
# do NOT pass --project — let runSessionStart re-derive it from the marker
# so the hook does not force a project override for every session start.
if [[ -n "$session_key" ]]; then
  args=(
    --session "$session_key"
    --cwd "$cwd"
    --tool "$tool"
    --model "$model"
  )
  if [[ -z "$local_marker" && -n "$project" ]]; then
    args+=(--project "$project")
  fi
  node "$TIM_CLI" hook session-start "${args[@]}" 2>/dev/null || true
fi

jq -n --arg ctx "$directive" '{context: $ctx}'
exit 0
