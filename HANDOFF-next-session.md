# Handoff — next session

Written 2026-08-08 ~07:05 local. Repo `/home/bbbee/projects/tim`, branch
`claude/tim-hmem-analysis-xt5j59` (PR #11). Committed and pushed as `10778a6`.

The previous handoff asked for Cursor exchange logging. It is done, built, installed on
this host and verified against the live database. The full trail is in TIM under
`P0063/Next Steps` (the task node) and `P0063/Bugs`.

---

## Your job: keep working through the open task nodes

Benni's standing instruction: **"als nächstes arbeiten wir noch offene Task-Nodes ab"**.
Start with `tim_show what="tasks"` and work the list, highest priority first. The
session-continuity work (Claude, Codex, Cursor) is finished; what remains is a mixed bag.

Highest-priority open node right now:

**I6: task/bug body preview in project-output briefing** (`P0063/Tasks`, high). Not looked
at this session.

Also open and cheap, both raised by the harness work and both independent of everything
else:

- **`tim_session_start` accepts agent-invented session ids** (`P0063/Bugs`, medium). The
  cheapest partial fix is to reject an empty-string session id.
- **Codex skips untrusted hooks silently** (`P0063/Bugs`, medium). Whether this host's
  `~/.codex/hooks.json` carries persisted trust was never checked. Hypothesis, not a
  measurement.

---

## What shipped this session

`10778a6` — Cursor exchange logging, plus its installer.

Cursor turned out to be the opposite case to Codex. It has a proper hook system with a
real turn-end event; nothing was logged because of two defects on TIM's side, and the
second one hid the first:

1. `readLastExchange` recognized a record's role from `type` or `message.role`. Cursor
   writes the role at the **top level**, so every Cursor record was skipped.
2. The `tim hook claude-stop` CLI branch required `payload.cwd`, which Cursor never sends
   — it sends `workspace_roots` — so it returned before parsing anything.

Point 2 is not hypothetical. cursor-agent also loads Claude's hook config
(`~/.claude/settings.json` → `claudeUserHooks`, `Stop → stop`), so it has been invoking
`tim hook claude-stop` on this host all along and getting a silent no-op.

### Measured against cursor-agent 2026.08.04-aaa8809

The shipped "binary" is plain minified JavaScript under
`~/.local/share/cursor-agent/versions/<v>/` — greppable, so the full hook surface came out
of the bundle rather than out of `strings`. Everything below was then confirmed by running
it, with a throwaway workspace whose project-level `.cursor/hooks.json` dumped every
candidate payload to a file.

- **Interactive TUI:** `beforeSubmitPrompt` → `stop` → `afterAgentResponse`, per turn. When
  `stop` fires the transcript already contains that turn's user *and* assistant text —
  no one-turn lag of the kind the Claude logger has.
- **`cursor-agent -p`:** none of those fire at all. The only turn-end signal is
  `sessionEnd`, once per invocation, carrying the same `transcript_path`. `--continue`
  keeps the `conversation_id`, so consecutive `-p` runs append to one session node.
- Every payload carries `session_id` (= `conversation_id`), `transcript_path`,
  `workspace_roots`, `cursor_version`, `hook_event_name`. There is **no `cwd`**.
- Transcripts: `~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl`, records of
  `{"role":…,"message":{"content":[{"type":"text","text":…}]}}`, no per-record uuid,
  closed by `{"type":"turn_ended","status":…}`.
- Full event list: `beforeShellExecution, beforeMCPExecution, afterShellExecution,
  afterMCPExecution, beforeReadFile, afterFileEdit, beforeTabFileRead, afterTabFileEdit,
  stop, beforeSubmitPrompt, afterAgentResponse, afterAgentThought, sessionStart,
  sessionEnd, preCompact, subagentStart, subagentStop, preToolUse, postToolUse,
  postToolUseFailure, workspaceOpen`.

### The code

- `packages/tim-hooks/src/claude-stop.ts` — `messageRole` also accepts a top-level `role`
  (additive; Claude records never carry one). `runClaudeStop` takes an optional agent
  identity instead of hardcoding `claude` / `claude-code`.
- `packages/tim-cli/src/cli.ts` — one branch serves `hook claude-stop` and
  `hook cursor-stop`: workspace falls back to `workspace_roots[0]`, and the agent identity
  comes from the **payload** (`cursor_version` present → `agent=cursor, harness=cursor`).
  Deriving it from the payload rather than the command name is what stops the
  Claude-config invocation from stamping `harness=claude-code` on a Cursor session — the
  two hooks race, and either order now produces the same label.
- `packages/tim-cli/src/cursor-hooks-install.ts` — registers the same command on **both
  `stop` and `sessionEnd`**, covering the TUI and `-p` respectively; when a TUI session
  ends both fire on the same last turn and `logExchangeOnce` absorbs the second. Merges,
  never overwrites; matches session-start on script name; backs up; writes atomically;
  refuses invalid JSON; idempotent. Cursor's `hooks.json` is flat — event name to command
  list — unlike Claude's and Codex's matcher groups.
- Wired into `setup-agent.ts` under `host === 'cursor'`.

Suite: **1553 passed, 2 skipped, 0 failed.**

### Installed on this host, and live-verified

`installCursorHooks()` ran against the real `~/.cursor/hooks.json`. Backup:
`/tmp/claude-1000/-home-bbbee-projects-tim/4af8408b-.../scratchpad/cursor-hooks.json.pre-install`
plus the installer's own `.backup.<ts>` file.

- Added one entry to `stop` (after hmem's two) and a new `sessionEnd` array. The four o9k
  entries and hmem's hooks are untouched; `sessionStart` came out `unchanged` because the
  hand-placed `tim-session-start.sh` was recognized.

Live database, one real `cursor-agent -p` run in this repo:

```
2026-08-08T06:58:29 | harness=cursor | agent=cursor | ex=1 | id=5854b89f-1a19-4bc2-99ab-aa3f9a8c0aa8
```

**Same caveat as the Codex install:** the hook command points at `dist/cli.js` inside this
dev worktree on a feature branch. Correct for development, wrong after a global npm
install. Left consistent with the MCP and Codex installers rather than special-cased.

---

## Also open

New this session:

1. **`stop` is suppressed past `loop_limit`** (`skipHookDueToLoopLimit` in the bundle) —
   the same silent-skip class as Codex's trust gate. A very long agentic run can lose a
   turn; `sessionEnd` still catches the last one. Not filed as a bug, noted in the commit.
2. **`listProjectSessionsByActivity('P0001', 20)` returned 0 rows** on the isolated probe
   database while the session nodes were plainly present in the tree. Not investigated.
   It is the same listing that hides `exchange_count = 0`, so it may carry a second filter.

Carried over, unchanged:

3. **Codex skips untrusted hooks silently** (`P0063/Bugs`, medium) — never checked against
   this host's live `~/.codex/hooks.json`.
4. **`tim_session_start` accepts agent-invented session ids** (`P0063/Bugs`, medium).
5. **Tail-read fix untested above 1 MiB.** `3d883f5` replaced the size guard with a tail
   read; no live session has crossed a megabyte and kept logging.
6. **No `SessionEnd` hook for Claude Code**, so a session's last partial batch is never
   summarized. `claude-hooks-install.ts:69` registers SessionStart, UserPromptSubmit, Stop
   only. (Cursor now registers `sessionEnd`, but only as a turn-end logger, not a
   summarizer flush.)
7. **One Stop does not fire**, on the first turn after `/clear`.
8. **118 phantom session nodes still in the database.** `e69e997` fixed the consumer side
   only; `tim_load_project`'s "Recent Sessions" render still lists `0 exchanges` first.
9. **MAIMO's real history is in hmem**, not TIM — `~/.hmem/Agents/DEVELOPER/DEVELOPER.hmem`,
   57 MB, ~3 500 MAIMO references. Migration question, never answered. hmem stays read-only.
10. `tim doctor` crash repaired in data only; two code fixes outstanding (`store.ts:250-252`
    vs `store.ts:412-418`, and a per-project `try/catch` in `collectBindingReport`).
11. **Do not run `tim doctor --repair-schema`** on this database — see
    `TODO-session-continuity.md`.
12. `P0062` has two live project trees (184 and 1552 nodes). Needs a merge decision.
13. `tim_load_project(label="P0054", bind:false)` touched `~/projects/maimo-rpg/.tim-project`'s
    mtime, though the bug "schreibt Marker auch bei bind:false" is marked done.

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
- Reason from a run, not from a config — but note the inverse also paid off here: Cursor
  ships its CLI as readable JavaScript, and reading the bundle produced the complete event
  list in minutes. Read the source to form the hypothesis, then run it to confirm.
