#!/bin/bash
# tim-snapshot-watchdog.sh — Alert if the newest snapshot is > 2h old.
# no_agent cron (hourly). Alerts go to Telegram via ~/.hermes/bin/send-cron-telegram.
#
# Environment:
#   TIM_SNAPSHOT_DIR — snapshot directory (default: ${HOME}/.tim/snapshots)
#   TIM_BACKUP_MAX_AGE_MIN — max age in minutes (default: 120 = 2h)

set -euo pipefail

SNAPSHOT_DIR="${TIM_SNAPSHOT_DIR:-${HOME}/.tim/snapshots}"
MAX_AGE_MIN="${TIM_BACKUP_MAX_AGE_MIN:-120}"

ROLE="[tim-snapshot-watchdog]"

alert() {
  local msg="$1"
  echo "${ROLE} ${msg}" >&2
  # Telegram via the cron bot (Benni 2026-10-09); the old path wrote into the retired P0062.
  local esc="${msg//&/&amp;}"; esc="${esc//</&lt;}"; esc="${esc//>/&gt;}"
  "${HOME}/.hermes/bin/send-cron-telegram" "TIM backup watchdog: ${esc}" >/dev/null 2>&1 \
    || echo "${ROLE} telegram alert failed" >&2
}

LATEST=$(ls -t "${SNAPSHOT_DIR}"/tim-*.db 2>/dev/null | head -1 || true)

if [ -z "${LATEST}" ]; then
  alert "TIM BACKUP MISSING — no snapshots in ${SNAPSHOT_DIR}"
  exit 1
fi

if [ ! -f "${LATEST}" ]; then
  alert "TIM BACKUP MISSING — ${LATEST} does not exist (deleted?)"
  exit 1
fi

AGE_MIN=$(( ($(date +%s) - $(stat -c %Y "${LATEST}")) / 60 ))

if [ ${AGE_MIN} -gt ${MAX_AGE_MIN} ]; then
  SIZE_KB=$(du -k "${LATEST}" | cut -f1)
  alert "TIM BACKUP STALE — newest snapshot is ${AGE_MIN}m old (threshold ${MAX_AGE_MIN}m), file: $(basename "${LATEST}"), size: ${SIZE_KB}KB"
  exit 2
fi

echo "${ROLE} OK: $(basename "${LATEST}") age=${AGE_MIN}m max=${MAX_AGE_MIN}m"
exit 0
