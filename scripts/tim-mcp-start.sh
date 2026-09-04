#!/bin/bash
# tim-mcp-start.sh — Start the TIM MCP server.
# Per-device: detects the manager (systemd > launchctl > pm2 > bare background).
# Strato VPS: bare background (Hermes spawns on demand) → noop.

set -uo pipefail

LOG_PREFIX="[tim-mcp-start]"

detect_and_start() {
  # Try systemd first
  # The unit is a --user unit on this host; the system scope does not list it.
  # Checking only the system scope made this branch unreachable, so every
  # restore/compaction left the HTTP daemon stopped (2026-09-04).
  if command -v systemctl >/dev/null 2>&1 && \
     { systemctl --user list-unit-files 2>/dev/null | grep -q "tim-mcp.service" || \
       systemctl list-unit-files 2>/dev/null | grep -q "tim-mcp.service"; }; then
    echo "$LOG_PREFIX starting systemd unit tim-mcp.service"
    if systemctl --user is-enabled --quiet tim-mcp.service 2>/dev/null; then
      systemctl --user start tim-mcp.service
    else
      systemctl start tim-mcp.service
    fi
    return 0
  fi

  # Try launchctl (macOS)
  if command -v launchctl >/dev/null 2>&1 && launchctl list 2>/dev/null | grep -q "tim.mcp"; then
    echo "$LOG_PREFIX starting launchd job tim.mcp"
    launchctl start tim.mcp
    return 0
  fi

  # Try pm2
  if command -v pm2 >/dev/null 2>&1 && pm2 list 2>/dev/null | grep -q "tim-mcp"; then
    echo "$LOG_PREFIX starting pm2 process tim-mcp"
    pm2 start tim-mcp >/dev/null 2>&1 || true
    return 0
  fi

  # Fallback: bare background (Strato VPS) — Hermes spawns on demand
  if pgrep -f 'tim-mcp.*dist/server\.js' >/dev/null 2>&1; then
    echo "$LOG_PREFIX tim-mcp already running (PID(s): $(pgrep -f 'tim-mcp.*dist/server\.js' | tr '\n' ' '))"
  else
    echo "$LOG_PREFIX no manager detected — Hermes will spawn tim-mcp on next MCP call"
  fi
  return 0
}

detect_and_start
