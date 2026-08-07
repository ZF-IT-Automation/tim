# TIM — Validation run of `claude/tim-hmem-analysis-xt5j59` (PR #11)

Host: strato (hostname `ubun`), 2026-08-07. Covers P1 and P2 from `docs/OPEN-POINTS.md`.

---

## 1. Deployment and test suite

```
git checkout claude/tim-hmem-analysis-xt5j59   # HEAD = 252f301
npm ci && npm run clean && npm run build
npx vitest run
```

Result: **184 test files, 1529 passed, 2 skipped, 0 failed.**

The three failures listed in `docs/OPEN-POINTS.md` as environment artefacts do **not**
occur on this machine:

| Test | Why it passes here |
|---|---|
| `tim-store/__tests__/store.test.ts` — `should write and read an entry` | hostname is `ubun` (4 chars), so the ID regex matches |
| `tim-store/__tests__/store.test.ts` — `should assign id with session_short …` | same |
| `tim-cli/__tests__/resolve-project.test.ts` — `prints the label` | the live DB contains P0063 |

Note: `tim` on PATH (`~/.local/bin/tim`) symlinks to
`~/projects/tim/packages/tim-cli/dist/cli.js`, and the Claude Code hooks in
`~/.claude/settings.json` call that same binary. The build under test is therefore
the code the hooks execute — no globally installed copy shadows it.

### Commits excluded from this validation

The previous working branch `fix/session-briefing-chain` carries three commits that are
**not** on the branch under test, and all three sit in the path being validated:

- `c06e78d` fix(hooks): read the transcript tail instead of bailing on size
- `27a526e` fix(session): never resolve an unattended session as the current one
- `6ce0d40` fix(statusline): resolve sessions started below the marker dir

Uncommitted work on that branch (10 `SKILL.md` files, 2 `tsconfig.tsbuildinfo`) was
stashed, not committed:
`git stash list` → `pre-validation: skill md + tsbuildinfo (fix/session-briefing-chain)`.

---

## 2. Snapshot

```
/tmp/tim-snapshots/tim-20260807-1724.db   (71 565 312 bytes)
```

Copied to a non-volatile location, since `/tmp` is subject to cleanup:

```
~/.tim/snapshots/tim-20260807-1724.db
```

Taken **before** the first `tim doctor` invocation, because `TimStore`'s constructor
runs migrations and `DROP/CREATE TRIGGER` on every open (P4 in OPEN-POINTS) — even
read-only-looking commands mutate the database.

---

## 3. Summarizer chain

### Candidates tested by hand, invoked exactly as `tryCli` invokes them

| Candidate | Result |
|---|---|
| `opencode run -m deepseek/deepseek-v4-pro --print-logs` | **fails** — exit 1, empty stdout, server-side `UnknownError` (`err_c3de718e`). This was the previously configured first chain entry. |
| `codex exec --model gpt-5.1-codex --skip-git-repo-check` | **unusable** — exit 0 but empty stdout, which `tryCli` rejects as a failure |
| `cli: "agent"` (previously configured fallback) | **no such binary** — falls into the generic `else` branch of `tryCli` and dies on spawn |
| `curl-openrouter` + `anthropic/claude-sonnet-4.5` | **works** |
| `curl-openrouter` + `google/gemini-2.5-flash` | **works** |
| `curl-openrouter` + `deepseek/deepseek-chat-v3.1` | **works** |

`OPENROUTER_API_KEY` is not in the process environment but is present in
`~/.hermes/.env`, which `resolveEnvVar` (`packages/tim-summarizer/src/generate-summary.ts:8`)
reads as a fallback. The `curl-openrouter` path therefore needs no CLI auth surface at
all, which makes it the most reliable option on this host.

### Chain now configured in `~/.tim/config.json`

Set by operator decision: Codex primary, OpenCode free-tier DeepSeek as the single
fallback. No third entry — the free DeepSeek should always be available.

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

The previous config was backed up to `~/.tim/config.json.bak-20260807`.

`tim doctor` reports `✓ chain: codex/gpt-5.6-luna (+1 fallback(s))`.

**This chain is machine-specific.** It reflects what is installed and authenticated on
this host. Anyone without `codex` and `opencode` has to pick their own CLIs and models —
there is no chain that is correct by default, which is exactly why `DEFAULT_SUMMARIZER_CHAIN`
(`packages/tim-core/src/config.ts:40`) being a copy of `DEFAULT_REMEMBER_CHAIN` is a
liability rather than a convenience: it guesses `opencode` + Anthropic/DeepSeek/Moonshot,
and on this machine every entry of that guess fails.

### Live end-to-end run of the configured chain

Both entries were driven through `tryCli` with the real config, on a realistic batch
prompt:

| Entry | Time | Output |
|---|---|---|
| `codex/gpt-5.6-luna` (max) | 118.3 s | 312 chars, themes + decision + open items + TAGS |
| `opencode/deepseek-v4-flash-free` (max) | 10.5 s | 488 chars, same structure |

