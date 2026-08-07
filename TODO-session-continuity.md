# TODO — session continuity chain (PR #11 validation follow-up)

Written 2026-08-07. Branch `claude/tim-hmem-analysis-xt5j59`.
Background and evidence: `VALIDATION-REPORT.md` in this directory.
Open points this came from: `docs/OPEN-POINTS.md` (P1–P5).

---

## Where things stand

Deployed and verified on this host:

- Suite: **1533 passed, 2 skipped, 0 failed**. The three "known environment failures" in
  OPEN-POINTS do not occur here.
- Summarizer chain configured and **live-tested against real models** — both entries
  produce genuine thematic summaries, not transcripts.
- `tim doctor` runs end to end again (was aborting on a duplicate project label).
- Snapshot before any DB write: `~/.tim/snapshots/tim-20260807-1724.db`
  (also `/tmp/tim-snapshots/tim-20260807-1724.db`, volatile).
- Config backup: `~/.tim/config.json.bak-20260807`.

Commits added to the branch:

```
e69e997 fix(store): skip empty sessions when listing resumable ones
4e83b50 fix(cli): spawn the summarizer when the Stop hook fills a batch
ac97aa1 fix(hooks,store): stop losing most of every recorded exchange
0deb23e fix(summarizer): stop plugin output from becoming the summary, and let the chain set effort
3d883f5 fix(hooks): read the transcript tail instead of bailing on size   (cherry-picked c06e78d)
```

Current chain in `~/.tim/config.json` — machine-specific, every user must set their own:

```json
"summarizer": {
  "chain": [
    { "cli": "codex", "model": "gpt-5.6-luna",
      "args": ["-c", "model_reasoning_effort=max"] },
    { "cli": "opencode", "model": "deepseek-v4-flash-free", "provider": "opencode",
      "args": ["--variant", "max"] }
  ],
  "timeout_sec": 600
}
```

**The chain now runs unattended.** A live session filled a batch, the summarizer was
spawned by the Stop hook, batch summary and session rollup were written, and the briefing
builder returns that rollup. What is still unwitnessed is the harness rendering it into a
fresh session — that needs a `/clear`.

---

## 1. Stop hook — RESOLVED, but what it recorded was truncated

**Correction.** The hook does fire, on every turn. The transcript size guard was the
entire cause; `3d883f5` fixed it. The "count stayed at 1" observation that produced this
item was taken before the rebuilt `dist/` reached the `tim` binary the hook invokes.

Evidence, session `f8130261-3b31-4843-8090-6c52c893417b`: exchanges recorded
automatically at 16:46, 16:55 and 16:57, each matching a real turn. No harness change,
no `tee` wrapper, nothing in `~/.claude/settings.json` was touched.

Verify on any live session:

```bash
node -e "
const { TimStore } = require('./packages/tim-store/dist/index.js');
const s = new TimStore(process.env.HOME + '/.tim/tim.db');
(async () => {
  const walk = async (id, ind) => {
    for (const k of await s.getChildren(id)) {
      console.log(ind + k.metadata.kind, k.createdAt, 'role=' + k.metadata.role,
        'title=' + k.title.length, 'body=' + k.content.length);
      await walk(k.id, ind + '  ');
    }
  };
  await walk('<session-id>', '');
  s.close();
})();"
```

### Two content-loss defects found by reading what it stored

Both fixed, both uncommitted at the time of writing.

1. **`readLastExchange` kept only the first assistant text block of a turn**
   (`packages/tim-hooks/src/claude-stop.ts:143-150`). It set `lastUser = null` after the
   first pairing, so every text block after the first tool call was dropped. A turn with
   tool use stored the opening line and nothing else — visible in seq 2–4 of the session
   above, where the agent title holds a single lead sentence and the body is empty.
   Now the text blocks of a turn are accumulated until the next user message.
   Verified against the live transcript: `thinking` and `tool_result` records yield no
   text block and cannot split a turn; the only intra-turn user record that can is
   `[Request interrupted by user]`, which is a genuine boundary.

