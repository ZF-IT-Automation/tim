# Handoff — session-continuity chain, PR #11 validation

Written 2026-08-07, ~19:30, by the session that fixed the chain.
Read this only as a fallback: if the SessionStart hook did its job, you already received a
`── Previous session ──` block and this file is just the long version.

Repo: `/home/bbbee/projects/tim`, branch `claude/tim-hmem-analysis-xt5j59` (PR #11).
Background: `VALIDATION-REPORT.md`, `TODO-session-continuity.md`, `docs/OPEN-POINTS.md`.

---

> **Update, 2026-08-07 ~20:45.** The briefing did arrive — the render path is proven and
> that question is closed. Do not re-run the check below; it is kept for the record.
>
> The successor session briefly believed it had found a sixth break — that the Stop hook
> never fires after `/clear`. That was a measurement taken too early and is **wrong**; the
> hook fires on every turn but the first.
>
> It then briefly believed **P0054 (MAIMO) proved what the old 1 MiB guard cost**. Also
> wrong: MAIMO's transcripts run *hmem's* hooks, not TIM's, so P0054 is empty simply because
> no session has run there under TIM. Expected state, not a defect.
>
> What is genuinely still open: the tail-read fix (`3d883f5`) has never been exercised
> against a >1 MiB transcript from a live session. Verify that before trusting long sessions.
> Both retractions and the method note are in `VALIDATION-REPORT.md` section 7 and the
> `P0063/Bugs` entry "Stop hook misses only the first turn after /clear". Start there.

## First thing: did the briefing arrive?

That is the one open question. Everything below it is proven.

**If you saw a `── Previous session (2026-08-07 · N exchanges) ──` block at the top of this
session** — the chain works end to end. Record it in the report verbatim, close P1, done.

**If you did not**, capture what you *did* get before touching anything, then compare
against what the builder produces right now:

```bash
cd /home/bbbee/projects/tim
node -e "
const { TimStore } = require('./packages/tim-store/dist/index.js');
const { collectDirectiveBriefing } = require('./packages/tim-cli/dist/session-briefing.js');
const { buildLoadDirective } = require('./packages/tim-hooks/dist/index.js');
const s = new TimStore(process.env.HOME + '/.tim/tim.db');
(async () => {
  const b = await collectDirectiveBriefing(s, 'P0063', 1200);
  console.log(buildLoadDirective('P0063', '/home/bbbee/projects/tim', 'P0063', b));
  s.close();
})();"
```

Two outcomes:

- **Builder produces the block, harness did not show it** → the break is in
  `packages/tim-hooks/scripts/tim-session-start.sh` or in how the harness consumes its
  JSON envelope. Note that `~/.tim/summarizer.log` starts with a fragment of that envelope
  (`{"hookSpecificOutput":{"`), which suggests the two have been crossed before.
- **Builder produces nothing either** → a fifth break. Work backwards:
  `previousSession` (`packages/tim-cli/src/session-briefing.ts:53`) →
  `listResumableSessions` (`packages/tim-store/src/session.ts:1058`) →
  `listProjectSessionsByActivity` (`packages/tim-store/src/store.ts:737`).

### What the block should contain

As of 19:30 on 2026-08-07 the builder returned exactly this:

```
── Previous session (2026-08-07 · 6 exchanges) ──
- Done: Deploy/build/snapshot complete; `1532 passed, 2 skipped, 0 failed`. Fixed three hook/read bugs. Chain set: Codex `GPT 5.6 Luna (Max)` → OpenCode `DeepSeek V4 Flash Free (Max)`.
- Current: Stop-Hook records exchanges; rollup code intact. `114/125` batch summaries contain prose, but `203/204` root nodes remain empty. Changes uncommitted; no commit yet.
- Open: Add detached summarizer spawn after successful full-batch logging; verify model IDs/per-user config; fix duplicate irrelevant `P0066` blocking `tim doctor`; reassess schema repair and historical empty rollups. Exchanges `seq 1–4` already truncated.
- Next: Wire Stop-Hook summarizer spawn, then run E2E test: turn end → `/clear` → new session → `Previous session`.
```

That rollup was written by the real chain, unattended, by codex `gpt-5.6-luna` at max
effort. It is a snapshot of the session mid-flight — by the time it was written the
"uncommitted" and "add detached summarizer spawn" items had already been done. That is
expected: the summary covers batch 1 (exchanges 1–5), not the whole session.

Source session id: `f8130261-3b31-4843-8090-6c52c893417b`.

---

## What was broken, and what fixed it

Five separate breaks in one chain: *session end → summary → briefing of the next session*.
Each alone was enough to produce an empty briefing, which is why the symptom never moved.

| # | Break | Fix |
|---|---|---|
| 1 | `claude-stop.ts` bailed on transcripts over 1 MiB, so a session logged nothing once it got going | `3d883f5` (cherry-picked `c06e78d`) — read the tail |
| 2 | `readLastExchange` kept only the first assistant text block of a turn; everything after the first tool call was dropped | `ac97aa1` — accumulate text blocks until the next user message |
| 3 | `SessionManager` read exchange text as `content \|\| title`, but `splitTitleBody` puts the first line in the title — every multi-line message reached the summarizer without its lead line | `ac97aa1` — shared `exchangeText` helper |
| 4 | Nothing spawned the summarizer. `maybeSpawnSummarizer` was wired only into the MCP server, but the Stop hook is the only writer of exchanges for Claude Code | `4e83b50` — call the gate from the CLI adapter after `logged === true` |
| 5 | The codex sub-agent the summarizer spawns registers a session node of its own (0 exchanges, no summary). Being newest, it won the "most recent session" query and masked the real one. 118 of 215 session nodes are such empties | `e69e997` — filter empty sessions in SQL |

Plus `0deb23e` from earlier the same day: `--pure` for opencode so plugin output cannot
become the summary, and an `args` passthrough on chain entries so a chain can ask for max
effort.

The rollup code itself was never broken —
`packages/tim-summarizer/src/summarize.ts:325-340` runs in a `finally`, unconditionally.

**Suite: 1533 passed, 2 skipped, 0 failed.** The three "known environment failures" from
`docs/OPEN-POINTS.md` do not occur on this host.

---

## State of the working tree

Branch `claude/tim-hmem-analysis-xt5j59`, most recent first:

```
e69e997 fix(store): skip empty sessions when listing resumable ones
4e83b50 fix(cli): spawn the summarizer when the Stop hook fills a batch
ac97aa1 fix(hooks,store): stop losing most of every recorded exchange
0deb23e fix(summarizer): stop plugin output from becoming the summary, and let the chain set effort
3d883f5 fix(hooks): read the transcript tail instead of bailing on size
252f301 test: use os.tmpdir() instead of a hardcoded /home/bbbee
```

Uncommitted and intentionally so: `VALIDATION-REPORT.md`, `TODO-session-continuity.md`,
this file, `HANDOFF.md` (belongs to an older branch — leave it alone), and two modified
`tsconfig.tsbuildinfo` files.

Summarizer chain in `~/.tim/config.json` — machine-specific, every user configures their
own:

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

Safety nets already in place: DB snapshot `~/.tim/snapshots/tim-20260807-1724.db`,
config backup `~/.tim/config.json.bak-20260807`.

---

## Honest caveats — do not present the run as clean

- **Exchanges seq 1–4 of the source session are stored truncated.** They were recorded
  before fixes 2 and 3. The rollup reflects that damage.
- **The last partial batch of a session is never summarized.** The spawn gate fires on
  `pending >= batch_size` and nothing runs at session end — no `SessionEnd` hook is
  registered (`packages/tim-cli/src/claude-hooks-install.ts:69` registers only
  SessionStart, UserPromptSubmit, Stop) and `/clear` does not reach TIM. A session ending
  at 7 exchanges carries a rollup covering the first 5.
- **The 118 phantom session nodes are still in the database.** The consumer side is fixed;
  the pollution is not. Codex has its own TIM integration and starts a session whenever
  the summarizer calls it.
- **Codex at max effort takes ~118 s per batch.** Well inside the 600 s timeout, but a
  session with several full batches spends minutes summarizing.

---

## Still open, unchanged from `TODO-session-continuity.md`

Do not start these without checking that file first — it carries the reproduce commands.

1. `tim doctor` crash is repaired **in data only**. Two code fixes outstanding: a
   per-project `try/catch` in `collectBindingReport`, and aligning `read`'s label fallback
   (`store.ts:250-252`) with `resolveProjectLabel` (`store.ts:412-418`) on `irrelevant`
   and `kind`.
2. **Do not run `tim doctor --repair-schema`** on this database. It would create an empty
   `Codebase` section beside P0063's populated `Codebase — Workspace-Struktur`.
   `indexChildren` (`project-schema-init.ts:57-59`) must first learn to recognize legacy
   sections that carry neither `kind=section` nor `metadata.label`.
3. `P0062` has two live project trees, 184 and 1552 nodes, both with real content. Needs a
   merge decision from Benni.
4. P2's `tim resummarize` cannot key on `SUMMARY_FAILURE_MARKER` — that marker was
   introduced by this branch, so no historical session carries it. The real signature is
   an empty summary body. Decide whether the command is worth building at all.

## Ground rules that applied to this work

- Never direct SQL on `~/.tim/tim.db` — TIM MCP tools or the store API only.
- Snapshot before touching the database.
- `tsc -b` is incremental and cross-package imports go through `dist/`; on anything
  surprising run `npm run clean && npm run build` before believing a test result.
- Restart the MCP server after deploying — it loads `dist/` at process start, and a stale
  one silently answers with old code.
- Report defects with `file:line` rather than fixing them silently; ask before committing.
