#!/usr/bin/env bash
# Manual source install into a path with a space; every host's hooks run without node/tim on PATH.
set -uo pipefail
step() { echo; echo "######## $*"; }
DEST="$HOME/my tools/tim"
step "clone $REF + npm ci"
mkdir -p "$HOME/my tools" && git clone -q /src "$DEST" && git -C "$DEST" checkout -q "$REF"
(cd "$DEST" && npm ci --no-audit --no-fund >/dev/null 2>&1); echo "npm ci exit=$?"
tim() { node "$DEST/packages/tim-cli/dist/cli.js" "$@"; }
step "init + new-project"
tim init >/dev/null; echo "init exit=$?"
mkdir -p ~/demo && (cd ~/demo && git init -q)
tim new-project --path ~/demo --name "Demo Project" >/dev/null; echo "new-project exit=$?"
for h in claude codex cursor; do
  step "setup-agent $h + its hooks"
  tim setup-agent --host $h >/dev/null; echo "setup-agent exit=$?"
  python3 /sb/hooks-check.py $h
done
step "setup-agent claude again is a no-op"
tim setup-agent --host claude | grep -q '"status": "unchanged"' && echo "[OK ] rerun unchanged" || echo "[BAD] rerun changed settings"
step "MCP smoke"
cp /sb/mcp-smoke.mjs "$DEST/smoke.mjs" && node "$DEST/smoke.mjs"
step "doctor sees the hook-logged exchanges"
tim doctor | grep -E "Memory exchanges" | grep -qE "[1-9][0-9]* observed" && echo "[OK ] exchanges observed" || echo "[BAD] no exchanges observed"
tim doctor | grep -qE "✓ [0-9]+ TIM hook\(s\) can start" && echo "[OK ] doctor: hooks can start" || echo "[BAD] doctor flags hooks"
