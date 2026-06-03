#!/usr/bin/env bash
# Back-compat wrapper — delegates to post-commit.sh
set -euo pipefail
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/post-commit.sh" "$@"
