# Handoff — next session

Written 2026-08-08 ~08:35 local. Repo `/home/bbbee/projects/tim`, branch
`claude/tim-hmem-analysis-xt5j59` (PR #11). Everything below is committed and pushed;
the head at handoff time is `1897910` plus the doc commit that carries this file.

Two things happened this session: the Cursor exchange logger was finished and installed,
and the open backlog was audited node by node against the code. The audit turned up
something that matters more than any single task — see P1 below.

---

## Your job: work the prio queue

**`P0063/Next Steps` → "Prio-Queue 2026-08-08 — abgearbeitet in dieser Reihenfolge"**
(`ubun-0808-ns-01KZG7ZFQG4FHBSMFJZ053CFY0`). Eighteen items, ordered, each naming the node
to update and what "done" means. Read it first; it is the authoritative ordering and this
file only summarizes it.

Benni's instruction closing this session: build the queue, hand off, let a fresh session
continue. So the queue is deliberately unstarted — **nothing in it has been implemented.**

### The first item, because it changes how you read everything else

**`resolveEntryTaskStatus` ignores legacy `metadata.status`** (`P0063/Bugs`,
`ubun-0808-ns-01KZG67D82AHKNBH9BDES9DFK2`, high).

`packages/tim-mcp/src/task-status.ts:6` reads only `metadata.task.status` and returns
`'todo'` for anything else. Task metadata exists in two shapes here — the canonical
`metadata.task = {status, priority, history}` and a legacy `metadata.task = true` plus
top-level `metadata.status`. `isTaskMarker` accepts both, so legacy entries get *listed*
as tasks while their status is discarded.

Measured: of the 19 nodes `tim_show` reported open in `P0063/Tasks`, **six are finished
work** carrying `metadata.status: "done"` and a `completion_evidence` string naming the
merge commit — Plan 3, Plan 12B, Plan 12 C–F, the migration guard, Framework Health, and
the Tasks/Next-Steps refactor. Four of those six were verified against the code
independently of their own claim, so this is not self-reported completion taken on trust.

Recommended fix is the reader fallback (~4 lines, no write to the live database). Benni
was offered that versus a data migration and has not picked; the bug node lays out both.

**Read this as a warning about method, not just a bug:** a backlog item saying "TODO" is
not evidence that the work is undone. Every item in the queue was re-checked against the
code for exactly this reason, and the findings are recorded per item.

---

## What shipped this session

### `10778a6` — Cursor exchange logging, plus its installer

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

**Measured against cursor-agent 2026.08.04-aaa8809.** The shipped "binary" is plain
minified JavaScript under `~/.local/share/cursor-agent/versions/<v>/` — greppable, so the
full hook surface came out of the bundle. Everything below was then confirmed by running
it, with a throwaway workspace whose project-level `.cursor/hooks.json` dumped every
candidate payload to a file.

- **Interactive TUI:** `beforeSubmitPrompt` → `stop` → `afterAgentResponse`, per turn.
  When `stop` fires the transcript already contains that turn's user *and* assistant text
  — no one-turn lag of the kind the Claude logger has.
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

**The code:**

- `packages/tim-hooks/src/claude-stop.ts` — `messageRole` also accepts a top-level `role`.
  `runClaudeStop` takes an optional agent identity instead of hardcoding claude.
- `packages/tim-cli/src/cli.ts` — one branch serves `hook claude-stop` and
  `hook cursor-stop`: workspace falls back to `workspace_roots[0]`, agent identity comes
  from the **payload** (`cursor_version` present → `agent=cursor, harness=cursor`).
  Deriving it from the payload rather than the command name is what stops the
  Claude-config invocation from stamping `harness=claude-code` on a Cursor session.
- `packages/tim-cli/src/cursor-hooks-install.ts` — registers the same command on **both
  `stop` and `sessionEnd`**, covering the TUI and `-p`. Merges, never overwrites; matches
  session-start on script name; backs up; writes atomically; refuses invalid JSON.
- Wired into `setup-agent.ts` under `host === 'cursor'`.

Suite: **1553 passed, 2 skipped, 0 failed.**

Two claims behind that code were checked against reality rather than fixtures, because
both touch the Claude path that already works:

- *"Claude records never carry a top-level `role`"* — scanned all 1 446 transcripts under
  `~/.claude/projects/`: **0 records reach the new branch.** Additive confirmed.
- *"the dedupe absorbs the second fire"* — on this host both hooks fire on the same TUI
  turn, so they race as two processes. `logExchangeOnce` does its existence check and its
  insert inside `store.runExclusive`, which is `db.transaction(fn).exclusive()` — a SQLite
  `BEGIN EXCLUSIVE` — so they serialize across processes and the loser sees the row.

**Installed on this host, and live-verified.** `installCursorHooks()` ran against the real
`~/.cursor/hooks.json`. Backup at
`/tmp/claude-1000/-home-bbbee-projects-tim/4af8408b-.../scratchpad/cursor-hooks.json.pre-install`
plus the installer's own `.backup.<ts>`. One entry appended to `stop`, a new `sessionEnd`
array; hmem's hooks and the four o9k entries untouched, `sessionStart` `unchanged`.

```
2026-08-08T06:58:29 | harness=cursor | agent=cursor | ex=1 | id=5854b89f-1a19-4bc2-99ab-aa3f9a8c0aa8
```

**Same caveat as the Codex install:** the hook command points at `dist/cli.js` inside this
dev worktree on a feature branch. Correct for development, wrong after a global npm
install. Left consistent with the MCP and Codex installers rather than special-cased.

### Backlog audit — every open node checked against the code

Closed as already-done (verified, not assumed):

- **I6: task/bug body preview** — shipped 2026-07-25 in `59e4640`, which is on `master`.
  `entryBodyPreview` at `project-output.ts:221`, three tests labelled `(I6)`, cold-eval
  8/10 recorded in `P0063/Log`. The node was simply never flipped.
- **TIM DB Size Audit** — body header said `STATUS: CANCELLED 2026-06-15`.
- **`tim_load_project` sections-filter matches wrong node** — body said RESOLVED via
  `feaa093`; metadata said done; only the renderer disagreed.

Premises found stale on nodes that stay open (do not start these without re-scoping):

- **Summarizer Quality Follow-Up** — "no automatic summarization loop" is false,
  `maybeSpawnSummarizer` hangs off all three turn-end hooks. "FTS5 breaks on
  summary/kind/task" is also false; searching those words returns results. What remains
  is project-summary regeneration being manual.
- **Framework Health & Error Logging** — requirements 1–3 and 5 are built
  (`error-log.ts`, 30-day retention, `tim_error_log`/`tim_error_stats`, a `summarizer.log`
  migration). Only requirement 4, error statistics in `tim_doctor`, is missing.
- **hmem-vs-TIM Phase A** — its item #1 already exists as `duplicate_suspected`.

Confirmed genuinely open, with the code checked today: sync-server proxy trust
(`server.ts:60` still reads `x-forwarded-for` unconditionally), blob compaction (absent
from `storage.ts`), secret-node tag leakage (`encryptSecretPayload` never touches `tags`),
`tim_write_many` (absent from the 50 registered MCP tools), the graphify pipeline (no
`scripts/graphify-tim.sh`), and the ONNX history (9 `local_cache` objects still reachable,
pack 111.77 MiB).

---

## Also open, not in the queue

- **`stop` is suppressed past `loop_limit`** (`skipHookDueToLoopLimit` in the cursor-agent
  bundle) — same silent-skip class as Codex's trust gate. A very long agentic run can lose
  a turn; `sessionEnd` still catches the last one. Noted in the commit, not filed.
- **`listProjectSessionsByActivity('P0001', 20)` returned 0 rows** on the isolated probe
  database while the session nodes were plainly present in the tree. Not investigated.
- **118 phantom session nodes** still in the database; consumer side fixed in `e69e997`.
- **MAIMO's real history is in hmem** — `~/.hmem/Agents/DEVELOPER/DEVELOPER.hmem`, 57 MB,
  ~3 500 MAIMO references. Migration question, never answered. hmem stays read-only.
- **`tim doctor` crash** repaired in data only; two code fixes outstanding
  (`store.ts:250-252` vs `store.ts:412-418`, and a per-project `try/catch` in
  `collectBindingReport`).
- **Do not run `tim doctor --repair-schema`** on this database — see
  `TODO-session-continuity.md`.
- **`P0062` has two live project trees** (184 and 1552 nodes). Needs a merge decision.

---

## Ground rules

- Never direct SQL on `~/.tim/tim.db` — TIM MCP tools or the store API only.
- Snapshot before touching the database. Existing: `~/.tim/snapshots/tim-20260807-1724.db`.
- `tsc -b` is incremental and cross-package imports go through `dist/`; on anything
  surprising run `npm run clean && npm run build` before believing a test result.
- `dist/` is in `.gitignore` but parts of it are tracked from before that rule. Staging new
  build output needs `git add -f`; `tsconfig.tsbuildinfo` stays out.
- Restart the MCP server after deploying — it loads `dist/` at process start.
- Report defects with `file:line` rather than fixing them silently; ask before committing.
- When a query returns nothing, first confirm it can return anything.
- Reason from a run, not from a config — and note the inverse, earned on Cursor: it ships
  its CLI as readable JavaScript, and reading the bundle produced the complete event list
  in minutes. Read the source to form the hypothesis, then run it to confirm.
- **A node saying TODO is not evidence that the work is undone.** Check the code first;
  six of nineteen were already finished.
