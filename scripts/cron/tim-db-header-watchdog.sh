#!/bin/bash
# TIM DB Header Corruption Detector
# Catches the specific corruption pattern seen 2026-06-07:
#   Page 1 header has garbage in bytes 24-48 (db_size, freelist, schema_cookie)
#   SQLite magic "SQLite format 3\0" still intact at bytes 0-15
# Triggers when: db_size_pages > 1,000,000 (real DB has ~10,000 pages)
#   OR freelist count > 1,000,000
#
# No schema-cookie check: until 2026-10-03 every store open rewrote the
# triggers, which left the live cookie above 557,000, and a restored backup-API
# snapshot resets it to 1. The June garbage hit db_size and freelist as well.

set -e

DB_PATH="${TIM_DB_PATH:-${HOME}/.tim/tim.db}"
LOG_DIR="${HOME}/.hermes/cron-outputs/tim-db-header-watchdog"
mkdir -p "${LOG_DIR}"

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
LOG_FILE="${LOG_DIR}/${TIMESTAMP}.log"
# Per-run logs: keep two weeks (41k files had piled up by 2026-10-09).
find "${LOG_DIR}" -name '*.log' -mtime +14 -delete 2>/dev/null || true

# Alerts reach Benni through the cron Telegram bot, not only this log (2026-10-09).
send_alerts() {
  local lines
  lines=$(grep -E '^\[(ALERT|CRIT|FAIL|ERROR)\]' "${LOG_FILE}" 2>/dev/null || true)
  [[ -z "${lines}" ]] && return 0
  lines="${lines//&/&amp;}"; lines="${lines//</&lt;}"; lines="${lines//>/&gt;}"
  "${HOME}/.hermes/bin/send-cron-telegram" "TIM $(basename "$0" .sh):"$'\n'"${lines}" >/dev/null 2>&1 \
    || echo "[WARN] telegram alert failed" >>"${LOG_FILE}"
}
trap send_alerts EXIT

if [[ ! -f "${DB_PATH}" ]]; then
  echo "[ALERT] DB file missing: ${DB_PATH}" | tee -a "${LOG_FILE}"
  exit 1
fi

# Extract header values using Python (sqlite3 won't open corrupt DB)
HEADER_CHECK=$(DB_PATH="${DB_PATH}" python3 -c "
import os
import struct
import sys
try:
    with open(os.environ['DB_PATH'], 'rb') as f:
        header = f.read(100)
    if header[:16] != b'SQLite format 3\x00':
        print('CORRUPT:magic_missing')
        sys.exit(0)
    db_size = struct.unpack('>I', header[28:32])[0]
    free_count = struct.unpack('>I', header[36:40])[0]
    schema_cookie = struct.unpack('>I', header[40:44])[0]
    if db_size > 1000000:
        print(f'CORRUPT:db_size_too_large:{db_size}')
    elif free_count > 1000000:
        print(f'CORRUPT:freelist_too_large:{free_count}')
    else:
        print(f'OK:db_size={db_size} schema_cookie={schema_cookie} freelist={free_count}')
except Exception as e:
    print(f'ERROR:{e}')
" 2>&1)

RESULT=$(echo "${HEADER_CHECK}" | head -1)
echo "TIM DB Header Watchdog — $(date -Iseconds)" | tee -a "${LOG_FILE}"
echo "Result: ${RESULT}" | tee -a "${LOG_FILE}"

if [[ "${RESULT}" == CORRUPT:* ]]; then
  echo "[ALERT] DB HEADER CORRUPTION DETECTED: ${RESULT}" | tee -a "${LOG_FILE}"
  echo "RECOVERY: see /home/bbbee/projects/tasks/.archive/task-tim-db-recovery/JOURNAL.md" | tee -a "${LOG_FILE}"
  exit 2
elif [[ "${RESULT}" == ERROR:* ]]; then
  echo "[ERROR] ${RESULT}" | tee -a "${LOG_FILE}"
  exit 1
fi

exit 0
