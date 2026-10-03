#!/usr/bin/env bash
# The one-command installer as `curl | bash` runs it, a rerun as update, and a run from a checkout.
set -uo pipefail
step() { echo; echo "######## $*"; }
mkdir -p ~/.claude ~/.codex ~/bin
printf '#!/bin/sh\necho stub\n' > ~/bin/claude && chmod +x ~/bin/claude   # detected, never called
export PATH="$HOME/bin:$PATH" TIM_REPO=/src TIM_REF="$REF"
step "virgin install (piped)"
git -C /src show "$REF:scripts/install.sh" | bash; echo "install exit=$?"
[ -x ~/.local/bin/tim ] && echo "[OK ] tim linked" || echo "[BAD] tim not linked"
grep -q '"cli": "claude"' ~/.tim/config.json && echo "[OK ] summarizer chain claude/haiku" || echo "[BAD] no summarizer chain"
mkdir -p ~/demo && (cd ~/demo && git init -q) && ~/.local/bin/tim new-project --path ~/demo --name Demo >/dev/null
python3 /sb/hooks-check.py claude; python3 /sb/hooks-check.py codex
cp ~/.claude/settings.json ~/s1.json; cp ~/.codex/hooks.json ~/h1.json
step "rerun = update"
git -C /src show "$REF:scripts/install.sh" | bash >/dev/null; echo "install exit=$?"
cmp -s ~/s1.json ~/.claude/settings.json && cmp -s ~/h1.json ~/.codex/hooks.json && echo "[OK ] host configs unchanged" || echo "[BAD] rerun changed host configs"
step "run from another checkout: hooks and link move to it"
git clone -q /src ~/co && git -C ~/co checkout -q "$REF" && ~/co/scripts/install.sh >/dev/null; echo "install exit=$?"
[ "$(grep -c "/home/node/co/packages/tim-cli/dist/cli.js' hook" ~/.claude/settings.json)" = 4 ] && echo "[OK ] 4 claude hooks repointed" || echo "[BAD] claude hooks not repointed"
[ "$(grep -c "' hook " ~/.claude/settings.json)" = 4 ] && echo "[OK ] no duplicate hooks" || echo "[BAD] duplicate hooks"
[ "$(readlink ~/.local/bin/tim)" = /home/node/co/packages/tim-cli/dist/cli.js ] && echo "[OK ] link repointed" || echo "[BAD] link stale"
python3 /sb/hooks-check.py claude
grep -q '/home/node/co/packages/tim-cli/dist/cli.js' ~/.codex/hooks.json && ! grep -q 'share/tim' ~/.codex/hooks.json && echo "[OK ] codex session-start repointed" || echo "[BAD] codex session-start stale"
grep '^notify' ~/.codex/config.toml | grep -q '/home/node/co/' && echo "[OK ] codex notify repointed" || echo "[BAD] codex notify stale"
python3 /sb/hooks-check.py codex
