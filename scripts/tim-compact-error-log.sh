#!/bin/bash
# Controlled TIM error_log compaction after a write-storm (2026-09-03).
#
# Order is mandatory:
#   1. stop every tim-mcp writer (HTTP + stdio)
#   2. rebuild error_log to the newest 10_000 rows (no mass DELETE)
#   3. VACUUM
#   4. start the HTTP daemon again
#
# Does not run against a live writer. Restore from /tmp/tim-snapshots if this
# exits non-zero after stop.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STOP="${HOME}/.hermes/scripts/tim-mcp-stop.sh"
if [[ ! -x "${STOP}" ]]; then
  STOP="${ROOT}/scripts/tim-mcp-stop.sh"
fi
START="${HOME}/.hermes/scripts/tim-mcp-start.sh"
CLI="${ROOT}/packages/tim-cli/dist/cli.js"

if [[ ! -f "${CLI}" ]]; then
  echo "tim-compact-error-log: missing ${CLI} — run npm run build" >&2
  exit 1
fi

echo "[tim-compact-error-log] stopping MCP"
"${STOP}"

echo "[tim-compact-error-log] compacting error_log + VACUUM"
node "${CLI}" compact-error-log --vacuum

if [[ -x "${START}" ]]; then
  echo "[tim-compact-error-log] starting MCP"
  "${START}"
else
  echo "[tim-compact-error-log] no start script at ${START} — start MCP manually" >&2
fi