Codex output:

```
Batch 1 — P0063

- Theme: Summarizer fallback chain.
- Decision: Codex/gpt-5.6-luna primary; OpenCode DeepSeek v4 Flash Free fallback.
- Cause/fix: OpenCode plugins polluted stdout with o9k/TIM directives. `--pure` suppresses output.
- Open items: None recorded.

TAGS: #summarizer #fallback #opencode #pure-mode
```

Both produce real thematic summaries, not transcripts. 118 s at max effort is well inside
the 600 s timeout, but it is per batch — a session with several full batches spends minutes
summarizing at session end.

### Two code changes were needed to express this chain

Uncommitted on the branch. Suite after them: **1531 passed** (1529 + 2 new), 0 failed.

**1. `--pure` for opencode** (`generate-summary.ts`, opencode branch).

The opencode fallback was returning poisoned output. A plain
`opencode run -m opencode/deepseek-v4-flash-free` from this repo returns 2771 characters
whose first ~600 are not from the model at all:

```
MANDATORY, not a suggestion: o9k's installed pillars apply to EVERY response …
📍 TIM project marker detected (.tim-project in /home/bbbee/projects/tim).
This session is bound to TIM project P…
```

Source: `~/.config/opencode/plugins/tim-session-start.ts` and `o9k.ts`. The TIM plugin
prints TIM's own session-start directive on `session.created`, and opencode forwards
plugin stdout. Fired inside the summarizer, that text becomes the stored summary.

**This is the confirmed origin of the one non-empty `session-summary-root` in the database
(section 4) — it contains exactly this directive text.** TIM was summarizing its own
briefing.

`opencode run --pure` ("run without external plugins") reduces the same call to a clean
3-byte `OK`. The flag is now passed unconditionally: no plugin output should ever reach a
batch summary.

**2. `args` passthrough on chain entries** (`tim-core/src/index.ts`,
`generate-summary.ts`).

The chain shape had no way to express reasoning effort. `tryCli`'s codex branch built
`['exec', '--model', model, '--skip-git-repo-check']` and nothing else, so "(Max)" was
unreachable — codex was silently running at `high` from `~/.codex/config.toml`. An optional
`args?: string[]` is now appended verbatim to the constructed argv, which covers codex's
`-c model_reasoning_effort=max` and opencode's native `--variant max` without a
per-CLI special case.

Verified by two new tests in
`packages/tim-summarizer/src/__tests__/generate-summary.test.ts`, using argv-echoing stubs
on `PATH`: one asserts opencode receives `--pure`, one asserts chain-entry `args` are
appended.

Caveat worth recording: that check only verifies the first entry's command resolves on
`PATH` (`packages/tim-cli/src/summarizer-health.ts:57`). For `curl-openrouter` that means
it checks for `curl`, not for a working API key or a valid model id. The previously
configured `opencode` chain would also have reported `✓` while failing on every call.
A green `tim doctor` is not evidence the chain produces output.

---

## 4. Sessions carrying the failure marker

**Count: 0.**

That number is misleading on its own, and the reason matters more than the count.

`SUMMARY_FAILURE_MARKER` (`[ALL SUMMARIZER CLIs FAILED`) was introduced *by this branch*,
in commit `fbcd525`. Sessions that were summarized before this branch existed cannot
carry a marker that did not yet exist. P2's expectation in `docs/OPEN-POINTS.md` — "in a
real grown DB this should be every session from before this branch" — does not hold.

What the historical damage actually looks like in this database:

| Node kind | Total | Empty body | Raw transcript | Real summary |
|---|---|---|---|---|
| `session-summary-root` | 204 | **203** | 0 | 1 |
| `batch-summary` | 125 | 0 | 11 | 114 |

Batch summarization mostly worked historically — 114 of 125 batch summaries hold real
prose. The session-level rollup did not: 203 of 204 session summary roots are empty
strings, and the single non-empty one contains the session-start directive text rather
than a summary.

This is the concrete reason session continuity never worked. It is also invisible to the
new detector: an empty body contains no marker, so `tim doctor` reports zero problems
across 203 damaged sessions. A `tim resummarize` command built against the marker alone
would find nothing to repair on this host.

The three nodes in the database that do contain the marker string are `exchange` nodes —
logged conversation text from sessions that discussed the marker, not damaged summaries.

Confirming the effect on the briefing, before any new session has run:

```
$ tim resolve-project --walk-up --cwd /home/bbbee/projects/tim --format directive
```

emits the marker line, an `── Open work ──` block with 12 items, and the `ACTION:` line —
but **no `── Previous session ──` block at all**, because the summary root it would
render is empty.

---

## 4a. The MCP server was running ten-day-old code

Worth recording separately, because it silently invalidates a class of evidence.

