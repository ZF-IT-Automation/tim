#!/usr/bin/env bash
# Shared TIM CLI discovery for hook entrypoints.

TIM_HOOKS_SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

resolve_tim_cli() {
  if [[ -n "${TIM_CLI:-}" ]]; then
    printf '%s\n' "$TIM_CLI"
    return 0
  fi

  if command -v tim >/dev/null 2>&1; then
    command -v tim
    return 0
  fi

  local candidate="${TIM_HOOKS_SCRIPTS_DIR}/../../tim-cli/dist/cli.js"
  [[ -f "$candidate" ]] || return 1
  printf '%s\n' "$candidate"
}

run_tim_cli() {
  local tim_cli
  tim_cli="$(resolve_tim_cli)" || return 1
  if [[ "$tim_cli" == *.js ]]; then
    node "$tim_cli" "$@"
  else
    "$tim_cli" "$@"
  fi
}