2. **`content || title` dropped the first line of every message**
   (`packages/tim-store/src/session.ts`, four sites: 151, 161, 544, 546 / 1016, 1017 in
   the pre-fix numbering). Exchanges are written through `splitTitleBody`
   (`packages/tim-store/src/store.ts:3533`), which puts the first line in the title and
   the remainder in the content. Reading the content alone therefore handed the
   summarizer every multi-line message with its lead line missing. Replaced by a shared
   `exchangeText` helper.

Suite after both: **1532 passed, 2 skipped, 0 failed** (one new test in
`packages/tim-hooks/src/__tests__/claude-stop.test.ts`).

**Note for the report:** seq 1–4 of the current session are stored truncated. They were
recorded before these fixes. Do not present that run as clean.

### Two more breaks in the same chain, both found and fixed

3. **Nothing ever spawned the summarizer** (`packages/tim-cli/src/cli.ts:603`).
   `maybeSpawnSummarizer` was wired only into the MCP server's `SessionManager`
   (`packages/tim-mcp/src/server.ts:1539`). For Claude Code the Stop hook is the only
   writer of exchanges, so it is the only thing that learns a batch filled — and it never
   called the gate. No `SessionEnd` hook covers this either; the installer
   (`packages/tim-cli/src/claude-hooks-install.ts:69`) registers only SessionStart,
   UserPromptSubmit and Stop. Batches filled, nothing summarized. This is the second
   mechanism behind the 203 empty summary roots.
   Now called after `logged === true`, in the CLI adapter rather than in `runClaudeStop`
   so the unit tests (which reach five exchanges) do not spawn detached processes.

4. **Every summarizer run masked the session it had just summarized**
   (`packages/tim-store/src/store.ts:749`). The briefing asks for the single most recent
   session and reads its rollup. The codex sub-agent the summarizer spawns registers a
   session node of its own — zero exchanges, no summary — and being newer, it won the
   query. `previousSession` (`packages/tim-cli/src/session-briefing.ts:60`) found no
   summary on it and returned nothing. **118 of 215** session nodes in this database are
   such empties. Now filtered in SQL so `LIMIT` still returns the intended rows; an
   absent `exchange_count` is treated as legacy data, not as proof of emptiness.

The rollup code itself is fine: `packages/tim-summarizer/src/summarize.ts:325-340` runs
in a `finally`, unconditionally, so a mid-session spawn does write the session summary.

### Verified end to end at the database level

With all four fixes built, this session's own turn 5 filled batch 1 and the chain ran
unattended:

- `batch-summary` "Batch 1" — 2092 chars of real thematic prose
- `session-summary-root` — 733 chars, a four-bullet handoff (Done / Current / Open / Next)
- `collectDirectiveBriefing(store, 'P0063', 1200)` now returns
  `previousSessionLabel: "2026-08-07 · 5 exchanges"` plus that rollup

Suite: **1533 passed, 2 skipped, 0 failed**. Commits `ac97aa1`, `4e83b50`, `e69e997`.

### Still to do — the actual deliverable

`/clear`, start a fresh session in the same directory, and capture the
`── Previous session ──` block **verbatim** as the harness renders it. Everything below
that block is now proven; what remains is the harness-side render.

Two things to get right when judging it:

- The check is the `session-summary-root` body, **not** the batch summary. Batch
  summarization historically worked (114 of 125 real); the session-level rollup is where
  203 of 204 came out empty. A written `batch-summary` is not evidence.
- Codex at max effort runs ~118 s per batch. Wait 2–3 minutes after `/clear` before
  calling a briefing empty.

Caveat for the report: seq 1–4 of this session are stored truncated — they were recorded
before fix 1 and 2. The summary reflects that. Do not present the run as clean.

---

## 2. `tim doctor` crash — repaired in data, not in code

The next duplicate or malformed project label reproduces the abort. It is pre-existing on
`master`, not introduced by this PR.

**Root cause.** Two lookup paths disagree:

- `TimStore.resolveProjectLabel` (`packages/tim-store/src/store.ts:412-418`) filters
  `irrelevant = 0` and `kind = 'project'`.
- `TimStore.read`'s label fallback (`store.ts:250-252`) filters **neither**, and its
  `.get()` returns an arbitrary row.

