#!/bin/bash
# deploy-cron.sh — copy the repo's cron scripts to where cron actually runs them.
#
# Cron executes ~/.hermes/scripts/*.sh, which are copies, not symlinks. Merged
# and running are therefore two different things: on 2026-09-03 the deployed
# tim-wal-watchdog.sh matched no commit in either direction (review Finding 4).
# This script makes the copy reproducible.
#
# The existing destination file is archived before it is overwritten. The
# deployed tim-wal-watchdog.sh is the only surviving record of what ran during
# that incident and must not be lost.
#
# Usage:
#   bash scripts/deploy-cron.sh --dry-run     # report, write nothing
#   bash scripts/deploy-cron.sh               # archive, then copy
#   bash scripts/deploy-cron.sh --dest DIR    # deploy somewhere else (testing)
#
# Environment:
#   TIM_CRON_DEST — same as --dest (default: ~/.hermes/scripts)
#
# Idempotent: identical files are neither archived nor copied, so a second run
# reports everything as identical and touches nothing.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${TIM_CRON_DEST:-${HOME}/.hermes/scripts}"
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=1; shift ;;
    --dest) DEST="${2:?--dest needs a directory}"; shift 2 ;;
    --dest=*) DEST="${1#--dest=}"; shift ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "deploy-cron: unknown argument: $1" >&2; exit 2 ;;
  esac
done

SOURCES=(
  "${ROOT}"/scripts/cron/*.sh
  "${ROOT}/scripts/tim-compact-error-log.sh"
  # Not cron entries themselves, but the cron job and `tim restore` both invoke
  # them from ~/.hermes/scripts. Leaving them unsynced is how the deployed
  # stop script stayed fail-open and the start script kept its user-unit bug.
  "${ROOT}/scripts/tim-mcp-stop.sh"
  "${ROOT}/scripts/tim-mcp-start.sh"
)

if [[ ! -e "${SOURCES[0]}" ]]; then
  echo "deploy-cron: no scripts found under ${ROOT}/scripts/cron" >&2
  exit 1
fi

ARCHIVE_DIR="${DEST}/archive"
STAMP="$(date +%Y%m%d-%H%M%S)"
PREFIX="[deploy-cron]"
[[ "${DRY_RUN}" -eq 1 ]] && PREFIX="[deploy-cron][dry-run]"

echo "${PREFIX} source: ${ROOT}/scripts"
echo "${PREFIX} dest:   ${DEST}"

new=0
changed=0
same=0

for src in "${SOURCES[@]}"; do
  name="$(basename "${src}")"
  dst="${DEST}/${name}"

  if [[ ! -e "${dst}" ]]; then
    new=$((new + 1))
    echo "${PREFIX} NEW       ${name}"
  elif cmp -s "${src}" "${dst}"; then
    same=$((same + 1))
    echo "${PREFIX} identical ${name}"
    continue
  else
    changed=$((changed + 1))
    echo "${PREFIX} DIFFERS   ${name} -> archive/${name}.${STAMP}"
  fi

  if [[ "${DRY_RUN}" -eq 1 ]]; then
    continue
  fi

  mkdir -p "${DEST}"
  if [[ -e "${dst}" ]]; then
    mkdir -p "${ARCHIVE_DIR}"
    cp -p "${dst}" "${ARCHIVE_DIR}/${name}.${STAMP}"
  fi
  install -m 755 "${src}" "${dst}"
done

echo "${PREFIX} summary: ${new} new, ${changed} differing, ${same} identical"

if [[ "${DRY_RUN}" -eq 1 && $((new + changed)) -gt 0 ]]; then
  echo "${PREFIX} rerun without --dry-run to deploy"
fi

# Copying the file is only half the job — cron still has to call it. Read only:
# this script never edits the crontab.
CRONTAB="$(crontab -l 2>/dev/null || true)"
if [[ "${CRONTAB}" != *tim-compact-error-log.sh* ]]; then
  cat <<EOF

${PREFIX} no crontab entry for tim-compact-error-log.sh. Paste into \`crontab -e\`:

41 4 * * * ${DEST}/tim-compact-error-log.sh >> \${HOME}/.hermes/cron-outputs/tim-compact-error-log.log 2>&1

See docs/cron.md.
EOF
fi