```
PID 1006, started Tue Jul 28 15:48:15 2026
  node ~/projects/tim/packages/tim-mcp/dist/server.js --http --port 3847
```

The MCP server loads `dist/` at process start. Rebuilding the branch does not affect a
server that is already running, so every `tim_*` MCP call made from an existing session
executes whatever `dist/` looked like when that process started — here, a build from ten
days before this branch existed.

This surfaced concretely: a `tim_update` that replaced an entry's `metadata` without a
`label` key left the old `label` in place, which the current code
(`packages/tim-store/src/store.ts:1917-1926`, `SYSTEM_FIELDS = ['verified_at',
'provenance']`) does not do. All subsequent repair work in this run therefore went through
the freshly built store API rather than MCP.

Practical consequence: **after deploying this branch, the MCP server must be restarted
before any MCP-based verification means anything.** A new session picks up a new server;
a long-lived one does not.

---

## 5. Blocker (resolved): `tim doctor` aborted before printing anything

```
$ tim doctor
Fatal: Project not found: P0066
```

No output at all, not even the header. This blocked the documented path for steps 3, 4 and
5 of the validation, including `tim doctor --repair-schema`, which is unreachable because
the crash happens first.

### Root cause

Two project entries carry `metadata.label = 'P0066'`:

| Entry id | Title | `irrelevant` |
|---|---|---|
| `ubun-0602-ns-01KT45TCMGYM8SPV2R98RDZFY5` | Hermes Agent — AI assistant by Nous Research… | **true** |
| `ubun-0605-ns-01KTCS6S56YV564SSC7069KCT6` | Upstream Hermes Agent fork — NousResearch/hermes-agent… | false |

Two lookup paths disagree about which one exists:

- `TimStore.resolveProjectLabel` (`packages/tim-store/src/store.ts:412-418`) filters
  `irrelevant = 0` and returns `{ status: 'found', label: 'P0066' }`.
- `TimStore.read`'s label fallback (`packages/tim-store/src/store.ts:250-252`) has **no**
  `irrelevant` filter and no `kind` filter. Its `.get()` returns the soft-deleted row,
  which line 260 then discards, so `read('P0066')` returns `null`.

`TimStore.requireProject` (`packages/tim-store/src/store.ts:543-557`) chains exactly those
two calls: it resolves the label successfully, then reads it back and gets `null`, and
throws at line 555. The throw propagates out of
`collectBindingReport` → `listProjectPathRows` → `store.requireProject`
(`packages/tim-hooks/src/project-binding-health.ts:95`,
`packages/tim-store/src/project-path-inventory.ts:17`) and kills `cmdDoctor` at
`packages/tim-cli/src/cli.ts:283` — before the first `console.log` on line 285.

Two further projects hit the same throw for a different reason: their `metadata.label`
is not a label at all, so `read`'s regex guard at `store.ts:249` (`/^[A-Z]\d{4}$/`) never
engages:

- `ubun-0619-ns-01KVFPYTFFVQF7X19FXB1EVBFB` — label `"P0066 Reminders"`
- `ubun-0607-ns-01KTHW9J7SDEE6TMBV85PMAKMV` — label `"TIM-Recovery-2026-06-07"`

Those two are instances of the already-tracked bug "tim_create_project mit explizitem
Label: content landet im Title" in P0063/Bugs.

### Not a regression from this PR

`collectBindingReport` entered `tim doctor` in commit `9dfc8bf`, which is an ancestor of
`origin/master`. The crash reproduces independently of the branch under test. This PR
neither caused it nor claims to fix it — but it does block validating the PR through the
documented CLI path.

`collectProjectSchemaReport` already guards each project with a `try/catch`
(`packages/tim-cli/src/project-schema-repair.ts:43-46`) for precisely this class of
failure. `collectBindingReport` has no such guard.

### Second half of the same bug

`read`'s label fallback also omits a `kind` filter, not just the `irrelevant` one. A
non-project entry carrying `metadata.label = 'P0066'` would shadow the project just as
effectively. That is what kept the crash alive after the first repair attempt: a fourth
Hermes duplicate, `ubun-0603-ns-01KT6JBYZV59FJW2YM7HVX07WD`, was invisible to both
`listProjects` and `resolveProjectLabel` (both filter `irrelevant = 0`) while `read` still
selected it.

### Full label-collision audit

Scanning P0000–P0200 with `findSystemRepairEntriesByLabelSync` — the one lookup that sees
soft-deleted rows — found **three** colliding labels, not one:

| Label | Entries | Subtree sizes |
|---|---|---|
| `P0062` | 2 live | **184 and 1552 nodes — both real** |
| `P0063` | 2 live + 1 soft-deleted | 494 nodes, plus two empty stubs |
| `P0066` | 1 live + 1 soft-deleted | 4 nodes, plus one empty stub |

