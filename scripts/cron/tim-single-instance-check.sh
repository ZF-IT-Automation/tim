#!/bin/bash
# TIM Singleton Check — systemd service health monitor
# HTTP/SSE mode (June 2026): tim-mcp now runs as a systemd user service.
# This script checks systemd instead of looking for individual processes.
# No lockfile handling needed — systemd manages the singleton lifecycle.

set -e

LOG_DIR="${HOME}/.hermes/cron-outputs/tim-single-instance-check"
mkdir -p "${LOG_DIR}"

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
LOG_FILE="${LOG_DIR}/${TIMESTAMP}.log"

log() {
  echo "$@" | tee -a "${LOG_FILE}"
}

log "TIM Singleton Check — $(date -Iseconds)"

# Stdio children (Cursor/Claude/Codex) share the live DB with the HTTP daemon.
# PPID 1 means the parent harness died — that is the 2026-09-03 EPIPE storm.
orphans=$(ps -eo pid,ppid,cmd | awk '/packages\/tim-mcp\/dist\/server\.js/ && !/awk/ && $2==1 {print $1}')
if [[ -n "${orphans}" ]]; then
  log "[CRIT] orphan tim-mcp (PPID 1): ${orphans} — sending SIGTERM"
  kill ${orphans} 2>/dev/null || true
fi

stdio_count=$(pgrep -fc 'packages/tim-mcp/dist/server.js' || true)
log "tim-mcp processes: ${stdio_count}"
if [[ ${stdio_count} -gt 8 ]]; then
  log "[WARN] ${stdio_count} tim-mcp processes (expected HTTP daemon + a few stdio clients)"
fi

# Check systemd user service
if systemctl --user is-active tim-mcp.service &>/dev/null; then
  log "[OK] tim-mcp.service is active (systemd-managed singleton)"
  exit 0
fi

# Service is not active — try to start
log "[WARN] tim-mcp.service is not active — starting"
systemctl --user start tim-mcp.service 2>&1 | tee -a "${LOG_FILE}"
sleep 2

if systemctl --user is-active tim-mcp.service &>/dev/null; then
  log "[OK] tim-mcp.service started successfully"
  exit 0
else
  log "[FAIL] Could not start tim-mcp.service"
  systemctl --user status tim-mcp.service 2>&1 | tee -a "${LOG_FILE}"
  exit 1
fi
