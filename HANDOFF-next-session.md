# Handoff — next session

Written 2026-08-08 ~14:10 local. Repo `/home/bbbee/projects/tim`, branch
`claude/tim-hmem-analysis-xt5j59` (PR #11). Head at handoff time: `aa5a70b` plus the doc commit
carrying this file. Suite: **1580 passed, 2 skipped, 0 failed.**

This session shipped two things and handed three to you. Benni approved all three explicitly
("Ja zu allem") and then said the successor should do them — so they are decisions already made, not
questions to re-open. **Two of the three write to the live database**, which nothing in this series
has done yet.

---

## Start here, in this order

### 1. Migrate the bugs onto `metadata.bug` — `ubun-0808-ns-01KZGMABX249JFPK1X31KPFXGX` (high)

The schema half shipped in `aa5a70b`. The data is untouched. Until it is migrated, `tim_show
what="bugs" with="open"` still returns **1** entry for P0063 while the section visibly holds several
open bugs — they carry `metadata.task` and land in the task listing instead.

The node has the full mapping table. Two things not to get wrong:

- **Removing `metadata.task` from bug nodes is the step that actually fixes the listing**, and the
  hardest to undo. Snapshot first (`~/.tim/snapshots/`), dry-run, then write.
- **Closed bugs without a fix commit stay closed**, flagged `legacy: true`. That was the explicit
  decision. Reopening a dozen finished bugs would make the listing useless on first sight, which is
  the thing being repaired.

### 2. Retire the `Next Steps` sections — `ubun-0808-ns-01KZGMAXHKP4X3RG1PB7VNJA00` (medium)

Benni: "Tasks reichen aus." `aa5a70b` removed the section from the schema; existing data still has
it, including P0063's live prio queue. Move the children into `Tasks`, **then** delete the renderer's
legacy branch (`project-output.ts:328`) — in that order, never before the move. The node explains
why the branch was kept and what else references the old name.

### 3. Clamp the search caps — `ubun-0808-ns-01KZGECP8457AN2SQ4W666M80T` (medium)

Decided: **option (c), clamp and say so.** Code-only, no DB. The same node still carries an open
scope question about `cwd`-based project resolution — that one needs a call from whoever picks it up.

---

## What shipped this session

### `5f0c5fc` — the P1: tools accept the names callers actually guess

Every row in the error log was one caller who guessed a parameter name. New
`packages/tim-mcp/src/arg-aliases.ts`, wired into the single tool handler so all tools pass through
it once:

- `applyArgAliases` — per-tool table, only names a real caller has lost a call to:
  `tim_load_project` `project`/`projectId` → `label`, `tim_read` `parentLabel`/`sectionTitle` →
  `project`/`section`. The canonical key always wins when both are present.
- `explainMissingParams` — replaces the raw Zod issue array with one sentence naming what is missing,
  what was sent, and the full accepted list (read from `TOOL_DEFS[].schema.shape`, so it cannot
  drift). Returns `null` for any other failure, so nothing else changed.
- The tool-error `logError` now passes `sessionId`. It was `NULL` on all twelve rows.

**A global snake_case↔camelCase normalizer was considered and rejected** — `tim_read` really takes
`include_body`, `tim_error_log` really takes `args`. A test guards that.

Verified live after `/mcp` reconnect: `tim_load_project({project:"P0054"})` resolves, and a stdio
probe with `{cwd:…}` returns the sentence, not a dump. The MCP SDK types `arguments` as
`z.record(z.string(), z.unknown())`, so unknown keys do reach the handler — that was checked rather
than assumed.

Not verified: that the logged row's `session_id` is now non-null. Confirming the column needs direct
SQL, which is forbidden here.

### `aa5a70b` — sections decide what their children are; bugs must prove they were fixed

- `entry_type` on schema sections: `Bugs → bug`, `Tasks → task`, `Ideas → idea`. The write path
  stamps `metadata.type` plus the marker object with its default status. The caller always wins.
  Prose sections (Log, Roadmap, Decisions, Codebase, Usage, Rules) deliberately have none — a type
  no renderer reads is noise.
- `bug_annotation` documented in the schema. **`metadata.bug` already existed in the renderer**
  (`project-output.ts:176` reads it) but was never specified or set anywhere. Open = `status: 'open'`
  or no marker; everything else closed. Bugs carry `metadata.bug`, tasks carry `metadata.task`, never
  both.
- `bug.status = 'fixed'` requires `bug.commit`, enforced in `tim_write` and `tim_update`.
  `documented`/`wontfix`/`duplicate` need none — a bug left unfixed has no fix commit, and demanding
  one only produces invented hashes. **`metadata.provenance.commit` is HEAD when the bug was *filed*,
  not the fix** — the error message says so, because using it would auto-close every bug at birth.
- `Next Steps` and `Previous Steps` removed from the schema.

---

## Traps this session walked into

- **`node scripts/sync-project-schema.mjs` reads `dist/`, not `src/`.** Running it before `npm run
  build` regenerates the mirror from the previous schema and the mirror test then fails for a reason
  that has nothing to do with your edit. Build first, sync second.
- **The MCP server loads `dist/` at process start.** `aa5a70b` is newer than the last `/mcp`
  reconnect, so the auto-stamping is not live in the running server. Reconnect before relying on it —
  and before concluding anything from a tool's behaviour.
- **A finding can be older than your fix.** The bug-status design started out inventing a
  `metadata.resolution` field; `metadata.bug` was already there, unused. Grep the renderer before
  designing a new metadata shape.

---

## Also open, carried forward

- **`stop` is suppressed past `loop_limit`** in the cursor-agent bundle — same silent-skip class as
  the Codex trust gate. `sessionEnd` still catches the last turn. Not filed.
- **Codex briefing reaches ~32 of 136 marked sessions** (`ubun-0808-ns-01KZGBXTRS1PAMTPYKECCFM4RK`).
  Timeout and a broken hook are ruled out. Untested: whether forked, compacted or resumed sessions
  re-run the `startup|resume` matcher. Cheap next measurement, no code.
- **The brief reports "0 exchanges" for every session** (`ubun-0808-ns-01KZGD85QN75J0T8YRPGZ61XTP`,
  high). Fully specified fix in the node: read the session node's `exchange_count`, as
  `tim_resume_list` already does. Read-side only, no migration. It was ranked next-best before Benni
  redirected to the schema work.
- `listProjectSessionsByActivity('P0001', 20)` returned 0 rows on an isolated probe database. Not
  investigated.
- **118 phantom session nodes** still in the database; consumer side fixed in `e69e997`.
- **MAIMO's real history is in hmem** (`~/.hmem/Agents/DEVELOPER/DEVELOPER.hmem`, 57 MB). Migration
  question never answered. hmem stays read-only.
- **`tim doctor` crash** repaired in data only; two code fixes outstanding (`store.ts:250-252` vs
  `store.ts:412-418`, and a per-project `try/catch` in `collectBindingReport`).
- **Do not run `tim doctor --repair-schema`** on this database — see `TODO-session-continuity.md`.
- **`P0062` has two live project trees** (184 and 1552 nodes). Needs a merge decision.
- The hook commands on this host point at `dist/cli.js` inside this dev worktree on a feature branch.
  Correct for development, wrong after a global npm install.
- `HANDOFF.md` (untracked, repo root) is **stale** — it describes branch `fix/session-briefing-chain`
  and work that has long since landed. Ignore it or delete it; this file is the current handoff.

---

## Ground rules

- Never direct SQL on `~/.tim/tim.db` — TIM MCP tools or the store API only.
- Snapshot before touching the database. Existing: `~/.tim/snapshots/tim-20260807-1724.db`.
- `tsc -b` is incremental and cross-package imports go through `dist/`; on anything surprising run
  `npm run clean && npm run build` before believing a test result.
- `dist/` is in `.gitignore` but parts of it are tracked from before that rule. Staging new build
  output needs `git add -f`; `tsconfig.tsbuildinfo` stays out.
- **Restart the MCP server after deploying.** A stale server will happily talk you into fixing
  something twice.
- Report defects with `file:line` rather than fixing them silently; ask before committing.
- When a query returns nothing, first confirm it can return anything.
- **A node saying TODO is not evidence that the work is undone**, and `done` is not evidence that it
  is finished. Check the code.
