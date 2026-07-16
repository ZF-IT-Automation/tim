#!/usr/bin/env bash
# Back-compat wrapper — delegates to post-commit.sh
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
# shellcheck source=lib/resolve-tim-cli.sh
source "$SCRIPT_DIR/lib/resolve-tim-cli.sh"
exec "$TIM_HOOKS_SCRIPTS_DIR/post-commit.sh" "$@"
