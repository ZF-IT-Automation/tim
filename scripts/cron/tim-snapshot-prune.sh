#!/bin/bash
# tim-snapshot-prune.sh — Daily cleanup of old snapshots.
# - On-host: remove snapshots older than 48h from /tmp/tim-snapshots/
# - Off-host (pCloud): keep 7 daily snapshots, remove older via rclone
#
# Cron: 17 3 * * * ~/.hermes/scripts/tim-snapshot-prune.sh
# no_agent: runs without Hermes LLM involvement.

set -euo pipefail

SNAPSHOT_DIR="${TIM_SNAPSHOT_DIR:-/tmp/tim-snapshots}"
RETENTION_HOURS="${TIM_ONHOST_RETENTION_HOURS:-48}"
PCLOUD_REMOTE="${TIM_PCLOUD_REMOTE:-pcloud:}"
PCLOUD_PATH="${TIM_PCLOUD_BACKUP_PATH:-tim-backup}"
PCLOUD_RETENTION_DAYS="${TIM_PCLOUD_RETENTION_DAYS:-7}"

LOG_FILE="${HOME}/.tim/logs/snapshot-prune.log"
mkdir -p "$(dirname "${LOG_FILE}")" 2>/dev/null || true

prune_onhost() {
  local cutoff_epoch=$(($(date +%s) - RETENTION_HOURS * 3600))
  local pruned=0
  for f in "${SNAPSHOT_DIR}"/tim-*.db; do
    [ -f "${f}" ] || continue
    local mtime=$(stat -c %Y "${f}" 2>/dev/null || echo 0)
    if [ "${mtime}" -lt "${cutoff_epoch}" ]; then
      rm -f "${f}"
      pruned=$((pruned + 1))
    fi
  done
  echo "prune on-host: removed ${pruned} snapshots older than ${RETENTION_HOURS}h" | tee -a "${LOG_FILE}"
}

prune_offhost() {
  if ! command -v rclone >/dev/null 2>&1; then
    echo "prune off-host: rclone not available, skipping" | tee -a "${LOG_FILE}"
    return 0
  fi

  # rclone does not have a direct prune-by-age, so we:
  # 1. List files in the pCloud backup dir
  # 2. Delete files older than 7 days
  local cutoff_epoch=$(($(date +%s) - PCLOUD_RETENTION_DAYS * 86400))
  local list
  list=$(rclone lsjson "${PCLOUD_REMOTE}${PCLOUD_PATH}" 2>/dev/null || echo "[]")

  if [ "${list}" = "[]" ] || [ -z "${list}" ]; then
    echo "prune off-host: no files in ${PCLOUD_REMOTE}${PCLOUD_PATH}" | tee -a "${LOG_FILE}"
    return 0
  fi

  local pruned=0
  while IFS= read -r entry; do
    local mod_time
    mod_time=$(echo "${entry}" | jq -r '.ModTime // empty' 2>/dev/null || echo "")
    local name
    name=$(echo "${entry}" | jq -r '.Name // empty' 2>/dev/null || echo "")

    [ -z "${mod_time}" ] && continue
    [ -z "${name}" ] && continue

    # mod_time is RFC3339, convert to epoch
    local mod_epoch
    mod_epoch=$(date -d "${mod_time}" +%s 2>/dev/null || echo 0)

    if [ "${mod_epoch}" -lt "${cutoff_epoch}" ]; then
      echo "rclone delete: ${PCLOUD_REMOTE}${PCLOUD_PATH}/${name}" | tee -a "${LOG_FILE}"
      rclone delete "${PCLOUD_REMOTE}${PCLOUD_PATH}/${name}" >/dev/null 2>&1 || true
      pruned=$((pruned + 1))
    fi
  done < <(echo "${list}" | jq -c '.[]' 2>/dev/null || true)

  echo "prune off-host: removed ${pruned} snapshots older than ${PCLOUD_RETENTION_DAYS}d" | tee -a "${LOG_FILE}"
}

echo "[$(date -Iseconds)] prune start" >> "${LOG_FILE}"
prune_onhost
prune_offhost
echo "[$(date -Iseconds)] prune complete" >> "${LOG_FILE}"
