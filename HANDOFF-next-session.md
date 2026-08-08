# Handoff — next session

Written 2026-08-08 ~10:00 local. Repo `/home/bbbee/projects/tim`, branch
`claude/tim-hmem-analysis-xt5j59` (PR #11). Everything below is committed; the head at
handoff time is `4ff1617` plus the doc commit carrying this file.

This session worked the prio queue that the previous one built. Items 1, 2, 3, 4 and 6 are
done. Item 5 was skipped on Benni's instruction. The queue node in TIM is the authority on
what is left — this file summarizes it and records the one new P1.

---

## Start here: the new P1

**`MCP tools reject plausible parameter synonyms — every logged error is a caller who
guessed a different name`** (`P0063/Tasks`, `ubun-0808-ns-01KZGCXG5S7PF3YS25MFYR5BGX`,
priority high).

This came out of item 6. Once `tim doctor` started printing the error log, the log turned
out to hold twelve rows and they are nearly all the same failure:

| Tool | What the caller passed | What the schema wants |
|---|---|---|
| `tim_load_project` | `{"project":"P0054"}` | `label` |
| `tim_load_project` | `{"projectId":"P0054"}` | `label` |
| `tim_load_project` | `{"cwd":"…/maimo-rpg/.worktrees/…"}` | `label` |
| `tim_read` | `{"parentLabel":…,"sectionTitle":…}` | one of `id`, `project`, `section` |
| `tim_session_start` | everything except `sessionId` | `sessionId` |
| `tim_search` ×4 | `topK`/`excerptChars` over the cap | ≤ 500 |
| `tim_update` ×2 | — | a valid status transition |

Three different wrong names for the same argument of `tim_load_project`, from three
different sessions. Read that as an API-ergonomics defect, not as agents being careless —
the neighbouring tools take `project` and `projectId`, and the tool's own description says
"project label".

It is P1 because the loss is silent: the caller gets a raw Zod dump, continues without a
bound project, and the session looks exactly like "the briefing never fired" — the symptom
that was chased for weeks. The fix is a per-schema alias, not a redesign.

Second finding in the same rows: `session_id` is `NULL` on all twelve. `logError` takes a
`sessionId` and the MCP error path never passes one, so no logged error can be traced back
to its session. One argument at the call site.

---

## Second: the brief lies about session logging — fix it this way

**`Project brief reports "0 exchanges" for every session`** (`P0063/Bugs`,
`ubun-0808-ns-01KZGD85QN75J0T8YRPGZ61XTP`, high).

Found because the brief made a working system look broken: it says every recent session
recorded nothing, and that reading was believed for a moment before it was checked.
**Session logging is fine** — `tim_resume_list` shows this session at 7 exchanges and
MAIMO's most recent at 6. Only the display is wrong.

There are two nodes per session. The **session node** is the log: the exchanges hang off it
and it carries the live counter, `metadata.exchange_count`, maintained by the logger
(`session.ts:445`). Its child **Summary node** is the summarizer's output: it is created
with `exchanges: 0` and `summary: ''` (`session.ts:301`) and only filled when a summary is
generated (`session.ts:804`).

The brief's Recent Sessions block collects entries tagged `#session-summary`
(`packages/tim-mcp/src/project-output.ts:551`) — the Summary nodes — and then reads
`metadata.exchanges` and `metadata.summary` off them (`parseSessionEntry`, line 121). So it
reports the summarizer's state while claiming to report the logger's: `0 exchanges` until a
summary exists, and the literal word `Summary` as the summary line, because the fallback
takes the node's title.

**Fix it on the read side: resolve the session node and read `exchange_count` from it.**
That is what `tim_resume_list` already does (`session.ts:1060`, `:1090`), so the two
displays stop disagreeing, and no new state is introduced. The alternative — having the
logger keep the Summary node's `exchanges` in step — duplicates a counter that already
exists in one place, and a duplicated counter drifts. Do not take it.

Specifics worth having in the fix:

- The Summary node's parent is the session node; the block already has the children list,
  so the lookup is local.
- Keep reading `metadata.summary` from the Summary node — that part is correct. Only the
  *fallback* is wrong: when it is empty, print nothing (or the session's own task summary),
  never the node title.
- Test both shapes: a session with exchanges and **no** summary yet must show its real
  count, and a summarized session must keep showing its summary.
- `packages/tim-store/src/project-output.ts:329` holds a second copy of the same block. It
  is not exported from that package's `index.ts` and only its own tests import it, so it
  reads as dead code — verify that before fixing it twice, and prefer deleting it.

---

## What shipped this session

### `2e60328` — queue item 1: the backlog stops lying

`resolveEntryTaskStatus` read only `metadata.task.status`. Legacy entries carry
`metadata.task = true` plus a top-level `metadata.status`, and `isTaskMarker` accepts both
shapes — so legacy tasks were *listed* while their status was discarded, and six finished
tasks rendered open forever.

The canonical object still wins outright; only a non-object `metadata.task` falls through
to `metadata.status`, and only the seven canonical `TaskStatusValue` strings are accepted
there. A legacy `metadata.status` of `fixed` or `documented` (the bug vocabulary) stays
`todo` — that axis belongs to the node filed as item 2.

All six nodes were verified by reading their metadata rather than trusting the bug node's
claim: every one is `task=true` + `status='done'`.

This knowingly reverses an earlier deliberate decision. Three tests asserted the old
behaviour, labelled "the T3 fix" and "one-directional per Plan 7"; they were rewritten
rather than deleted so the reversal stays traceable.

**Verified live after the MCP server was reconnected:** the open-task count went from 27 to
**21**, exactly the six predicted, with no collateral.

### `8397450` — queue item 3: blank session ids rejected

`assertSessionId` in `packages/tim-store/src/session.ts`, called from `sessionStart` and
`startProjectSession`. In the store rather than the zod schema because five call sites
funnel through those two methods; a schema guard would have covered one.

Validation runs before `requireProject`, so a rejected call leaves no half-built `Sessions`
section. `ensureHookSession` catches and returns `false`; `server.ts:3067` was already
unreachable with a blank id and already wrapped in a `try/catch`.

The commit message says "all four entry points" and lists `cli.ts` as if it called the
store directly. It is five, and the CLI goes through `checkpoint.ts` — the TIM node has the
accurate account.

Only the empty-id slice. Preferring the harness session id over an agent-invented one, the
half that actually stops the double-node pattern, is still open on that node.

### `4ff1617` — queue item 6: the error alert became a burst detector

Two real gaps behind requirement 4 of the Framework Health node, and one queue claim that
was simply wrong.

- Wrong: "no error statistics reach `tim_doctor`". The MCP `tim_doctor` has reported count,
  rate and alerts since it was built (`server.ts:2736`).
- Real: `getStats` passed its own reporting window into `getAlertThresholds`, so a 24-hour
  query raised the same flag for six errors spread across a day as for six in five minutes,
  and the text read "in last 24h". The threshold is a burst detector — more than five of
  the same error within an hour — and now always looks at the last hour whatever window the
  statistics cover. `getAlertThresholds` keeps its parameter for direct callers.
- Real: the **CLI** `tim doctor`, the copy a human runs, reported no errors at all. It now
  prints the 24h count, the rate, alerts and the top five, with Zod dumps flattened to one
  line each.

### Item 4 — measurement only, no code

The question was whether this host's `~/.codex/hooks.json` carries persisted hook trust,
because Codex skips untrusted hooks silently. **It does, and the briefing does fire.**

Trust lives in `~/.codex/config.toml`, not a separate store:

```toml
[hooks.state."/home/bbbee/.codex/hooks.json:session_start:0:0"]
trusted_hash = "sha256:5de605da2c92d8aa9c6f4bd97947b5a3cc84e69d4d11289369f6e75e670a702e"
```

Key is `<absolute hooks.json path>:<snake_case event>:<matcher group>:<hook index>`. Entries
exist for all four `session_start` hooks and for `pre_compact`. 44 Codex rollouts contain
the injected briefing, the most recent from that same morning.

The hash input could not be reproduced — nine encodings tried, none matched. An installer
can therefore detect that an entry exists for its key, but cannot verify the hash still
matches what it wrote.

**But the same measurement raised a worse question**, filed as
`ubun-0808-ns-01KZGBXTRS1PAMTPYKECCFM4RK`: of 142 Codex sessions since `hooks.json` was last
written, 136 ran under a `.tim-project` marker and **32 got the briefing**. Same directory,
same day, both outcomes — 24 unbriefed `codex-tui` sessions in `maimo-rpg` on 2026-08-07
against 4 briefed. Timeout is ruled out (the hook takes 0.185 s against a 10 s budget) and so
is a broken hook. Not investigated: whether forked, compacted or resumed sessions re-run the
`startup|resume` matcher — that may account for the whole gap. Marker presence was checked
today, not historically, so 136 is an upper bound.

---

## Queue state

`P0063/Next Steps` → "Prio-Queue 2026-08-08" (`ubun-0808-ns-01KZG7ZFQG4FHBSMFJZ053CFY0`)
carries a progress block at the top. Done: 1, 2 (filed, not built), 3, 4, 6. Skipped: 5.
Remaining: 5, 7–18, plus the new P1 above, which belongs before all of them.

Item 2 (`ubun-0808-ns-01KZGAXYACYPYEZ17FN834SNYS`) is filed but deliberately unstarted: it
needs a decision from Benni — own status field for bugs versus `metadata.task.status` plus a
`kind` discriminator — and a migration that touches the live database, which is a different
risk class from everything shipped today.

---

## Findings recorded, not fixed

- `packages/tim-store/src/project-output.ts:113` — the mirror image of item 1's bug:
  `metadata.status || 'todo'` for every task marker, so a canonical `task: {status: 'done'}`
  renders `[todo]` there. Not exported from that package's `index.ts` and imported only by
  its own tests, so it reads as dead code. Deletion candidate, not verified as such.
- A section whose children are all closed tasks renders empty, with no "N completed tasks"
  label. Pre-existing in the render path.
- The twelve error-log rows themselves — see the P1 above.

---

## Also open, carried forward from the previous handoff

- **`stop` is suppressed past `loop_limit`** in the cursor-agent bundle — same silent-skip
  class as the Codex trust gate. `sessionEnd` still catches the last turn. Not filed.
- **`listProjectSessionsByActivity('P0001', 20)` returned 0 rows** on an isolated probe
  database while the session nodes were plainly in the tree. Not investigated.
- **118 phantom session nodes** still in the database; consumer side fixed in `e69e997`.
- **MAIMO's real history is in hmem** — `~/.hmem/Agents/DEVELOPER/DEVELOPER.hmem`, 57 MB.
  Migration question, never answered. hmem stays read-only.
- **`tim doctor` crash** repaired in data only; two code fixes outstanding
  (`store.ts:250-252` vs `store.ts:412-418`, and a per-project `try/catch` in
  `collectBindingReport`).
- **Do not run `tim doctor --repair-schema`** on this database — see
  `TODO-session-continuity.md`.
- **`P0062` has two live project trees** (184 and 1552 nodes). Needs a merge decision.
- The hook commands installed on this host point at `dist/cli.js` inside this dev worktree
  on a feature branch. Correct for development, wrong after a global npm install.

---

## Ground rules

- Never direct SQL on `~/.tim/tim.db` — TIM MCP tools or the store API only.
- Snapshot before touching the database. Existing: `~/.tim/snapshots/tim-20260807-1724.db`.
- `tsc -b` is incremental and cross-package imports go through `dist/`; on anything
  surprising run `npm run clean && npm run build` before believing a test result.
- `dist/` is in `.gitignore` but parts of it are tracked from before that rule. Staging new
  build output needs `git add -f`; `tsconfig.tsbuildinfo` stays out.
- **Restart the MCP server after deploying** — it loads `dist/` at process start. Item 1's
  effect was invisible until `/mcp` reconnected, and a stale server will happily talk you
  into "fixing" something twice.
- Report defects with `file:line` rather than fixing them silently; ask before committing.
- When a query returns nothing, first confirm it can return anything.
- **A node saying TODO is not evidence that the work is undone** — and the inverse now has
  its own scar: the Framework Health node said `done` while requirement 4 was half built,
  and the queue's own audit note about it was itself partly wrong. Check the code.
- Suite at handoff: **1559 passed, 2 skipped, 0 failed.**
