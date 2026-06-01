#!/usr/bin/env bash
# tim-post-commit.sh — Git post-commit hook: auto-record commit to TIM Commits section.
#
# Resolves nearest .tim-project (walk-up), reads HEAD commit (SHA, message, --stat),
# calls `tim record-commit`. Silent skip when no marker or not a git repo.
#
# Install: cp/symlink to .git/hooks/post-commit or set core.hooksPath to scripts/git-hooks.
# Requires: git, node. Override CLI with TIM_CLI.
set -euo pipefail

TIM_CLI="${TIM_CLI:-/home/bbbee/projects/tim/packages/tim-cli/dist/cli.js}"

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "$repo_root" ]]; then exit 0; fi

node "$TIM_CLI" record-commit --cwd "$repo_root" >/dev/null 2>&1 || true
exit 0