`requireProject` (`store.ts:543-557`) chains both: resolves fine, reads back `null`,
throws. The throw escapes `collectBindingReport`
(`packages/tim-hooks/src/project-binding-health.ts:82-110`) and kills `cmdDoctor` at
`packages/tim-cli/src/cli.ts:283`, before the first `console.log` on line 285.

**Two fixes, both still to do:**

1. Narrow: per-project `try/catch` in `collectBindingReport`, matching what
   `collectProjectSchemaReport` already does
   (`packages/tim-cli/src/project-schema-repair.ts:43-46`). One malformed project should
   not blank the whole report.
2. Deeper: align `read`'s label fallback with `resolveProjectLabel` on `irrelevant` and
   `kind`.

**Data repairs already applied** (via the store API, each carrying a
`metadata.retired_note`):

| Entry | Was | Now |
|---|---|---|
| `ubun-0619` Reminders | `P0066 Reminders` | `P0066` |
| `ubun-0605` Upstream Hermes fork | `P0066` | `P0074` |
| `ubun-0602` Hermes Agent | `P0066` | `P0075`, `irrelevant=true` |
| `ubun-0607` TIM-Recovery-2026-06-07 | `TIM-Recovery-2026-06-07` | `P0076`, `irrelevant=true` |
| `ubun-0603-…VX07WD` Hermes Agent | `P0066` | `P0077`, `irrelevant=true` |

Note: `metadata.label` cannot be removed through `tim_update` — it survives a metadata
replace. Each entry was given a unique free label instead.

Audit command (the only lookup that sees soft-deleted rows):

```bash
node -e "
const { TimStore } = require('./packages/tim-store/dist/index.js');
const s = new TimStore(process.env.HOME + '/.tim/tim.db');
for (let i = 0; i <= 200; i++) {
  const l = 'P' + String(i).padStart(4, '0');
  const rows = s.findSystemRepairEntriesByLabelSync(l);
  if (rows.length > 1) console.log(l, rows.map(r => r.id + '(irrelevant=' + r.irrelevant + ')').join(' '));
}
s.close();"
```

---

## 3. `--repair-schema` must not be run yet

It would create an **empty** `Codebase` section beside P0063's populated
`Codebase — Workspace-Struktur` (802 bytes, 12 children) — the exact twinning `4d7ac22`
set out to prevent.

The retitle path (`packages/tim-store/src/project-schema-init.ts:111-118`) only fires for
legacy sections that carry **both** `kind === 'section'` (`:57`) and a matching
`metadata.label` (`:59`). P0063's legacy sections have neither, so execution falls through
to `created` at `:120`. Worse, the `unknown` reporting loop also skips non-section
children (`:187`), so the report shows `custom (kept): —` while a populated section sits
right there — the operator gets no warning at all.

Because `formatProjectOutput` renders by title, after a repair the briefing would show the
empty `Codebase` while 12 real children hang off a differently-titled sibling.

**Fix before running anything:** teach `indexChildren` to recognize legacy sections that
carry neither `kind=section` nor `metadata.label`, then re-plan. The 43-project report
claims 15–25 missing sections each; an unknown share of those already exist as untitled
legacy nodes, so `missing` cannot currently be read as "safe to add".

Dry run for a single project:

```bash
node -e "
const { TimStore, planProjectSchema } = require('./packages/tim-store/dist/index.js');
const s = new TimStore(process.env.HOME + '/.tim/tim.db');
planProjectSchema(s, 'P0063').then(p => { console.log(JSON.stringify(p, null, 2)); s.close(); });"
```

---

## 4. `P0062` has two live project trees

184 nodes and 1552 nodes, **both with real content**. Deliberately not touched — merging
is a data-consolidation job with its own risk profile.

`P0062` resolves today only by accident: one of the two entries has the literal entry id
`P0062`, so `read`'s by-id lookup (`store.ts:246`) hits before the label fallback runs.
That is a legacy hmem-shaped id, not a guarantee.

Needs a merge decision from the operator before anything else touches P0062.

---

## 5. P2 (`tim resummarize`) needs a different trigger

`docs/OPEN-POINTS.md` assumes the failure marker identifies damaged sessions. It does not:
`SUMMARY_FAILURE_MARKER` was introduced *by this branch* in `fbcd525`, so no historical
session can carry it. Current count of marked sessions: **0**.