`P0062` resolves today only by accident: one of the two entries has the literal entry id
`P0062`, so `read`'s by-id lookup (`store.ts:246`) hits before the label fallback ever
runs. That is a legacy hmem-shaped id, not a guarantee.

### Repairs applied

Data only, via the freshly built store API. No code changed, nothing committed.

| Entry | Was | Now | Why |
|---|---|---|---|
| `ubun-0619` Reminders | `P0066 Reminders` | **`P0066`** | matches `~/CLAUDE.md` and the reminder cron; the only one of the four with real content and children |
| `ubun-0605` Upstream Hermes fork | `P0066` | `P0074` | moved off P0066; aliases `hermes-agent` / `hermes-agent-fork` retained |
| `ubun-0602` Hermes Agent | `P0066` | `P0075`, `irrelevant=true` | empty superseded duplicate, 0 children |
| `ubun-0607` TIM-Recovery-2026-06-07 | `TIM-Recovery-2026-06-07` | `P0076`, `irrelevant=true` | empty artefact of a recovery run, 0 children |
| `ubun-0603-…VX07WD` Hermes Agent | `P0066` | `P0077`, `irrelevant=true` | empty soft-deleted duplicate that shadowed Reminders in `read` |

Each carries a `metadata.retired_note` explaining the change and its date.

Note on method: `metadata.label` cannot be removed through `tim_update` — the field is
carried through rather than dropped. Each entry was therefore given a unique free label
instead of having the label deleted, which reaches the same end (no collisions) by a
different route than the plan agreed with the operator.

**`P0062`'s two live trees carrying 184 and 1552 real nodes were deliberately left
untouched.** Merging them is a data-consolidation job with its own risk profile, not part
of validating this PR.

Result:

```
$ tim doctor
═══ TIM Doctor ═══
DB: /home/bbbee/.tim/tim.db
Entries: 10705 | Edges: 10896
Status: WARN
Broken links: 4690
Orphan entries: 101
FTS5: ✓
...
Summarizer:
  ✓ chain: curl-openrouter/anthropic/claude-sonnet-4.5 (+2 fallback(s))
```

42 projects, 0 `requireProject` failures. `tim doctor` runs end to end.

(Unrelated pre-existing warnings it now surfaces: 4690 broken links, 101 orphan entries,
`Hermes statusline: ✗ not fully installed`.)

---

## 6. Project schema report

Collected directly via `collectProjectSchemaReport`, bypassing the crashing `tim doctor`
front end. **All 43 projects report as needing repair.**

Shape of the finding:

- Almost all of it is additive: projects are missing between 15 and 25 schema sections
  each. A full-database repair would create roughly 850 new section entries.
- Only **one** project has mistitled sections — `P0071 Direct Test`, with 4:
  `Project activity log and milestones → Log`,
  `Architecture and project decisions → Decisions`,
  `Brainstorming and undecided proposals → Ideas`,
  `Actionable work items and open tasks → Tasks`.
- Custom sections outside the schema are reported as kept, as documented:
  `P0062` (Brief, Testing), `P0071` (Bug and error tracking, Lessons learned and
  pitfalls), `P0072` (History), `P0073` (Learnings, Testing), `P0066 Reminders`
  (Reminders-Section).
- Roughly 15 of the 43 are `[OBSOLETE]` or archived projects (P0029–P0046) that would
  each receive 25 fresh empty sections.
- The report also surfaces the label damage from section 5 as separate rows: `P0062`
  appears twice, `P0066` appears twice, and one row is labelled
  `TIM-Recovery-2026-06-07`.

### Not executed — `--repair-schema` would twin a populated section

Scope was narrowed to `--project P0063` alone. A dry run on that one project stops the
job:

```
created: ["Rules/Agent Rules", …, "Codebase", "Codebase/Modules", …]
renamed: []
unknown: []
```

`Codebase` is listed under **created**, but P0063 already has a section
`Codebase — Workspace-Struktur` holding 802 bytes of body and 12 children. Running the
repair would create a second, empty `Codebase` beside it.

That is precisely the twinning commit `4d7ac22` set out to prevent. The prevention has two
prerequisites, and this node meets neither:

- `packages/tim-store/src/project-schema-init.ts:57` —
  `if (child.metadata.kind !== 'section') continue;` builds the `byLabel` recovery index
  only from children with `kind === 'section'`. P0063's legacy sections have
  `kind === undefined`.
- `project-schema-init.ts:59` requires `metadata.label` to hold the section name.
  `Codebase — Workspace-Struktur` has no `metadata.label` at all.

So the retitle path at `project-schema-init.ts:111-118` never fires, and execution falls
through to `created` at line 120.

It also fails silently in the other direction: the `unknown` reporting loop skips
non-section children (`project-schema-init.ts:187`), so the operator gets no warning that
a populated node is about to be shadowed. The report says `custom (kept): —` for P0063
while a custom section with 12 children sits right there.

