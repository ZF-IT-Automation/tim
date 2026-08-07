# Handoff — next session

Written 2026-08-07 ~22:50 local. Repo `/home/bbbee/projects/tim`, branch
`claude/tim-hmem-analysis-xt5j59` (PR #11). Committed as `7e2b138`, not yet pushed.

The previous handoff asked for the Codex hook. It is done, built, installed on this host
and verified against the live database. This file is the short version; the full trail is
in TIM under `P0063/Bugs` and `P0063/Next Steps`.

---

## Your job: work through the open task nodes

Benni's instruction at the end of the last session: **"als nächstes arbeiten wir noch offene
Task-Nodes ab"**. So this is not a single-topic session. Start with `tim_show kind="tasks"`
and work the list, highest priority first.

The one that should go first, because it is where the active work actually happens:

**Cursor exchange logging** (`P0063/Next Steps`, high). Benni moved MAIMO (P0054) off Codex
onto Cursor mid-session. Cursor session nodes show the same signature Codex did — registered,
then empty:

```
2026-06-17  ex=0  cursor-agent  44111352-9ccc-4655-bf36-365fd987ff41
2026-07-16  ex=0  cursor        fix-open-issues-8-11
2026-07-17  ex=0  cursor        cursor-tim-2026-07-17-push-check
```

The first has a real UUID, so something on the Cursor side does hand over a harness session
id — a different starting point from Codex, where every id was invented by the agent.

The task node carries the probe recipe. Read it before designing anything.

### What the Codex work taught, and Cursor should reuse

The method mattered more than the code. Both wrong turns in that investigation came from
reasoning about configuration instead of running the thing:

1. **Do not conclude an event does not exist from config or `strings` alone.** The binary
   listed no turn-end hook — true — but `notify` in `config.toml` is a turn-end callback
   outside the hook system entirely, and that is what ended up working.
2. **Do not conclude an event cannot fire because a probe saw nothing.** Codex silently
   skipped every hook until trust was granted. Zero invocations from a valid config looked
   exactly like "this harness has no hooks".
3. **Probe with a throwaway home** (`CODEX_HOME=<tmp>`, copy `auth.json`) and dump every
   candidate event's payload to a file. Four small `codex exec` runs settled everything.

Reusable pieces: `ensureHookSession` (`packages/tim-hooks/src/hook-session.ts`),
`SessionManager.logExchangeOnce`, `afterExchangeLogged`. `codex-notify.ts` is the smaller of
the two logger templates — payload already contains the exchange, no transcript parsing.
`codex-hooks-install.ts` is the installer shape: never overwrite a config another tool owns,
be idempotent, and say out loud what the user still has to do by hand.

---

## What shipped this session

`7e2b138` — Codex exchange logging via `notify`, plus its installer.

- `packages/tim-hooks/src/codex-notify.ts` — `runCodexNotify`, `parseCodexNotifyArgs`.
  Session keyed on `thread-id`, dedupe on `sha256(thread-id \0 turn-id)`.
- `packages/tim-hooks/src/hook-session.ts` — `ensureHookSession`, lifted out of
  `claude-stop.ts` and parameterized by agent/harness. Both loggers use it.
- `packages/tim-cli/src/cli.ts` — `tim hook codex-notify`; payload read from the **last**
  argv element, because `notify` appends it there.
- `packages/tim-cli/src/codex-hooks-install.ts` — wired into `setup-agent.ts` under
  `host === 'codex'`.

Findings behind it, all measured against Codex 0.147.0:

- **No turn-end hook event exists.** Full surface: `pre_tool_use, permission_request,
  post_tool_use, pre_compact, post_compact, session_start, session_end, user_prompt_submit,
  subagent_start, subagent_stop`.
- **Hooks are skipped silently without persisted trust.** Two `codex exec` runs with a valid
  `hooks.json` produced zero invocations; `--dangerously-bypass-hook-trust` made SessionStart,
  UserPromptSubmit and SessionEnd fire immediately.
- **`notify` fires at turn end, needs no trust, works under `codex exec`**, and carries
  `thread-id`, `turn-id`, `cwd`, `input-messages`, `last-assistant-message`.
- `input-messages` holds only the human's prompt — Codex's `<recommended_plugins>` injection
  shows up in the rollout transcript but never in that field.

Suite: **1546 passed, 2 skipped, 0 failed**, re-run after the final change.

### Installed on this host

`installCodexHooks()` was run against the live `~/.codex/`. Backups in
`/tmp/claude-1000/-home-bbbee-projects-tim/9f310419-.../scratchpad/codex-backup/` plus the
installer's own `.backup.<ts>` files.

- `config.toml`: one line added at the top, nothing else touched.

  ```
  notify = ["/home/bbbee/.nvm/versions/node/v24.14.0/bin/node",
            "/home/bbbee/projects/tim/packages/tim-cli/dist/cli.js", "hook", "codex-notify"]
  ```

- `hooks.json`: **byte-identical** — the hand-placed `tim-session-start.sh` was recognized,
  the four o9k entries untouched.

Live verification, real database:

```
2026-08-07T20:45:16 | harness=codex | agent=codex | ex=1 | id=019fddf8-e249-72a2-8a43-71607892dd73
2026-08-07T20:17:30 | harness=codex | agent=Codex | ex=0 | id=codex-2026-08-07
```

**Caveat worth carrying:** that `notify` path points into this dev worktree on a feature
branch. Correct for development, wrong after a global npm install. Same tradeoff the MCP
installer already makes, so it was left consistent rather than special-cased — but if TIM
ever ships as a global package, this is the line that breaks.

---

## Also open

New this session:

1. **Codex skips untrusted hooks silently** (`P0063/Bugs`, medium). Whether the live
   `~/.codex/hooks.json` carries persisted trust was never checked. If it does not, the TIM
   session-start briefing has never fired for a single Codex session on this host, and
   neither have the three o9k hooks. Hypothesis, not a measurement — check before repeating.
2. **`tim_session_start` accepts agent-invented session ids** (`P0063/Bugs`, medium). Ids
   like `codex-2026-08-07`, `batch-1`, and one that is the empty string. A turn-end hook keys
   on the harness id, so it registers a *second* node beside the agent's. Accepted knowingly
   for Codex; it means fixing a logger holds the phantom count steady rather than reducing it.
   Cheapest partial fix, independent of the rest: reject an empty-string session id.

Carried over, unchanged:

3. **Tail-read fix untested above 1 MiB.** `3d883f5` replaced the size guard with a tail read;
   no live session has crossed a megabyte and kept logging.
4. **No `SessionEnd` hook, so a session's last partial batch is never summarized.**
   `claude-hooks-install.ts:69` registers SessionStart, UserPromptSubmit, Stop only. This
   misinforms rather than merely truncating — a successor that trusts its brief redoes
   finished work.
5. **One Stop does not fire**, on the first turn after `/clear`. Near-zero cost;
   `readLastExchange` lags a turn regardless.
6. **118 phantom session nodes still in the database.** `e69e997` fixed the consumer side only;
   `tim_load_project`'s "Recent Sessions" render still lists `0 exchanges` nodes first.
7. **MAIMO's real history is in hmem**, not TIM — `~/.hmem/Agents/DEVELOPER/DEVELOPER.hmem`,
   57 MB, ~3 500 MAIMO references. Migration question, never answered. hmem stays read-only.
8. `tim doctor` crash repaired in data only; two code fixes outstanding (`store.ts:250-252`
   vs `store.ts:412-418`, and a per-project `try/catch` in `collectBindingReport`).
9. **Do not run `tim doctor --repair-schema`** on this database — see `TODO-session-continuity.md`.
10. `P0062` has two live project trees (184 and 1552 nodes). Needs a merge decision from Benni.
11. `tim_load_project(label="P0054", bind:false)` touched `~/projects/maimo-rpg/.tim-project`'s
    mtime. Content unchanged, but the bug "schreibt Marker auch bei bind:false" is marked done
    and this suggests otherwise.

---

## Ground rules

- Never direct SQL on `~/.tim/tim.db` — TIM MCP tools or the store API only.
- Snapshot before touching the database. Existing: `~/.tim/snapshots/tim-20260807-1724.db`.
- `tsc -b` is incremental and cross-package imports go through `dist/`; on anything
  surprising run `npm run clean && npm run build` before believing a test result.
- `dist/` is in `.gitignore` but parts of it are tracked from before that rule. Staging new
  build output needs `git add -f`; `tsconfig.tsbuildinfo` stays out, matching earlier commits.
- Restart the MCP server after deploying — it loads `dist/` at process start.
- Report defects with `file:line` rather than fixing them silently; ask before committing.
- When a query returns nothing, first confirm it can return anything.