The real signature in this database:

| Node kind | Total | Empty body | Raw transcript | Real summary |
|---|---|---|---|---|
| `session-summary-root` | 204 | **203** | 0 | 1 |
| `batch-summary` | 125 | 0 | 11 | 114 |

Batch summarization mostly worked historically. The session-level rollup did not.

So `tim resummarize` must key on **empty or transcript-shaped summary bodies**, not on the
marker. Note that most of these sessions hold only 1–2 exchanges (item 1), so there may be
little worth re-summarizing — decide whether the command is worth building at all before
building it.

The single non-empty `session-summary-root` is not a summary either: it contains TIM's own
session-start directive, captured from opencode plugin stdout. That path is closed by
`--pure` in `0deb23e`.

---

## 6. Smaller items

- **`DEFAULT_SUMMARIZER_CHAIN` is a liability** (`packages/tim-core/src/config.ts:40`).
  It copies `DEFAULT_REMEMBER_CHAIN` and guesses `opencode` + Anthropic/DeepSeek/Moonshot.
  Every entry of that guess fails on this host. A user who configures nothing gets a silent
  misconfiguration that `tim doctor` reports as `✓` whenever `opencode` happens to be on
  PATH. Consider shipping **no** default and making the absence loud instead.
- **`tim doctor`'s summarizer check is PATH-only**
  (`packages/tim-cli/src/summarizer-health.ts:57`). For `curl-openrouter` it checks for
  `curl`; it never verifies auth or that the model id exists. A green `✓` is not evidence
  the chain produces output.
- **Restart the MCP server after deploying.** It loads `dist/` at process start, so a
  long-lived server keeps running old code — PID 1006 was 10 days stale during this run,
  and MCP results disagreed with the freshly built store API.
- **`~/.tim/summarizer.log` is polluted.** It begins with a fragment of the SessionStart
  hook's JSON envelope (`{"hookSpecificOutput":{"`), so something writes hook output into
  it. Cosmetic, but the log is not a clean record.
- **The last partial batch of a session is never summarized.** The spawn gate fires on
  `pending >= batch_size`, and nothing runs at session end — no `SessionEnd` hook is
  registered, and `/clear` does not reach TIM. A session that ends at 7 exchanges carries
  a rollup covering the first 5. Closing this means either registering `SessionEnd` →
  `tim hook session-end` in the installer, or accepting the gap and documenting it.
- **The summarizer's codex sub-agent registers a TIM session per run.** 118 of 215
  session nodes in this database are these empties, all under real projects, all with
  `exchange_count: 0` and one with an empty `metadata.sessionId`. The consumer side is
  fixed (item 1.4), but the pollution itself is not: codex has its own TIM integration and
  starts a session whenever the summarizer calls it. Worth suppressing at the source, and
  worth a cleanup pass over the existing 118.
- **Codex at max effort costs ~118 s per batch.** Inside the 600 s timeout, but a session
  with several full batches spends minutes summarizing at session end. Watch this once
  item 1 is fixed and batches actually fill.
- **Stashed work.** `git stash list` still holds
  `pre-validation: skill md + tsbuildinfo (fix/session-briefing-chain)` — 10 `SKILL.md`
  files and 2 `tsbuildinfo`.
- **Two commits from `fix/session-briefing-chain` remain unmerged:** `27a526e`
  (never resolve an unattended session as the current one) and `6ce0d40` (statusline
  resolution below the marker dir). Both touch session resolution and may matter for
  item 1.
- **`tsconfig.tsbuildinfo` is tracked** despite `.gitignore` listing `dist/`
  (P5 in OPEN-POINTS). `git rm --cached packages/*/tsconfig.tsbuildinfo` is still due.

---

## Ground rules that applied to this work

- Do not run `--repair-schema` until item 3 is fixed.
- Never direct SQL on `~/.tim/tim.db` — TIM MCP tools or the store API only.
- Snapshot before touching the database.
- `tsc -b` is incremental; on anything surprising run `npm run clean && npm run build`
  before believing a test result.
- Report defects with `file:line` rather than fixing them silently; ask before committing.
