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
#   Codex CLI    → plain text directive (stdout)
#   Fallback     → {additional_context: "…"}  (Cursor-safe, also works as plain text)

set -euo pipefail

TIM_CLI="${TIM_CLI:-/home/bbbee/projects/tim/packages/tim-cli/dist/cli.js}"

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

# --- Resolve project marker ---
directive=$(node "$TIM_CLI" resolve-project --walk-up --cwd "$cwd" --format directive 2>/dev/null || true)
if [[ -z "$directive" ]]; then
  # No .tim-project marker found — silent skip (exit 0)
  exit 0
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

# Codex sends payload with .session_id but NOT .hookSpecificOutput or .conversation_id
if printf '%s' "$payload" | jq -e '.session_id // empty' >/dev/null 2>&1; then
  # Codex format — plain text is auto-injected as extra developer context
  printf '%s\n' "$directive"
  exit 0
fi

# Fallback: no recognizable payload (empty stdin) — emit Cursor-safe JSON
# This covers: Cursor without payload, manual testing, unknown harnesses
exec jq -n --arg ctx "$directive" \
  '{additional_context: $ctx}'
