#!/usr/bin/env bash
# tim-session-start.sh — Hermes pre_llm_call hook (TIM project auto-load).
#
# pre_llm_call fires every turn; we act ONLY on the first turn of a session.
# Reads the session cwd from the payload, resolves the nearest .tim-project
# (walk-up, in Node), and injects a load directive.
#
# Output contract (Hermes pre_llm_call): {"context":"..."} → appended to the
# user message. Empty/`{}` → ignored. Hermes concatenates this with
# o9k-startup.sh's context (\n\n). See plan §Corrections.
#
# Requires: jq, node. Override the CLI path with TIM_CLI.
set -euo pipefail

TIM_CLI="${TIM_CLI:-/home/bbbee/projects/tim/packages/tim-cli/dist/cli.js}"

payload="$(cat -)"

is_first=$(printf '%s' "$payload" | jq -r '.extra.is_first_turn // false')
# Subagent guard: .parentUuid is a Claude-Code field (no-op on Hermes today —
# see plan §Subagent probe). parent_session_id covers any future Hermes signal.
parent=$(printf '%s' "$payload" | jq -r '.extra.parentUuid // .parent_session_id // empty')
cwd=$(printf '%s' "$payload" | jq -r '.cwd // empty')

if [[ -n "$parent" ]]; then printf '{}\n'; exit 0; fi
if [[ "$is_first" != "true" ]]; then printf '{}\n'; exit 0; fi
if [[ -z "$cwd" ]]; then printf '{}\n'; exit 0; fi

directive=$(node "$TIM_CLI" resolve-project --cwd "$cwd" --format directive 2>/dev/null || true)

# No marker (or corrupt nearest) → silent skip, normal session start.
if [[ -z "$directive" ]]; then printf '{}\n'; exit 0; fi

jq -n --arg ctx "$directive" '{context: $ctx}'
exit 0