The consequence is worse than a stray empty node. `formatProjectOutput` renders by title,
and after a repair `byTitle.get('Codebase')` would resolve to the new empty section — so
the briefing would show an empty Codebase while 12 real children hang off a
differently-titled sibling.

**Stopped and reported rather than executed**, per the run's stop condition. The snapshot
is in place; nothing was written.

This generalizes: the 43-project report claims 15–25 missing sections each, but the same
detection gap means an unknown share of those "missing" sections already exist as
untitled/unlabelled legacy nodes. The report's `missing` count cannot be read as "safe to
add" until `indexChildren` also recognizes legacy sections that carry neither
`kind=section` nor `metadata.label`.

### The `where: "P00XX/Tasks"` check does pass

The other half of step 5 was run and succeeds without any schema repair:

```
tim_write(where: "P0063/Tasks", …)
  → parentId 01KT13N85TQDS8MAJCHVR8RRSK   (the existing Tasks section, 58 children)
  → ubun-0807-ns-01KZEGHVWQ2EV90NAP7ZSNNY7C
```

Section resolution by `P00XX/Section` shorthand works, and the content of P0063's sections
is where it was — nothing was displaced. The entry written is the validation task noted at
the end of this document.

Caveat: this call went through the MCP server, whose staleness is discussed in 4a. It
confirms the shorthand resolves against current data; it does not confirm current code.

---

## 7. Session-continuity test

Prerequisite verified: the SessionStart hook is installed in `~/.claude/settings.json`
and runs
`bash /home/bbbee/projects/tim/packages/tim-hooks/scripts/tim-session-start.sh`, which
shells out to `tim resolve-project --walk-up --cwd … --format directive`.

Baseline before the new chain has produced anything is recorded in section 4: the
directive currently renders no `── Previous session ──` block.

**Blocked. The chain is healthy, but nothing reaches it.**

The whole point of the exercise is a session that ends, gets summarized, and briefs its
successor. On this branch the first link is broken: exchanges are not being recorded.

### Nothing from today is in the database

```
sessions total: 206 | newest 5:
  2026-07-28T12:28:58Z | 019fa8b1-…  | exchanges=1
  2026-07-28T14:00:02Z | 98e3f332-…  | exchanges=1
  2026-07-29T04:50:18Z | cron_0b4a…  | exchanges=1
  2026-07-29T04:50:26Z | 019fac35-…  | exchanges=1
  2026-08-02T22:56:53Z | 3a1c4204-…  | exchanges=2

newest exchange: 2026-08-02T23:21:05Z
```

Today is 2026-08-07. This validation session ran roughly 30 turns in a directory with a
`.tim-project` marker and produced no session node at all until one was forced by hand.
Note also the shape of the history: recent sessions hold **one or two** exchanges each,
not the six to eight a real session generates.

With `batch_size: 5`, a session that records one exchange never fills a batch, never
produces a batch summary, and therefore has nothing for the rollup to condense. That is
the mechanism behind the 203 empty `session-summary-root` bodies in section 4 — the
rollup was not failing, it was being handed nothing.

### Cause 1: the transcript size guard

`packages/tim-hooks/src/claude-stop.ts:94`

```ts
if (!stat.isFile() || stat.size <= 0 || stat.size > maxBytes) return null;
```

with `MAX_TRANSCRIPT_BYTES = 1024 * 1024` (`claude-stop.ts:8`). Once a session transcript
crosses 1 MiB, every subsequent Stop hook returns `null` and silently records nothing.

Measured directly against `readLastExchange`:

| Transcript | Bytes | Over limit | `readLastExchange` |
|---|---|---|---|
| this session | 1 015 521 | no | OK |
| `01abcc0b-…` (25 Jul) | 1 608 816 | yes | **NULL** |

This session sat about 33 KB below the cutoff while the checks ran. Any substantial
working session crosses it early and goes dark for the remainder.

**This is the commit that was excluded from the validation:**
`c06e78d fix(hooks): read the transcript tail instead of bailing on size`, on
`fix/session-briefing-chain`. The branch under test does not contain it.

### Cause 1 is fixed — `c06e78d` cherry-picked

With operator approval, `c06e78d` was cherry-picked onto the validation branch as
`3d883f5`, followed by `npm run clean && npm run build`.

Suite after the cherry-pick: **184 files, 1529 passed, 2 skipped, 0 failed** — unchanged.

The guard at `claude-stop.ts:94` is replaced by a tail read
(`start = Math.max(0, stat.size - maxBytes)`), and the same measurement now gives:

| Transcript | Bytes | Before | After |
|---|---|---|---|
| `01abcc0b-…` (25 Jul) | 1 608 816 | **NULL** | OK — `user=47ch agent=1085ch` |
| this session | 1 106 942 | (was under limit) | OK — `user=6ch agent=1704ch` |

Large transcripts are read again. This is a real fix for a real defect, and it is not in
the PR as it stands.

### Cause 2: the hook does not land anything on its own — unresolved

