#!/bin/bash
# Controlled TIM error_log compaction after a write-storm (2026-09-03).
#
# Unattended maintenance must never stop MCP servers: a host-owned stdio
# connection cannot be restored by starting an HTTP daemon. Defer while any
# MCP server is alive. The CLI checks writers again under its maintenance lock
# before rebuilding error_log to the newest 10_000 rows and optionally VACUUMing.
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

CLI="${ROOT}/packages/tim-cli/dist/cli.js"
NODE_BIN="${TIM_NODE:-$(command -v node || true)}"
TIMEOUT_SEC="${TIM_COMPACT_TIMEOUT_SEC:-900}"
KEEP_BACKUPS="${TIM_COMPACT_KEEP_BACKUPS:-2}"
# Only one compaction at a time.
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

if [[ ! -f "${CLI}" ]]; then
  fail "missing ${CLI} — run npm run build (or set TIM_ROOT)"
  exit 1
fi

# A cheap, conservative preflight avoids interrupting an active session.
# Never infer "no writers" from a failed process scan. The CLI's stricter
# /proc-based writer check remains authoritative if a process starts meanwhile.
pgrep_rc=0
pids=$(pgrep -f 'tim-mcp.*dist/server\.js') || pgrep_rc=$?
if [[ "${pgrep_rc}" -eq 0 ]]; then
  log "SKIP: MCP processes are still running (PIDs: ${pids//$'\n'/ }); retry at the next scheduled run"
  exit 0
fi
if [[ "${pgrep_rc}" -ne 1 ]]; then
  fail "pgrep failed (rc=${pgrep_rc}) — refusing to compact without writer discovery"
  exit 1
fi

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

log "done"
