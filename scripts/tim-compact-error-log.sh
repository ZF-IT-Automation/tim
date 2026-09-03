#!/bin/bash
# Controlled TIM error_log compaction after a write-storm (2026-09-03).
#
# Order is mandatory:
#   1. stop every tim-mcp writer (HTTP + stdio)
#   2. rebuild error_log to the newest 10_000 rows (no mass DELETE)
#   3. VACUUM (opt-in via CLI --vacuum)
#   4. start the HTTP daemon again
#
# Guaranteed restart: trap ensures tim-mcp-start runs even on failure.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STOP="${HOME}/.hermes/scripts/tim-mcp-stop.sh"
if [[ ! -x "${STOP}" ]]; then
  STOP="${ROOT}/scripts/tim-mcp-stop.sh"
fi
START="${HOME}/.hermes/scripts/tim-mcp-start.sh"
CLI="${ROOT}/packages/tim-cli/dist/cli.js"
STARTED=0

restart_mcp() {
  if [[ "${STARTED}" -eq 1 ]]; then
    return 0
  fi
  if [[ -x "${START}" ]]; then
    echo "[tim-compact-error-log] starting MCP"
    "${START}" || true
    STARTED=1
  else
    echo "[tim-compact-error-log] no start script at ${START} — start MCP manually" >&2
  fi
}

trap restart_mcp EXIT

if [[ ! -f "${CLI}" ]]; then
  echo "tim-compact-error-log: missing ${CLI} — run npm run build" >&2
  exit 1
fi

echo "[tim-compact-error-log] stopping MCP"
"${STOP}"

echo "[tim-compact-error-log] compacting error_log"
if ! node "${CLI}" compact-error-log --vacuum; then
  echo "[tim-compact-error-log] compaction failed — backup may exist as *.pre-compact-*" >&2
  exit 1
fi

restart_mcp
trap - EXIT
