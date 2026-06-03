# Hermes status bar (TIM)

Hermes has **no** Claude-style `statusLine` in `settings.json`. Persistent project/batch info uses the **Hermes CLI TUI status bar**, which calls a hook script on refresh.

## Mechanism

| Piece | Role |
|-------|------|
| `tim-hermes-session-cache.sh` | `pre_llm_call` — writes `~/.tim/.session-cache` (`session_id`, `cwd`). Returns `{}`. |
| `tim-hermes-statusline.sh` | Called by patched Hermes `cli.py` — prints JSON: `{device, project, o_node, counter}` |
| `hermes-cli-tim-statusline.patch` | Reference only — install uses programmatic `cli.py` patch (line drift safe) |
| `tim statusline --format hermes` | Core formatter (used by the shell script) |

`pre_llm_call` **`context`** injection is for turn prompts (see `tim-session-start.sh`), not the status bar.

## Install (one command)

```bash
cd ~/projects/tim && npx tsc -b   # once, if developing from source
node packages/tim-cli/dist/cli.js setup-hermes-statusline
# or after npm link -g:  tim setup-hermes-statusline
```

Idempotent: safe to re-run. Options: `--dry-run`, `--skip-build`, env `HERMES_AGENT_DIR`.

Manual steps (what the command does):

1. Symlink `tim-hermes-*.sh` → `~/.hermes/agent-hooks/`
2. Insert `tim-hermes-session-cache.sh` into `~/.hermes/config.yaml` `pre_llm_call` (after `o9k-startup.sh`)
3. Patch `~/.hermes/hermes-agent/cli.py` (`_get_tim_status` + status-bar fragments)
4. `npx tsc -b` when run from TIM monorepo

## Verify

```bash
# JSON for status bar
bash packages/tim-hooks/scripts/tim-hermes-statusline.sh | jq .

# Text line (debug)
node packages/tim-cli/dist/cli.js statusline --cwd ~/projects/tim
```

Restart Hermes after patching `cli.py`.

## Claude Code

Do **not** use `statusLine` in `~/.claude/settings.json` for TIM — that is Claude-only. Use this Hermes path instead.
