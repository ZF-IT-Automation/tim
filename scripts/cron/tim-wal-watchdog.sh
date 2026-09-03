#!/bin/bash
# TIM WAL/DB Health Watchdog
# - Checks SQLite WAL size and DB integrity
# - Auto-checkpoints if WAL grows too large
# - Alerts on corruption (runs as no_agent cronjob)
#
# 2026-09-03: integrity_check + PASSIVE checkpoint on a 28 GB DB hung and
# let WAL grow to 69 GB. Skip integrity on large files, cap sqlite3 with
# timeout, and TRUNCATE at CRIT so the WAL file actually shrinks.
# Checkpoint timeout is failure (exit 3), not success. On CRIT timeout,
# SIGTERM stdio writers (not the HTTP daemon) so a live-parent runaway
# cannot keep holding the WAL.

set -e

DB_PATH="${HOME}/.tim/tim.db"
WAL_PATH="${DB_PATH}-wal"
LOG_DIR="${HOME}/.hermes/cron-outputs/tim-wal-watchdog"
mkdir -p "${LOG_DIR}"

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
LOG_FILE="${LOG_DIR}/${TIMESTAMP}.log"

WAL_WARN_MB=50
WAL_CRIT_MB=200
# Skip PRAGMA integrity_check above this — it scans the whole file.
INTEGRITY_MAX_MB=2048
SQLITE_TIMEOUT_SEC="${TIM_WAL_WATCHDOG_TIMEOUT_SEC:-30}"

sqlite_timed() {
  timeout --kill-after=5s "${SQLITE_TIMEOUT_SEC}s" sqlite3 "${DB_PATH}" "$1" 2>&1
}

# Keep in lockstep with packages/tim-cli/src/wal-watchdog.ts
checkpoint_failed() {
  local out="${1:-}"
  [[ -z "${out}" || "${out}" == *timeout* ]]
}

reap_stdio_writers() {
  # Keep in lockstep with packages/tim-cli/src/wal-watchdog.ts stdioWritersToReap:
  # all PPID-1 stdio orphans, else the single hottest live-parent writer.
  local pid ppid cmd writes
  local orphans=()
  local best_pid="" best_writes=0
  while read -r pid ppid cmd; do
    if [[ "${cmd}" == *tim-mcp* && "${cmd}" == *dist/server.js* && "${cmd}" != *"--http"* ]]; then
      writes=$(awk '/^write_bytes:/ {print $2}' "/proc/${pid}/io" 2>/dev/null || echo 0)
      writes=${writes:-0}
      if [[ "${ppid}" == "1" ]]; then
        orphans+=("${pid}")
      elif [[ "${writes}" -gt "${best_writes}" ]]; then
        best_writes="${writes}"
        best_pid="${pid}"
      fi
    fi
  done < <(ps -eo pid=,ppid=,args= || true)
  if [[ ${#orphans[@]} -gt 0 ]]; then
    echo "[CRIT] reaping stdio orphans: ${orphans[*]}" | tee -a "${LOG_FILE}"
    kill "${orphans[@]}" 2>/dev/null || true
    return 0
  fi
  if [[ -n "${best_pid}" && "${best_writes}" -gt 0 ]]; then
    echo "[CRIT] reaping hottest live-parent stdio writer pid=${best_pid} write_bytes=${best_writes}" | tee -a "${LOG_FILE}"
    kill "${best_pid}" 2>/dev/null || true
  fi
  return 0
}

run_checkpoint() {
  local CHECKPOINT
  CHECKPOINT=$(sqlite_timed "PRAGMA wal_checkpoint(TRUNCATE);" || echo "timeout")
  echo "Checkpoint: ${CHECKPOINT}" | tee -a "${LOG_FILE}"
  if checkpoint_failed "${CHECKPOINT}"; then
    echo "[FAIL] checkpoint timed out or empty" | tee -a "${LOG_FILE}"
    return 3
  fi
  return 0
}

if [[ ! -f "${DB_PATH}" ]]; then
  echo "[ALERT] DB file missing: ${DB_PATH}" | tee -a "${LOG_FILE}"
  exit 1
fi

DB_SIZE=$(stat -c%s "${DB_PATH}" 2>/dev/null || echo 0)
WAL_SIZE=$(stat -c%s "${WAL_PATH}" 2>/dev/null || echo 0)
WAL_MB=$((WAL_SIZE / 1024 / 1024))
DB_MB=$((DB_SIZE / 1024 / 1024))

echo "TIM WAL Watchdog — $(date -Iseconds)" | tee -a "${LOG_FILE}"
echo "DB: ${DB_MB}MB | WAL: ${WAL_MB}MB | Total: $((DB_MB + WAL_MB))MB" | tee -a "${LOG_FILE}"

if [[ ${DB_MB} -ge ${INTEGRITY_MAX_MB} ]]; then
  echo "[WARN] DB=${DB_MB}MB >= ${INTEGRITY_MAX_MB}MB — skipping integrity_check" | tee -a "${LOG_FILE}"
else
  INTEGRITY=$(sqlite_timed "PRAGMA integrity_check;" || echo "timeout")
  if [[ "${INTEGRITY}" != "ok" ]]; then
    echo "[ALERT] DB INTEGRITY FAILED: ${INTEGRITY}" | tee -a "${LOG_FILE}"
    exit 2
  fi
fi

if [[ ${WAL_MB} -ge ${WAL_CRIT_MB} ]]; then
  echo "[CRIT] WAL=${WAL_MB}MB >= ${WAL_CRIT_MB}MB — forcing TRUNCATE checkpoint" | tee -a "${LOG_FILE}"
  if ! run_checkpoint; then
    reap_stdio_writers
    exit 3
  fi
  exit 0
elif [[ ${WAL_MB} -ge ${WAL_WARN_MB} ]]; then
  echo "[WARN] WAL=${WAL_MB}MB >= ${WAL_WARN_MB}MB — TRUNCATE checkpoint" | tee -a "${LOG_FILE}"
  if ! run_checkpoint; then
    exit 3
  fi
  exit 0
else
  echo "[OK] WAL within healthy bounds" | tee -a "${LOG_FILE}"
  exit 0
fi
