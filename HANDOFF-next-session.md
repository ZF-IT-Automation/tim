# Handoff — next session

Written 2026-08-07 ~22:15 local. Repo `/home/bbbee/projects/tim`, branch
`claude/tim-hmem-analysis-xt5j59` (PR #11). Everything below is committed and pushed.

Read `VALIDATION-REPORT.md` section 7 for the full trail. This file is the short version.

---

## Your job: the Codex hook

Codex registers a TIM session node and then never writes anything into it. Not a broken
hook — **there is no Codex turn-end hook at all**, and TIM ships no installer for one.

Two parts, both required. The full task is in TIM at `P0063/Next Steps`, titled
"Codex exchange-logging hook + auto-configure it during TIM install when Codex is present".
Evidence is in `P0063/Bugs`, "Codex sessions register in TIM but never log exchanges".

**Part 1 — a hook that logs exchanges.** First establish whether Codex exposes a turn-end /
post-response hook event *at all*. Everything depends on that answer.

- If it does → build `tim hook codex-stop` mirroring `packages/tim-hooks/src/claude-stop.ts`.
  Reuse `SessionManager.logExchangeOnce`, the `ensureSessionForStop` pattern, the dedupe key.
  What differs is transcript parsing; Codex sessions live under `~/.codex/sessions/`, format
  unverified.
- If it does not → log from the MCP side. Codex's config already allow-lists
  `tim_session_start`, `tim_load_project`, `tim_read`, `tim_guard`, so the server sees
  traffic the hooks never will. `maybeSpawnSummarizer` is already wired at
  `tim-mcp/src/server.ts:1539`.

**Part 2 — TIM's installer must configure it automatically when Codex is present.**
`packages/tim-cli/src/claude-hooks-install.ts` is the only installer in the repo and covers
Claude Code alone. The `tim-session-start.sh` sitting in `~/.codex/hooks/` on this host was
put there by hand or by o9k, never by TIM — which is exactly why the gap went unnoticed.

- Detect Codex: `~/.codex/` present, or `codex` on `PATH`.
- **Merge** into `~/.codex/hooks.json`, never overwrite. o9k owns entries there
  (`o9k-core-session.sh`, `o9k-memory-session.sh`, `o9k-update-check.sh`,
  `o9k-memory-precompact.sh`). Clobbering them breaks o9k.
- Idempotent: re-running install must not duplicate entries.

### The evidence, briefly

`~/.codex/hooks.json` declares exactly two events:

```
SessionStart :: tim-session-start.sh, o9k-core-session.sh, o9k-memory-session.sh, o9k-update-check.sh
PreCompact   :: o9k-memory-precompact.sh
```

P0054 (MAIMO), worked through Codex right now, holds four session nodes from today, all
`exchange_count = 0`:

```
19:11:37  ex=0  impl_player_process   codex-player-process
17:01:49  ex=0  security_ops_review   codex-maimo-security
17:01:45  ex=0  test_quality_review   codex-20260807-test-
17:00:49  ex=0  Codex                 codex-P0054-20260807
```

This is break #5's phantom-node population at its source, and broader than `e69e997`'s
commit note assumed — not just the summarizer's sub-agent, *every* Codex session. It fits
118 of 215 nodes being empty. A project driven mainly through Codex accumulates shells and
has nothing to brief from.

---

## State of PR #11

The session-continuity chain works **for Claude Code**. Five breaks fixed
(`3d883f5`, `ac97aa1`, `4e83b50`, `e69e997`, plus `0deb23e`); the briefing render was
witnessed end to end this session, and recording ran unattended to `exchange_count: 3`.

Commits, newest first:

```
738e91e docs: P0054 is not idle — Codex is working it and logs nothing
e5c6096 docs: MAIMO's history is in hmem, and scope the P0054 claim to what was checked
c4b23c4 docs: retract the P0054 claim too — those hooks were hmem's, not TIM's
48570da docs: retract the /clear hypothesis, record what P0054 actually shows
eb16664 docs: record the session-continuity validation and the sixth break
e69e997 fix(store): skip empty sessions when listing resumable ones
4e83b50 fix(cli): spawn the summarizer when the Stop hook fills a batch
ac97aa1 fix(hooks,store): stop losing most of every recorded exchange
0deb23e fix(summarizer): stop plugin output from becoming the summary, and let the chain set effort
3d883f5 fix(hooks): read the transcript tail instead of bailing on size
```

Uncommitted and left alone on purpose: `HANDOFF.md` (older branch), two
`tsconfig.tsbuildinfo`.

Suite figure of `1533 passed, 2 skipped, 0 failed` is inherited from the previous session and
was not re-run today. Nothing but docs changed since.

---

## Also open

1. **Tail-read fix untested above 1 MiB.** `3d883f5` replaced the size guard with a tail
   read, but no live session has crossed a megabyte and kept logging. Genuine gap. P0054
   cannot be cited for it — its Claude Code transcripts predate TIM's hooks and ran hmem's.
2. **No `SessionEnd` hook, so a session's last partial batch is never summarized.**
   `claude-hooks-install.ts:69` registers SessionStart, UserPromptSubmit, Stop only. This
   misinforms rather than merely truncating: the brief delivered to *this* session was false
   in two of four bullets — reported work as uncommitted that was committed, named a next
   step already done. A successor that trusts its brief redoes finished work.
3. **One Stop does not fire**, on the first turn after `/clear`. Near-zero cost;
   `readLastExchange` lags a turn regardless. Noted so nobody rediscovers it as something
   larger — which is what happened here.
4. **118 phantom session nodes still in the database.** `e69e997` fixed the consumer side
   only; `tim_load_project`'s "Recent Sessions" render still lists `0 exchanges` nodes first.
5. **MAIMO's real history is in hmem**, not TIM — `~/.hmem/Agents/DEVELOPER/DEVELOPER.hmem`,
   57 MB, ~3 500 MAIMO references. Migration question, never answered. hmem stays read-only.
6. `tim doctor` crash repaired in data only; two code fixes outstanding (`store.ts:250-252`
   vs `store.ts:412-418`, and a per-project `try/catch` in `collectBindingReport`).
7. **Do not run `tim doctor --repair-schema`** on this database — see `TODO-session-continuity.md`.
8. `P0062` has two live project trees (184 and 1552 nodes). Needs a merge decision from Benni.
9. `tim_load_project(label="P0054", bind:false)` touched `~/projects/maimo-rpg/.tim-project`'s
   mtime. Content unchanged, but the bug "schreibt Marker auch bei bind:false" is marked done
   and this suggests otherwise.

---

## Method notes — this session published three wrong claims

All three failed identically: a confident conclusion from an aggregate, without reading the
record underneath. Two of them went into commits before being caught.

1. "Stop hook never fires after `/clear`" — measured during the very turn being measured, and
   `grep -c stop_hook_summary` also matched the assistant's own prose in the transcript: 21
   apparent hits, 2 real. Count `stop_hook_summary","hookCount"` instead.
2. "P0054 proves what the 1 MiB guard cost" — counted Stop-hook runs without reading which
   command they invoked. They were hmem's, not TIM's.
3. "P0054 has no sessions" — asked `listProjectSessionsByActivity`, which is precisely the
   function `e69e997` taught to hide `exchange_count = 0` nodes. Use
   `getChildByKindSync(sessionsRoot, 'session')` for raw children.

**When a query returns nothing, first confirm it can return anything.**

---

## Ground rules

- Never direct SQL on `~/.tim/tim.db` — TIM MCP tools or the store API only.
- Snapshot before touching the database. Existing: `~/.tim/snapshots/tim-20260807-1724.db`.
- `tsc -b` is incremental and cross-package imports go through `dist/`; on anything
  surprising run `npm run clean && npm run build` before believing a test result.
- Restart the MCP server after deploying — it loads `dist/` at process start.
- Report defects with `file:line` rather than fixing them silently; ask before committing.
