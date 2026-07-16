#!/usr/bin/env bash
# tim-session-start.sh — Generic TIM auto-load hook for CLI coding agents.
#
# Supports: Claude Code, Cursor CLI, Codex CLI, OpenCode (via plugin wrapper).
#
# Reads a harness-specific session-start payload from stdin, resolves the nearest
# .tim-project marker (walk-up from cwd), and emits the buildLoadDirective text
# wrapped in the JSON envelope expected by the calling harness.
#
# Requires: bash, jq, node (for tim CLI). Override TIM_CLI path via env var.
#
# Output formats (auto-detected from stdin payload shape):
#   Claude Code  → {hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: "…"}}
#   Cursor CLI   → {additional_context: "…"}
#   Hermes/Codex → {context: "…"}  (JSON — plain text broke Hermes session binding, PITFALLS-45)
#   Fallback     → {additional_context: "…"}  (Cursor-safe, also works as plain text)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
# shellcheck source=lib/resolve-tim-cli.sh
source "$SCRIPT_DIR/lib/resolve-tim-cli.sh"
TIM_HOOKS_MARKER="${TIM_MARKER_MODULE:-${SCRIPT_DIR}/../dist/marker.js}"

# Read stdin once (some harnesses pass payload, some pass nothing)
payload="$(cat -)"

# --- Determine cwd ---
cwd=""

# Strategy 1: Extract from payload (Claude Code, Codex, Hermes send .cwd)
if [[ -n "$payload" ]]; then
  cwd=$(printf '%s' "$payload" | jq -r '.cwd // empty' 2>/dev/null || true)
fi

# Strategy 2: Extract workspace path (some Cursor versions)
if [[ -z "$cwd" && -n "$payload" ]]; then
  cwd=$(printf '%s' "$payload" | jq -r '.workspace // empty' 2>/dev/null || true)
fi

# Strategy 3: Fall back to current working directory
if [[ -z "$cwd" ]]; then
  cwd=$(pwd)
fi

# Extract session_id from payload (for marker rotation, Fix F)
hook_session=$(printf '%s' "$payload" | jq -r '.session_id // empty' 2>/dev/null || true)

# --- Resolve project marker ---
directive=$(run_tim_cli resolve-project --walk-up --cwd "$cwd" --format directive 2>/dev/null || true)
if [[ -z "$directive" ]]; then
  # No .tim-project marker found — silent skip (exit 0)
  exit 0
fi

# ── Session rotation: update .tim-project with current session ──
# Prevents stale cron session IDs from persisting in the marker (PITFALLS-46).
# cwd/session are passed via env, never interpolated into the JS source —
# paths or session ids containing quotes/backslashes must not break rotation.
if [[ -n "$hook_session" && -f "$TIM_HOOKS_MARKER" ]]; then
  TIM_HOOK_CWD="$cwd" TIM_HOOK_SESSION="$hook_session" TIM_MARKER_MODULE="$TIM_HOOKS_MARKER" \
    node --input-type=module -e "
    const { pathToFileURL } = await import('node:url');
    const m = await import(pathToFileURL(process.env.TIM_MARKER_MODULE).href);
    m.rotateMarkerSession(process.env.TIM_HOOK_CWD, process.env.TIM_HOOK_SESSION);
  " 2>/dev/null || true
fi

# --- Detect harness and format output ---

# Claude Code sends payload with .hookSpecificOutput (its own hook envelope)
if printf '%s' "$payload" | jq -e '.hookSpecificOutput // empty' >/dev/null 2>&1; then
  # Claude Code / Hermes format
  exec jq -n --arg ctx "$directive" \
    '{hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: $ctx}}'
fi

# Cursor sends payload with .conversation_id or .additional_context
if printf '%s' "$payload" | jq -e '(.conversation_id // empty) or (.additional_context // empty)' >/dev/null 2>&1; then
  # Cursor format
  exec jq -n --arg ctx "$directive" \
    '{additional_context: $ctx}'
fi

# Hermes / Codex — payload has .session_id but NOT .hookSpecificOutput or .conversation_id
if printf '%s' "$payload" | jq -e '.session_id // empty' >/dev/null 2>&1; then
  # Hermes expects JSON context (PITFALLS-45: plain-text broke session binding)
  exec jq -n --arg ctx "$directive" \
    '{context: $ctx}'
fi

# Fallback: no recognizable payload (empty stdin) — emit Cursor-safe JSON
# This covers: Cursor without payload, manual testing, unknown harnesses
exec jq -n --arg ctx "$directive" \
  '{additional_context: $ctx}'
