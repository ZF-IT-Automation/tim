#!/bin/bash
# tim-snapshot-sh — Cron-driven snapshot of the live TIM DB.
# Uses `tim snapshot` CLI (better-sqlite3 backup API), not raw `cp`.
# Runs every 30 minutes. Registered as `*/30 * * * *`.
#
# Environment:
#   TIM_DB_PATH  — override db location (default: ~/.tim/tim.db)
#   TIM_SNAPSHOT_DIR — override snapshot dir (default: /tmp/tim-snapshots)
#   TIM_SNAPSHOT_RETENTION_HOURS — prune horizon in hours (default: 48)
#   TIM_SNAPSHOT_TIMEOUT_SEC — wall-clock cap for `tim snapshot` (default: 300).
#     SIGTERM at the cap, then SIGKILL 15s later. Hung backups previously
#     ignored SIGTERM (D-state / node) and stacked every 30 min.

set -euo pipefail

TIM="$(which tim 2>/dev/null || echo "${HOME}/projects/tim/packages/tim-cli/dist/cli.js")"
if [ "${TIM}" = ".js" ] || [ ! -f "${TIM}" ]; then
  # try node path
  TIM="node ${HOME}/projects/tim/packages/tim-cli/dist/cli.js"
fi

OUT_DIR="${TIM_SNAPSHOT_DIR:-/tmp/tim-snapshots}"
PRUNE_HOURS="${TIM_SNAPSHOT_RETENTION_HOURS:-48}"

mkdir -p "${OUT_DIR}" 2>/dev/null || true

# Snapshot (quiet mode in cron — only errors to stderr, success to log file)
LOG_FILE="${HOME}/.tim/logs/snapshot-cron.log"
mkdir -p "$(dirname "${LOG_FILE}")" 2>/dev/null || true

LOCK_FILE="${TIM_SNAPSHOT_LOCK:-/tmp/tim-snapshot.lock}"
exec 9>"${LOCK_FILE}"
if ! flock -n 9; then
  echo "[$(date -Iseconds)] SKIP: previous snapshot still running" >> "${LOG_FILE}"
  exit 0
fi

TIMEOUT_SEC="${TIM_SNAPSHOT_TIMEOUT_SEC:-300}"

echo "[$(date -Iseconds)] snapshot start" >> "${LOG_FILE}"

set +e
MAX_BYTES="${TIM_SNAPSHOT_MAX_BYTES:-8589934592}"
RESULT=$(timeout --kill-after=15s "${TIMEOUT_SEC}s" node "${TIM}" snapshot --prune-hours "${PRUNE_HOURS}" --max-bytes "${MAX_BYTES}" --quiet 2>&1)
ec=$?
set -e
if [ "${ec}" -ne 0 ]; then
  if [ "${ec}" -eq 124 ] || [ "${ec}" -eq 137 ]; then
    echo "[$(date -Iseconds)] TIMEOUT: snapshot exceeded ${TIMEOUT_SEC}s (exit ${ec}; SIGKILL follow-up 15s)" >> "${LOG_FILE}"
  else
    echo "[$(date -Iseconds)] FAILED: ${RESULT}" >> "${LOG_FILE}"
  fi
  exit 1
fi

echo "[$(date -Iseconds)] OK: $(grep -oP 'target.*' <<< "${RESULT}" | head -1 || echo "done")" >> "${LOG_FILE}"

# Clean log older than 30 days
find "${HOME}/.tim/logs/" -name "snapshot-cron*" -mtime +30 -delete 2>/dev/null || true
