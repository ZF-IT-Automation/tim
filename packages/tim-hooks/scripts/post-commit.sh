#!/usr/bin/env bash
# post-commit.sh — Global git post-commit: record commit to TIM Commits section.
#
# Walk-up .tim-project via `tim record-commit`. Silent skip when no marker.
# Must not fail the commit (errors swallowed).
#
# Install:
#   mkdir -p ~/.hermes/git-hooks
#   ln -sf ~/projects/tim/packages/tim-hooks/scripts/post-commit.sh ~/.hermes/git-hooks/post-commit
#   git config --global core.hooksPath ~/.hermes/git-hooks
#
# Requires: git, node. Override CLI with TIM_CLI.
set -euo pipefail

resolve_tim_cli() {
  if [[ -n "${TIM_CLI:-}" ]]; then
    printf '%s\n' "$TIM_CLI"
    return 0
  fi
  if command -v tim >/dev/null 2>&1; then
    command -v tim
    return 0
  fi
  local hook_dir dev_cli
  local real_script
  real_script="$(readlink -f "${BASH_SOURCE[0]}")"
  hook_dir="$(dirname "$real_script")"
  dev_cli="$hook_dir/../../tim-cli/dist/cli.js"
  if [[ -f "$dev_cli" ]]; then
    printf '%s\n' "$dev_cli"
    return 0
  fi
  return 1
}

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
[[ -z "$repo_root" ]] && exit 0

tim_cli="$(resolve_tim_cli)" || exit 0

run_record() {
  if [[ "$tim_cli" == *.js ]]; then
    node "$tim_cli" record-commit --cwd "$repo_root"
  else
    "$tim_cli" record-commit --cwd "$repo_root"
  fi
}

run_record >/dev/null 2>&1 || true
exit 0
