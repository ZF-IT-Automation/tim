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
#
# Runs unattended from cron. Registered as (see docs/cron.md):
#   41 4 * * * /home/bbbee/.hermes/scripts/tim-compact-error-log.sh >> /home/bbbee/.hermes/cron-outputs/tim-compact-error-log.log 2>&1
#
# Environment:
#   TIM_ROOT                  — repo checkout (default: ~/projects/tim). Needed
#                               because the deployed copy lives in
#                               ~/.hermes/scripts/ and cannot infer the repo
#                               from its own location.
#   TIM_NODE                  — node binary (default: whatever is on PATH)
#   TIM_COMPACT_VACUUM        — 1 (default) or 0 to skip the VACUUM
#   TIM_COMPACT_TIMEOUT_SEC   — wall-clock cap for the CLI (default: 900)
#   TIM_COMPACT_KEEP_BACKUPS  — how many *.pre-compact-* copies to keep (default: 2)
#   TIM_COMPACT_LOCK          — lock file (default: /tmp/tim-compact-error-log.lock)

set -euo pipefail

log() { echo "[$(date -Iseconds)] [tim-compact-error-log] $*"; }
fail() { echo "[$(date -Iseconds)] [tim-compact-error-log] FAIL: $*" >&2; }

# The deployed copy sits in ~/.hermes/scripts/, where ../ is not the repo.
ROOT="${TIM_ROOT:-}"
if [[ -z "${ROOT}" ]]; then
  ROOT="$(cd "$(dirname "$0")/.." && pwd)"
  if [[ ! -d "${ROOT}/packages/tim-cli" ]]; then
    ROOT="${HOME}/projects/tim"
  fi
fi

STOP="${HOME}/.hermes/scripts/tim-mcp-stop.sh"
if [[ ! -x "${STOP}" ]]; then
  STOP="${ROOT}/scripts/tim-mcp-stop.sh"
fi
START="${HOME}/.hermes/scripts/tim-mcp-start.sh"
CLI="${ROOT}/packages/tim-cli/dist/cli.js"
NODE_BIN="${TIM_NODE:-$(command -v node || true)}"
TIMEOUT_SEC="${TIM_COMPACT_TIMEOUT_SEC:-900}"
KEEP_BACKUPS="${TIM_COMPACT_KEEP_BACKUPS:-2}"
STARTED=0

restart_mcp() {
  if [[ "${STARTED}" -eq 1 ]]; then
    return 0
  fi
  if [[ -x "${START}" ]]; then
    log "starting MCP"
    "${START}" || true
    STARTED=1
  else
    fail "no start script at ${START} — start MCP manually"
  fi
}

# Only one compaction at a time: cron must never stack two MCP stop/start pairs.
LOCK_FILE="${TIM_COMPACT_LOCK:-/tmp/tim-compact-error-log.lock}"
exec 9>"${LOCK_FILE}"
if ! flock -n 9; then
  log "SKIP: previous compaction still running"
  exit 0
fi

if [[ -z "${NODE_BIN}" ]]; then
  fail "no node on PATH — set TIM_NODE (cron PATH is minimal)"
  exit 1
fi

if [[ ! -x "${STOP}" ]]; then
  fail "missing stop script ${STOP} — refusing to compact with writers alive"
  exit 1
fi

if [[ ! -f "${CLI}" ]]; then
  fail "missing ${CLI} — run npm run build (or set TIM_ROOT)"
  exit 1
fi

# Nothing below here may leave the MCP server stopped.
trap restart_mcp EXIT

log "stopping MCP"
"${STOP}"

VACUUM_ARGS=()
if [[ "${TIM_COMPACT_VACUUM:-1}" != "0" ]]; then
  VACUUM_ARGS+=(--vacuum)
fi

log "compacting error_log ${VACUUM_ARGS[*]:-} (timeout ${TIMEOUT_SEC}s)"
set +e
timeout --kill-after=30s "${TIMEOUT_SEC}s" "${NODE_BIN}" "${CLI}" compact-error-log "${VACUUM_ARGS[@]}"
ec=$?
set -e
if [[ "${ec}" -ne 0 ]]; then
  if [[ "${ec}" -eq 124 || "${ec}" -eq 137 ]]; then
    fail "compaction exceeded ${TIMEOUT_SEC}s (exit ${ec}) — backup may exist as *.pre-compact-*"
  else
    fail "compaction failed (exit ${ec}) — backup may exist as *.pre-compact-*"
  fi
  exit 1
fi

# Each run copies the whole DB before rebuilding. Daily, unpruned, that fills
# the disk faster than error_log ever did.
DB_DIR="$(dirname "${TIM_DB_PATH:-${HOME}/.tim/tim.db}")"
mapfile -t BACKUPS < <(ls -1t "${DB_DIR}"/*.pre-compact-* 2>/dev/null || true)
if [[ "${#BACKUPS[@]}" -gt "${KEEP_BACKUPS}" ]]; then
  for stale in "${BACKUPS[@]:${KEEP_BACKUPS}}"; do
    log "pruning old backup ${stale}"
    rm -f -- "${stale}"
  done
fi

restart_mcp
trap - EXIT
log "done"
