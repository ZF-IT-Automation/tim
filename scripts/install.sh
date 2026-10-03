#!/usr/bin/env bash
# TIM installer — install or update in one command, safe to rerun.
#
#   curl -fsSL https://raw.githubusercontent.com/ZF-IT-Automation/tim/master/scripts/install.sh | bash
#   ./scripts/install.sh            # from a checkout: builds and connects that checkout
#
# Clones (or fast-forwards) TIM, builds it, links `tim` into ~/.local/bin, creates
# the database, and connects every agent host it finds (Claude Code, Codex,
# Cursor). Rerunning updates the checkout and repairs hook/MCP paths in place.
#
# Env: TIM_INSTALL_DIR (default ~/.local/share/tim, or the checkout this script
# lives in), TIM_REPO, TIM_REF (default master), TIM_BIN_DIR (default ~/.local/bin),
# TIM_HOSTS ("claude codex cursor" to force a list, "none" to skip).
set -euo pipefail

say() { printf '%s\n' "$*"; }
die() { printf 'tim install: %s\n' "$*" >&2; exit 1; }

for cmd in git node npm; do
  command -v "$cmd" >/dev/null 2>&1 || die "$cmd is required (Node.js 22+ with npm, and git)"
done
node_major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$node_major" -ge 22 ] || die "Node.js 22+ required, found $(node --version)"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]:-.}")" 2>/dev/null && pwd || true)"
if [ -z "${TIM_INSTALL_DIR:-}" ] && [ -f "$script_dir/../packages/tim-cli/package.json" ]; then
  TIM_INSTALL_DIR="$(cd "$script_dir/.." && pwd)"
  in_checkout=1
fi
dir="${TIM_INSTALL_DIR:-$HOME/.local/share/tim}"
repo="${TIM_REPO:-https://github.com/ZF-IT-Automation/tim.git}"
ref="${TIM_REF:-master}"
bin_dir="${TIM_BIN_DIR:-$HOME/.local/bin}"

if [ -n "${in_checkout:-}" ]; then
  say "→ Using checkout $dir"
elif [ -d "$dir/.git" ]; then
  say "→ Updating $dir ($ref)"
  git -C "$dir" fetch --quiet origin "$ref"
  git -C "$dir" checkout --quiet "$ref"
  git -C "$dir" merge --quiet --ff-only "origin/$ref" \
    || die "$dir has local changes or diverged from origin/$ref — resolve them, then rerun"
else
  say "→ Cloning $repo ($ref) into $dir"
  mkdir -p "$(dirname "$dir")"
  git clone --quiet --branch "$ref" "$repo" "$dir"
fi

say "→ Installing dependencies and building (npm ci)"
(cd "$dir" && npm ci --no-audit --no-fund --loglevel=error) || die "npm ci failed in $dir"

cli="$dir/packages/tim-cli/dist/cli.js"
[ -f "$cli" ] || die "build did not produce $cli"
mkdir -p "$bin_dir"
ln -sfn "$cli" "$bin_dir/tim"
say "✓ tim → $bin_dir/tim ($(node "$cli" --version))"

tim() { node "$cli" "$@"; }
tim init

hosts="${TIM_HOSTS:-}"
if [ -z "$hosts" ]; then
  { command -v claude >/dev/null 2>&1 || [ -d "$HOME/.claude" ]; } && hosts="$hosts claude"
  { command -v codex >/dev/null 2>&1 || [ -d "${CODEX_HOME:-$HOME/.codex}" ]; } && hosts="$hosts codex"
  { command -v cursor-agent >/dev/null 2>&1 || [ -d "$HOME/.cursor" ]; } && hosts="$hosts cursor"
fi
[ "$hosts" = "none" ] && hosts=""
for host in $hosts; do
  if tim setup-agent --host "$host" >/dev/null; then
    say "✓ Connected $host (MCP, skills, hooks) — restart it to pick TIM up"
  else
    say "⚠ setup-agent --host $host failed — rerun it by hand to see why"
  fi
done
[ -n "${hosts// /}" ] || say "⚠ No agent host found — connect one later: tim setup-agent --host claude|codex|cursor"

case ":$PATH:" in
  *":$bin_dir:"*) ;;
  *) say "⚠ $bin_dir is not on PATH — add it to use \`tim\` in your shell (agent hooks do not need it)" ;;
esac
say ""
say "Next: cd into a repository and run  tim new-project --path \"\$PWD\" --name \"My Project\""
say "Check health any time with  tim doctor"
