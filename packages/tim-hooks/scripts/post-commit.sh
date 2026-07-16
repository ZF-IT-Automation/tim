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

SCRIPT_PATH="${BASH_SOURCE[0]}"
while [[ -L "$SCRIPT_PATH" ]]; do
  SCRIPT_LINK_DIR="$(cd -P "$(dirname "$SCRIPT_PATH")" && pwd)"
  SCRIPT_PATH="$(readlink "$SCRIPT_PATH")"
  [[ "$SCRIPT_PATH" == /* ]] || SCRIPT_PATH="$SCRIPT_LINK_DIR/$SCRIPT_PATH"
done
SCRIPT_DIR="$(cd -P "$(dirname "$SCRIPT_PATH")" && pwd)"
unset SCRIPT_PATH SCRIPT_LINK_DIR
# shellcheck source=lib/resolve-tim-cli.sh
source "$SCRIPT_DIR/lib/resolve-tim-cli.sh"

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
[[ -z "$repo_root" ]] && exit 0

run_tim_cli record-commit --cwd "$repo_root" >/dev/null 2>&1 || true
exit 0
