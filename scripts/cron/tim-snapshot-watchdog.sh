#!/bin/bash
# tim-snapshot-watchdog.sh — Alert if the newest snapshot is > 2h old.
# no_agent cron (hourly). Writes alert to TIM P0062/Tasks via tim-wrap-cli.sh.
#
# Environment:
#   TIM_SNAPSHOT_DIR — snapshot directory (default: /tmp/tim-snapshots)
#   TIM_BACKUP_MAX_AGE_MIN — max age in minutes (default: 120 = 2h)

set -euo pipefail

SNAPSHOT_DIR="${TIM_SNAPSHOT_DIR:-/tmp/tim-snapshots}"
MAX_AGE_MIN="${TIM_BACKUP_MAX_AGE_MIN:-120}"

ROLE="[tim-snapshot-watchdog]"

alert() {
  local msg="$1"
  echo "${ROLE} ${msg}" >&2
  # Write to TIM via tim-wrap-cli.sh, timeout in case MCP is down
  if [ -x ~/.hermes/scripts/tim-wrap-cli.sh ]; then
    timeout 10 ~/.hermes/scripts/tim-wrap-cli.sh write \
      --content "TIM-BACKUP-WATCHDOG: ${msg}" \
      --parent-title Tasks --project-id P0062 \
      --tags '#task,#urgent,#backup,#watchdog' \
      --confidence 1.0 2>/dev/null || echo "${ROLE} alert delivery failed (TIM MCP unreachable?)" >&2
  fi
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