Invoking the hook by hand works and is fast:

```
$ echo '{"session_id":"f8130261-…","transcript_path":"…","cwd":"/home/bbbee/projects/tim",
         "stop_hook_active":false}' | tim hook claude-stop
rc=0, 0.16–0.17 s   (Stop hook timeout in settings.json is 5 s — not a timeout)
```

That single manual call created the session node (`2026-08-07T16:15:15Z`) that ~30 turns
of this session had not. So the size guard was not the only thing wrong. The hook is
configured (`~/.claude/settings.json` → `Stop` → `tim hook claude-stop`), it is fast
enough, and it succeeds when invoked — but nothing accumulated automatically.

Tested directly: the exchange count was read, a full turn was allowed to complete, and the
count was read again. It stayed at 1 — the entry from the manual invocation. The harness
is not landing Stop-hook writes during this session.

`tim` resolves in hook context (the `UserPromptSubmit` hook's guard output did arrive at
session start), so this is not a bare-`tim`-not-on-PATH problem. Diagnosing it further
requires harness-side observation — a wrapper script logging each invocation — which is
outside the scope of validating this PR.

This is the remaining blocker, and it is **not** explained by anything in this PR.

Side observation while reading the logs: `~/.tim/summarizer.log` begins with a fragment of
the SessionStart hook's JSON envelope (`{"hookSpecificOutput":{"`), so something is writing
hook output into the summarizer log. Cosmetic, but it means that log is not a clean record.

### Correction: exchange logging itself is sound

Two earlier readings in this investigation were measurement errors on my part, and the
conclusions drawn from them do not hold:

- `readLastExchange` returns `{ user, assistant }`, not `{ userContent, agentContent }`.
  A probe using the wrong field names reported `user=0ch agent=0ch` on transcripts that
  actually parse fine.
- The written exchange looked empty because the agent node is stored as a **child of the
  user node**, not as a sibling (`packages/tim-store/src/session.ts:400-408`,
  `parentId = currentUser.id`), and a listing one level deep never saw it.

Read at the right depth, the single logged exchange is intact:

```
USER  seq=1 title="weiter" bodyLen=0
  AGENT role=agent bodyLen=1639
    **Fertig:** Deploy + Build + Tests (1529 grün, 0 rot), Snapshot, …
```

Short user text lands in the title with an empty body — that is how `writeSync(content, …)`
derives a title, not data loss. So the storage layer is fine; the 203 empty summary roots
are not caused by empty exchanges.

### What this means for the PR

The summarizer chain repaired by `fbcd525` is configured, healthy, and reachable —
verified against a live LLM in section 3. It still cannot be validated end to end, because
the stage before it delivers nothing automatically (cause 2). `tim doctor` reports
`✓ chain: …` while zero exchanges accumulate, which is the same false-green shape noted in
section 3.

Not run: the `/clear` and successor-session test. In this state it would produce a
`── Previous session ──` block that is empty for reasons unrelated to what the PR changed.

### The `/clear` test ran — the render half passes, the recording half does not (2026-08-07, later)

Everything above this heading was written while the chain was still broken. It is kept as
the record of the investigation. Part of its conclusion no longer holds; cause 2 does.

Four further defects were found and fixed on this branch (`ac97aa1`, `4e83b50`, `e69e997`,
plus `0deb23e`). The decisive one was that nothing ever called `maybeSpawnSummarizer` from
the Stop hook — it was wired only into the MCP server, which is not the writer of exchanges
under Claude Code. The full list is in the task node "Session-continuity chain" in
`P0063/Next Steps` and in `HANDOFF-next-session.md`.

**Separate the two halves, because only one of them was observed in the successor session.**

*Inherited from the previous session, per `HANDOFF-next-session.md`, not re-observed here:*
that session recorded exchanges, filled batch 1, and the Stop hook spawned the summarizer,
which wrote a 2092-char batch summary and a 733-char rollup. Its suite figure of
**1533 passed, 2 skipped, 0 failed** is likewise the handoff's number, not a fresh run.

*Observed directly in the successor session:* `/clear` ended the source session, and a fresh
session in the same directory received this at the top of its context with no manual step:

```
── Previous session (2026-08-07 · 7 exchanges) ──
- Done: Deploy/build/snapshot complete; `1532 passed, 2 skipped, 0 failed`. Fixed three hook/read bugs. Chain set: Codex `GPT 5.6 Luna (Max)` → OpenCode `DeepSeek V4 Flash Free (Max)`.
- Current: Stop-Hook records exchanges; rollup code intact. `114/125` batch summaries contain prose, but `203/204` root nodes remain empty. Changes uncommitted; no commit yet.
- Open: Add detached summarizer spawn after successful full-batch logging; verify model IDs/per-user config; fix duplicate irrelevant `P0066` blocking `tim doctor`; reassess schema repair and historical empty rollups. Exchanges `seq 1–4` already truncated.
- Next: Wire Stop-Hook summarizer spawn, then run E2E test: turn end → `/clear` → new session → `Previous session`.
```

