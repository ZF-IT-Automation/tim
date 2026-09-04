#!/bin/bash
# tim-mcp-stop.sh — Stop the TIM MCP server gracefully.
# Per-device: detects the manager (systemd > launchctl > pm2 > bare background).
# Always reaps leftover stdio server.js children. systemd --user stop only
# kills the HTTP daemon; Cursor/Claude/Codex spawn extra writers that hold the WAL.

set -euo pipefail

LOG_PREFIX="[tim-mcp-stop]"

reap_stdio_children() {
  local pids rc=0
  # Capture pgrep's status via ||, not via `if ! pids=$(...)`. Inside the then-
  # branch of a negated compound, $? is the negation's status (0), not pgrep's,
  # so the old form took the FAIL branch every time there was nothing to stop.
  pids=$(pgrep -f 'tim-mcp.*dist/server\.js') || rc=$?
  if [[ "${rc}" -ne 0 ]]; then
    if [[ "${rc}" -eq 1 ]]; then
      echo "$LOG_PREFIX no leftover tim-mcp processes"
      return 0
    fi
    echo "$LOG_PREFIX FAIL: pgrep error (rc=${rc}) — refusing to assume no writers" >&2
    exit 1
  fi
  echo "$LOG_PREFIX killing leftover tim-mcp processes: $pids"
  kill $pids 2>/dev/null || true
  sleep 2
  pids=$(pgrep -f 'tim-mcp.*dist/server\.js' || true)
  if [ -n "$pids" ]; then
    echo "$LOG_PREFIX SIGKILL stubborn processes: $pids"
    kill -9 $pids 2>/dev/null || true
  fi
}

detect_and_stop() {
  if command -v systemctl >/dev/null 2>&1 && systemctl --user is-active --quiet tim-mcp.service 2>/dev/null; then
    echo "$LOG_PREFIX stopping systemd unit tim-mcp.service"
    systemctl --user stop tim-mcp.service
  elif command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet tim-mcp.service 2>/dev/null; then
    echo "$LOG_PREFIX stopping systemd unit tim-mcp.service"
    systemctl stop tim-mcp.service
  elif command -v launchctl >/dev/null 2>&1 && launchctl list 2>/dev/null | grep -q "tim.mcp"; then
    echo "$LOG_PREFIX stopping launchd job tim.mcp"
    launchctl stop tim.mcp
  elif command -v pm2 >/dev/null 2>&1 && pm2 list 2>/dev/null | grep -q "tim-mcp"; then
    echo "$LOG_PREFIX stopping pm2 process tim-mcp"
    pm2 stop tim-mcp >/dev/null 2>&1 || true
  fi
  reap_stdio_children
}

detect_and_stop

# Wait up to 5s for file handle release (so subsequent cp is not racing)
for i in 1 2 3 4 5; do
  if ! pgrep -f 'tim-mcp.*dist/server\.js' >/dev/null 2>&1; then
    echo "$LOG_PREFIX verified: no tim-mcp processes"
    exit 0
  fi
  sleep 1
done

echo "$LOG_PREFIX FAIL: tim-mcp processes still alive after 5s — refusing to proceed" >&2
exit 1
