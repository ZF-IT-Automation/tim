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
# SIGTERM stdio writers with highest *current write rate* (not lifetime bytes).

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
# Minimum sustained write rate (bytes/sec) over SAMPLE_SEC to reap a live parent.
MIN_WRITE_RATE_BPS="${TIM_WAL_MIN_WRITE_RATE_BPS:-524288}"
SAMPLE_SEC="${TIM_WAL_SAMPLE_SEC:-2}"

sqlite_timed() {
  timeout --kill-after=5s "${SQLITE_TIMEOUT_SEC}s" sqlite3 "${DB_PATH}" "$1" 2>&1
}

# Keep in lockstep with packages/tim-cli/src/wal-watchdog.ts
checkpoint_failed() {
  local out="${1:-}"
  [[ -z "${out}" || "${out}" == *timeout* ]] && return 0
  if [[ "${out}" =~ ^([0-9]+)[[:space:]\|]+([0-9]+)[[:space:]\|]+([0-9]+) ]]; then
    [[ "${BASH_REMATCH[1]}" -eq 0 ]] && return 1
    return 0
  fi
  return 0
}

sample_stdio_writers() {
  local outfile="${1}"
  : > "${outfile}"
  while read -r pid ppid cmd; do
    if is_tim_mcp_stdio_writer "${pid}" "${cmd}"; then
      local writes
      writes=$(awk '/^write_bytes:/ {print $2}' "/proc/${pid}/io" 2>/dev/null || echo 0)
      writes=${writes:-0}
      printf '%s %s %s %s\n' "${pid}" "${ppid}" "${writes}" "${cmd}" >> "${outfile}"
    fi
  done < <(ps -eo pid=,ppid=,args= || true)
}

# Keep in lockstep with packages/tim-cli/src/mcp-writer-process.ts
is_tim_mcp_stdio_writer() {
  local pid="${1}"
  local cmd="${2}"
  [[ "${cmd}" == *"--http"* ]] && return 1
  local cmdline cwd server_arg script_path
  cmdline=$(tr '\0' ' ' < "/proc/${pid}/cmdline" 2>/dev/null || true)
  [[ "${cmdline}" == *dist/server.js* ]] || return 1
  server_arg=$(awk -v RS='\0' '$0 ~ /dist\/server\.js/ || $0 ~ /server\.js$/ {print; exit}' "/proc/${pid}/cmdline" 2>/dev/null || true)
  [[ -n "${server_arg}" ]] || return 1
  if [[ "${server_arg}" == /* ]]; then
    script_path="${server_arg}"
  else
    cwd=$(readlink "/proc/${pid}/cwd" 2>/dev/null || true)
    [[ -n "${cwd}" ]] || return 1
    script_path="${cwd}/${server_arg}"
  fi
  [[ "${script_path}" == */tim-mcp/dist/server.js ]] || return 1
  return 0
}

reap_stdio_writers() {
  local before after
  before=$(mktemp)
  after=$(mktemp)
  trap 'rm -f "${before}" "${after}"' RETURN
  sample_stdio_writers "${before}"
  sleep "${SAMPLE_SEC}"
  sample_stdio_writers "${after}"

  local orphans=()
  while read -r pid ppid writes cmd; do
    if [[ "${ppid}" == "1" ]]; then
      orphans+=("${pid}")
    fi
  done < "${after}"

  if [[ ${#orphans[@]} -gt 0 ]]; then
    echo "[CRIT] reaping stdio orphans: ${orphans[*]}" | tee -a "${LOG_FILE}"
    kill "${orphans[@]}" 2>/dev/null || true
    return 0
  fi

  local best_pid="" best_rate=0 second_rate=0
  while read -r pid ppid writes_after cmd; do
    [[ "${ppid}" == "1" ]] && continue
    local writes_before=0
    writes_before=$(awk -v p="${pid}" '$1==p {print $3; exit}' "${before}")
    writes_before=${writes_before:-0}
    local delta=$((writes_after - writes_before))
    local rate=0
    if [[ "${SAMPLE_SEC}" -gt 0 ]]; then
      rate=$((delta / SAMPLE_SEC))
    fi
    if [[ "${rate}" -ge "${MIN_WRITE_RATE_BPS}" ]]; then
      if [[ "${rate}" -gt "${best_rate}" ]]; then
        second_rate="${best_rate}"
        best_rate="${rate}"
        best_pid="${pid}"
      elif [[ "${rate}" -gt "${second_rate}" ]]; then
        second_rate="${rate}"
      fi
    fi
  done < "${after}"

  if [[ -z "${best_pid}" ]]; then
    return 0
  fi
  if [[ "${second_rate}" -gt 0 && $((second_rate * 100)) -ge $((best_rate * 80)) ]]; then
    echo "[CRIT] ambiguous write rates (${best_rate} vs ${second_rate} B/s) — killing nobody" | tee -a "${LOG_FILE}"
    return 0
  fi
  echo "[CRIT] reaping fastest live-parent stdio writer pid=${best_pid} rate=${best_rate}B/s" | tee -a "${LOG_FILE}"
  kill "${best_pid}" 2>/dev/null || true
  return 0
}

run_checkpoint() {
  local CHECKPOINT
  CHECKPOINT=$(sqlite_timed "PRAGMA wal_checkpoint(TRUNCATE);" || echo "timeout")
  echo "Checkpoint: ${CHECKPOINT}" | tee -a "${LOG_FILE}"
  if checkpoint_failed "${CHECKPOINT}"; then
    echo "[FAIL] checkpoint timed out, empty, busy, or malformed" | tee -a "${LOG_FILE}"
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