That matches what `collectDirectiveBriefing` produced when queried directly, except for the
exchange count moving 6 → 7: the rollup covers batch 1 while the source session kept
running. The delivery path — `collectDirectiveBriefing` → `buildLoadDirective` →
`tim-session-start.sh` → harness context — is confirmed. It was the last unwitnessed link,
and it works.

### Cause 2 is not fixed: the successor session recorded nothing either

Checked in that same successor session, roughly seven turns in:

```
$ listProjectSessionsByActivity('01KSTQ4AB1B377S0ZXRKHQV59H', 6)   # P0063 root
f8130261-3b31-4843-8090-6c52c893417b   2026-08-07T17:26:40.402Z
20260615_151024_d82bd2                 2026-06-15T13:29:38.009Z
…
```

The newest non-empty session is still the *previous* one. `tim_read` on the successor's own
id returns `Entry not found` — no session node exists for it at all. `tim_resume_list`
reports the session as bound to the Inbox (`P0000`), not to `P0063`.

The hook is registered (`~/.claude/settings.json` → `Stop` → `tim hook claude-stop`,
timeout 5 s) and its siblings demonstrably fire: `SessionStart` delivered the briefing above
and `UserPromptSubmit` delivered its reminder lines, so `tim` resolves on `PATH` in hook
context. Invoked by hand with that session's real id and transcript path, the hook works and
is fast:

```
$ echo '{"session_id":"8d7da211-…","transcript_path":"…","cwd":"/home/bbbee/projects/tim",
         "stop_hook_active":false}' | tim hook claude-stop
rc=0, 0.16 s
```

and immediately produced the session node under P0063's sessions-root with
`exchange_count: 1`, `project_ref: P0063`. So the hook code, the marker walk-up, and the
store path are all sound — nothing is invoking them automatically.

Note where the failure has to sit. `ensureSessionForStop` (`claude-stop.ts:171-195`) creates
the session node *before* any exchange is logged, and `readLastExchange` returns the
second-to-last turn, so any turn after the first would have created a node. The node's total
absence means either the hook never executed, or it exited before
`claude-stop.ts:208`/`:216`. Discriminator run: with the node now in place,
`ensureSessionForStop` short-circuits at `:178`, so a firing hook would advance the counter.
Four further assistant turns left `exchange_count` at 1 and `updatedAt` unchanged. **The
hook is not executing.**

Confirmed independently: the harness records every Stop-hook run in the transcript as a
`stop_hook_summary` entry, so no wrapper script is needed. Comparing the two transcripts in
`~/.claude/projects/-home-bbbee-projects-tim/`:

| Session | SessionStart variants | `stop_hook_summary` records | exchanges recorded |
|---|---|---|---|
| `f8130261-…` (worked) | `startup` ×4, `compact` ×4 | **7** | 7 |
| `8d7da211-…` (failed) | `clear` ×4 | **0** | 0 |

The working session's records are clean —
`{"command":"tim hook claude-stop","durationMs":183}`, `hookErrors: []`,
`preventedContinuation: false`. Identical configuration, seven invocations in one session
and none in the other. `~/.claude/settings.json` has not been touched since 17:20 local,
which is *before* the session where the hook still worked. The one structural difference is
how each session began.

A confounder had to be ruled out first: the working session was also the *process-original*
session, so "started by `/clear`" was entangled with "started inside an already-running
process". Ordering the records in `f8130261`'s transcript separates them:

```
lines    4–7   SessionStart:startup
lines  645, 805, 840, 861   stop_hook_summary
lines  884–887  SessionStart:compact
lines 1169, 1315, 1363      stop_hook_summary
```

Three of the seven Stop runs come *after* a mid-process session restart. So a session
restart as such does not disable the hook, and "Stop fires only until the first restart" is
falsified. What distinguishes the two restarts is that compaction keeps the same session id
and the same transcript file, while `/clear` mints a new id and a new file.

**Hypothesis: the Stop hook stops firing once a running process moves to a new session id,
as `/clear` does.** That is precisely the flow session continuity depends on — `/clear` is
how a session ends and its successor begins — so the successor records nothing and can
never brief the session after it. Whether the trigger is the `clear` kind specifically or
any new session id mid-process cannot be separated from these two transcripts; both are
harness-side and have the same practical consequence.

Not established — it rests on one working and one failing session. Falsifying it costs one
`/clear`, a few turns, and a grep for `stop_hook_summary` in the new transcript. It may also
contribute to the 203 empty `session-summary-root` bodies, though section 7 already
attributes those to the 1 MiB size guard and the four other breaks, all of which predate
it. If it holds, the fix is a catch-up triggered from `SessionStart:clear` rather than
anything in `claude-stop.ts`. Filed in `P0063/Bugs` as "Stop hook never fires in sessions
started by /clear".

**Consequence for the PR:** the four commits are real fixes and the render path is proven,
but "session end → summary → briefing" is not yet a property this branch delivers on every
session. It has been observed working exactly once.

### Caveats that stand regardless

- Exchanges `seq 1–4` of the source session are stored truncated. They were recorded before
  `ac97aa1`, so the rollup summarizes damaged input.
- **The stale tail is not a rounding error — it actively misinforms the successor.** The
  spawn gate fires on `pending >= batch_size` and no `SessionEnd` hook is registered
  (`packages/tim-cli/src/claude-hooks-install.ts:69` registers SessionStart,
  UserPromptSubmit, Stop), so a session ending at 7 exchanges briefs its successor with a
  rollup covering the first 5. In the block above, two of four bullets were false by the
  time they were read: they reported the work uncommitted with "no commit yet" and named
  wiring the summarizer spawn as the next step, when both were already done. A successor
  that trusts its brief redoes finished work. This is the argument for the `SessionEnd`
  hook.
- The 118 phantom session nodes are still in the database, and `e69e997` only filters them
  out of `listResumableSessions`. `tim_load_project`'s "Recent Sessions" render still lists
  five `0 exchanges` nodes as the newest.

---

## 8. Viewer

```
$ tim viewer --port 7373
TIM viewer (read-only) → http://127.0.0.1:7373/
  database: /home/bbbee/.tim/tim.db
  secrets:  redacted (structure only) — pass --show-secrets to render them
```

`ss -lntp` confirms it binds `127.0.0.1:7373` only. Used it to cross-check the label
repair independently of the store API:

```
$ curl -s http://127.0.0.1:7373/api/projects | jq …
P0063 | TIM — Theoretically Infinite Memory …         | children=27
P0066 | # P0066 Reminders — Persönlicher Sekretär     | children=1
P0074 | Upstream Hermes Agent fork — NousResearch/…   | children=1

$ curl -s "http://127.0.0.1:7373/api/children?id=01KSTQ4AB1B377S0ZXRKHQV59H" | jq …
Codebase — Workspace-Struktur | chars=802 | children=12
```

Exactly one Codebase section, content and children intact, and the reassigned labels
resolve as intended. Routes are `/api/stats`, `/api/projects`, `/api/children?id=…`,
`/api/node` (`packages/tim-cli/src/viewer-server.ts:83-113`).

Reachable over an SSH tunnel with `ssh -L 7373:127.0.0.1:7373 bbbee@<host>`.

---

## Open items for the operator

1. **`tim doctor` crash class is unfixed in code.** The data is repaired, so doctor runs
   again, but the next duplicate or malformed label reproduces it. The narrow fix is a
   `try/catch` per project in `collectBindingReport`
   (`packages/tim-hooks/src/project-binding-health.ts:82-110`), matching what
   `collectProjectSchemaReport` already does. The deeper fix is aligning `read`'s label
   fallback (`store.ts:250-252`) with `resolveProjectLabel` (`store.ts:412-418`) on both
   `irrelevant` and `kind`. Not applied — no code was changed in this run.
2. **`P0062` has two live project trees** with 184 and 1552 real nodes. Needs a merge
   decision.
3. **`--repair-schema` should not be run on this database** until `indexChildren`
   recognizes legacy sections lacking `kind=section` / `metadata.label`. See section 6.
4. **P2 (`tim resummarize`) needs a different trigger than the failure marker.** The
   damage in this database is 203 empty `session-summary-root` bodies, which carry no
   marker. A marker-driven command would find nothing.
5. **`DEFAULT_SUMMARIZER_CHAIN` still mirrors `DEFAULT_REMEMBER_CHAIN`** (P5 in
   OPEN-POINTS). The chain that actually works here is `curl-openrouter`-based; the
   default still guesses `opencode` + Anthropic/DeepSeek/Moonshot, and `opencode` is
   installed but failing on this host.
6. **Restart the MCP server** after deploying, or MCP-based checks keep running old code.
7. **Stashed work** from `fix/session-briefing-chain` is still on the stash
   (`pre-validation: skill md + tsbuildinfo`), and that branch's three commits are not in
   what was validated.
8. **A session's last partial batch is never summarized.** No `SessionEnd` hook is
   registered, so the tail exchanges of every session are dropped from the briefing. See
   section 7's resolution note.
9. **118 phantom session nodes remain in the database**, and the render used by
   `tim_load_project` still shows them. `e69e997` fixed only the resumable-sessions query.
10. **Cause 2 is still live and is now the top item.** The Stop hook records nothing
    automatically; it works only when invoked by hand. Until that is understood, the chain
    briefs a successor only by luck. Diagnosing it needs a wrapper script around
    `tim hook claude-stop` that logs every invocation with its stdin — harness-side
    observation, which no amount of reading `claude-stop.ts` replaces. See section 7.
