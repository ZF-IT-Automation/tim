# JOURNAL — Start-Hook (TIM project auto-load)

## Done (Tasks 1–8)

1. **Task 1** — `findMarker` walk-up, `buildLoadDirective`, `MarkerLocation`; re-exported from `tim-hooks/index.ts`; 6 new marker tests
2. **Task 2** — `resolveSessionProjectId` uses `findMarker` instead of `detectProject`; parent-marker subdirectory test
3. **Task 3** — CLI `resolve-project` + `bind-project` (store-free); 5 CLI tests
4. **Task 4** — `tim-session-start.sh` Hermes `pre_llm_call`; symlink `~/.hermes/agent-hooks/`; `config.yaml` second hook
5. **Task 5** — `tim-claude-session-start.sh`; `~/.claude/settings.json` SessionStart entry
6. **Task 6** — `tim-cursor-inject.sh` (orchestrator prepends directive); cursor-agent has no SessionStart — path B only
7. **Task 7** — `o9k-session-start` SKILL: TIM marker directive branch (authoritative, before "brief present")
8. **Task 8** — `o9k-handoff` SKILL: Step 2.5 `bind-project` marker refresh

## Decisions

1. **TIM marker authoritative** — when `📍 TIM project marker` directive present, agent calls `tim_load_project(label=…)` once; skips hmem cwd→project resolution even if o9k-startup context also present
2. **Walk-up in Node** — shell hooks thin; `findMarker` cross-platform
3. **Corrupt nearest marker → null** — do not fall back to ancestor (explicit test)
4. **Hermes `pre_llm_call` not SessionStart** — gate on `extra.is_first_turn`; inject `{"context":…}` into user message
5. **No store in hook path** — `resolve-project` / `bind-project` never open TimStore (10s timeout safe)
6. **Subagent guard** — `.parentUuid` / `parent_session_id` → `{}`; Hermes has no parent field today (no-op)

## Edge Cases

1. **No marker** — resolve-project exits 0 empty; hooks emit `{}`; session → Inbox P0000 (intended first-time base case)
2. **Nearest wins** — child `.tim-project` overrides parent
3. **`/tmp/.tim-project`** — pollutes walk-up for tests/cwd under `/tmp`; session-start hook test moved to `~/.tim-test-runs/`
4. **Handoff P0000** — skip Step 2.5 (no project to pin)
5. **bind-project** — preserves session/exchanges/batch counters; only changes `project`

## Gotchas

1. **Build order** — `tsc -b` needs `tim-hooks` built before `tim-cli` picks up new exports
2. **Hermes allowlist** — `tim-session-start.sh` added to `~/.hermes/shell-hooks-allowlist.json` (required or hook skipped at runtime)
3. **Machine state not in repo** — `config.yaml`, skills under `~/.hermes/skills/`, Claude `settings.json`, symlink, allowlist
4. **Plan filename** — hook is `tim-session-start.sh` (not `tim-project-inject.sh`)

## Subagent probe (Hermes)

- `is_first_turn = not conversation_history` (`conversation_loop.py:555`) — subagents with history should not get first-turn injection
- `.parentUuid` guard is Claude-only today; documented low-risk if Hermes adds subagent first-turn later

## Verification

```bash
cd /home/bbbee/projects/tim
npx tsc -b                    # clean
npm test                      # 154 passed
npx vitest run packages/tim-hooks/src/__tests__/marker.test.ts
npx vitest run packages/tim-cli/src/__tests__/resolve-project.test.ts

TMP=$(mktemp -d)
echo '{"project":"P0063","session":"s","exchanges":0,"batch_size":5,"batches_summarized":0}' > "$TMP/.tim-project"
node packages/tim-cli/dist/cli.js resolve-project --cwd "$TMP"
node packages/tim-cli/dist/cli.js bind-project --cwd "$TMP" --label P0063
printf '{"cwd":"%s","extra":{"is_first_turn":true}}' "$TMP" | bash ~/.hermes/agent-hooks/tim-session-start.sh
hermes hooks doctor && hermes hooks test pre_llm_call
```

Plan: `docs/start-hook-plan.md`

---

# JOURNAL — Session tracking + summarization (Tasks 1–11 + P0000 Inbox)

## Done

1. **Task 1** — `TimStore.getChildByKind`, `getChildrenBySeq` (kind filter + seq order)
2. **Task 2** — `session-tree.ts` constants, `deriveCounters`, `findChildByKind`, `ensureInboxProject`
3. **Task 3** — `SessionManager.startProjectSession` (Sessions/Summary/Exchanges subtree, order 1000)
4. **Task 4** — `logExchange` (user seq only, agent child of user)
5. **Task 5** — `showUnsummarized` (DB-derived batch skip via Batch count)
6. **Task 6** — `writeBatchSummary` (idempotent by batch_index), `rollUpSession` (explicit title on update)
7. **Task 7** — `getSessionExchanges` tree-aware + legacy flat fallback
8. **Task 8** — `project-output.ts` excludes `sessions-root` from Sections list; rollup unchanged
9. **Task 9** — MCP: `projectId`/`batchSize` on start, nested `session_log` routing, `tim_show_unsummarized`, cortex `depth:3`
10. **Task 10** — `tim-hooks/marker.ts` read/write/reconcile/lock
11. **Task 11** — `tim-hooks/session-hooks.ts` `onSessionStop` detached spawn
12. **P0000 Inbox** — `ensureInboxProject`, default bind when no `projectId` (MCP + hooks), `render_depth:1`, schema Sessions section

## Decisions

1. **DB tree authoritative** — `deriveCounters` counts user nodes + Batch nodes; marker/metadata are caches reconciled in `reconcileMarker`
2. **No `loadProject` render_depth gate** — default `depth:3` keeps raw exchanges unloaded (D2); optional Task 12 not done
3. **Legacy flat sessions preserved** — `sessionStart`/`sessionLog` unchanged; project path is additive
4. **MCP never touches `.tim-project`** (D4) — marker only in `tim-hooks` (`runSessionStart` writes, `onSessionStop` reads)
5. **Unbound → P0000** — MCP: `projectId ?? getActiveProjectLabel() ?? P0000`; hooks: marker → active file → P0000
6. **MCP `tim_session_start` always project-bound** when `projectId` or inbox/active resolved (no flat root via MCP anymore for default start)
7. **`writeBatchSummary` single atomic write** — idempotency = existing `batch_index` under Summary
8. **Lock held until summarizer exits** — `rm -f` in spawned command; `LOCK_TTL_MS` reclaims stale locks

## Edge Cases

| Case | Behavior |
|------|----------|
| Crash before Batch write | `batches_summarized` unchanged → re-spawn on next Stop |
| Stale marker counters | `reconcileMarker` overwrites from DB before spawn decision |
| Duplicate batch_index | `writeBatchSummary` returns existing node |
| Two Stop events | second `acquireLock` → `{reason:'locked'}` |
| Agent before user | agent under Exchanges directly; not counted in `exchange_count` |
| `tim_load_project(depth:5)` | loads raw exchanges (accepted D2) |
| `showUnsummarized` on legacy session | throws (no Exchanges/Summary subtree) |
| Project label in tests | must match `/^[A-Z]\d{4}$/` for `read('P0099')` fallback — use P0002 not P2 |
| `rollUpSession` multi-line | pass explicit `title: SUMMARY_NODE_TITLE` on update or first line dropped |
| Orphan agent in `logExchange` | `currentUser` null → parent Exchanges |

## Gotchas

1. **Project read by label** — `store.read('P0062')` works via label fallback only for `P` + 4 digits
2. **P0000 id** — explicit `id: 'P0000'` on `ensureInboxProject` write (not ulid)
3. **`checkpoint` summarizer** — use `e.content \|\| e.title` (title/body split)
4. **`runSessionStart` always nested** — writes `.tim-project` marker to `cwd`; changes hook integration tests expectations
5. **`runSessionEnd`** — calls `onSessionStop` before legacy `checkpoint` (flat sessions still checkpoint; spawn only if marker)
6. **Rebuild** — `npx tsc -b` from repo root
7. **Hook tests temp dirs** — under `/home/bbbee/.tim-test-runs` (no `/tmp`)
8. **Pre-existing failures** — `export.test.ts`, some `events.test.ts`, `render_override` empty-section test may still fail (title-column migration); session task tests green

## Files Touched

| Package | Files |
|---------|-------|
| tim-store | `store.ts`, `session.ts`, `session-tree.ts`, `project-output.ts`, `index.ts`, tests |
| tim-mcp | `server.ts` |
| tim-hooks | `marker.ts`, `session-hooks.ts`, `checkpoint.ts`, `index.ts`, tests |
| docs | `project-schema.json` (Sessions section) |

## Verify

```bash
cd ~/projects/tim && npx tsc -b
npx vitest run packages/tim-store/src/__tests__/session.test.ts packages/tim-store/src/__tests__/project-output.test.ts packages/tim-hooks/src/__tests__/marker.test.ts packages/tim-hooks/src/__tests__/session-hooks.test.ts
```

## MCP smoke

- `tim_session_start({ sessionId, projectId: "P0062" })` → nested tree
- `tim_session_start({ sessionId })` → binds P0000 Inbox
- `tim_session_log` → routes to `logExchange` when `exchanges-root` exists
- `tim_show_unsummarized({ sessionId })` → batch payload for summarizer

---

## COMPLETE — 2026-06-01 (final wrap-up)

**Status:** Tasks 1–11 + P0000 Inbox **done**. Optional Task 12 (`loadProject` `render_depth:0` gate) **not** implemented (per plan D2).

### Final verification

| Check | Result |
|-------|--------|
| `npx tsc -b` | **clean** (exit 0) |
| `session.test.ts` | **21/21** pass |
| `project-output.test.ts` | **1/1** pass |
| `marker.test.ts` | **5/5** pass |
| `session-hooks.test.ts` | **3/3** pass |
| `hooks.test.ts` | **9/9** pass |
| `store.test.ts` (session helpers) | **2/2** `getChildByKind` / `getChildrenBySeq` pass |
| `store.test.ts` (unrelated) | 1 pre-existing fail: `render_override` empty-section skip — title-column migration, **out of scope** |

**Session-scope total:** 41/41 green.

### Handoff for next agent

1. Wire Stop hook in harness config → call `onSessionStop(store, cwd)` from `tim-hooks` on session end (if not already in o9k hooks JSON).
2. Summarizer prompt in `session-hooks.ts` uses generic `tim_write` — confirm summarizer agent has MCP write + `tim_show_unsummarized` tools.
3. Optional Task 12 only if hard guarantee needed that `tim_load_project(depth:5)` never loads raw exchanges.
4. Rebuild published packages before release: `npx tsc -b` then publish `tim-store`, `tim-hooks`, `tim-mcp` in dependency order.

### Plan reference

Full spec: `docs/session-system-plan.md`

---

# JOURNAL — Exchange batch grouping under Exchanges

## Done

1. **`KIND_EXCHANGE_BATCH`** — `'exchange-batch'` kind under `exchanges-root`
2. **`getCurrentBatch()`** — latest batch via `getChildByKind` order; auto-creates Batch 1 if missing; children via `getChildrenBySeq`
3. **`startProjectSession`** — writes Batch 1 under Exchanges on create
4. **`logExchange`** — uses `getCurrentBatch`; new batch when `usersInBatch.length >= batch_size`; exchanges parent = batch node
5. **`showUnsummarized`** — `batch_index = batchesSummarized + 1`; returns batch children directly (no seq math)
6. **`deriveCounters`** — walks exchange-batch nodes; counts user nodes per batch; skips empty trailing batch
7. **Tests** — batch on start, split on full, showUnsummarized skip, deriveCounters batch grouping

## Decisions

1. **Two batch kinds** — `exchange-batch` (raw under Exchanges) vs `batch-summary` (summaries under Summary)
2. **Batch order** — `metadata.order` + `batch_index`; `getChildByKind` sorts by order
3. **User seq global** — monotonic across all batches (not per-batch)
4. **New batch trigger** — only on incoming **user** msg when current batch full (not after agent)
5. **`getCurrentBatch` shared** — logExchange + legacy sessions missing batch node both use same helper

## Edge Cases

| Case | Behavior |
|------|----------|
| Session start | empty Batch 1 pre-created; `exchange_count=0` |
| Empty trailing batch | `deriveCounters` skips last batch if zero users |
| No batch node (legacy) | `getCurrentBatch` creates Batch 1 on first log |
| Agent before user | agent under batch node directly; not in exchange_count |
| All batches summarized | `showUnsummarized` returns empty exchanges, batchIndex = N+1 |

## Verify

```bash
cd ~/projects/tim && npx tsc -b
npx vitest run packages/tim-store/src/__tests__/session.test.ts
```

**2026-06-01:** tsc clean, 23/23 session tests pass.

---

# JOURNAL — Entry ID session prefix + batch rebalance

## Done

1. **Task 2** — `entry-id.ts`: `formatEntryId` → `{device}-{MMDD}-{session_short}-{ulid}`; `session_short` from `metadata.sessionId` / `session_id`, else `ns`; wired in `TimStore.write()`
2. **Task 3** — `tim-hooks/rebalance.ts`: `rebalanceBatch(store, sessionId)` boundary keyword overlap → move user+agent; guards single-exchange batch + `isSessionLocked`
3. **CLI** — `tim rebalance --session <id> [--cwd]`
4. **Tests** — `entry-id.test.ts`, `rebalance.test.ts` (4), store id format assertion

## Decisions

1. **Keywords from exchange text** — title+body tokenize (≥4 chars, stopwords); batch-summary nodes not required at boundary
2. **Lock = read-only** — `isSessionLocked` checks marker lock; rebalance does not acquire lock
3. **Move via curate** — `moveEntry` reparents user + agent into previous `exchange-batch`

## Edge Cases

| Case | Behavior |
|------|----------|
| No session in metadata | `ns` segment |
| Batch N has 1 user | skip (`single-exchange-batch`) |
| Active `.tim-project.lock` | `{ moved: 0, reason: locked }` |
| Unrelated boundary | skip (`unrelated`) |

## Verify

```bash
cd ~/projects/tim && npx tsc -b
npm test
npx vitest run packages/tim-store/src/__tests__/entry-id.test.ts packages/tim-hooks/src/__tests__/rebalance.test.ts
```

---

# JOURNAL — Commit-Subnode auto-fill (4 tasks)

## Done

1. **Task 1 — Store** — `commit-tree.ts` constants + `CommitManager.recordCommit()` in `commit.ts`; ensures Commits section (order 1100); idempotent by `commit_hash`; session links via `relates` / `implements`
2. **Task 2 — CLI** — `tim record-commit` + `git-commit.ts` (reads HEAD via git when flags omitted); silent skip when no `.tim-project`
3. **Task 3 — MCP** — `tim_record_commit` tool
4. **Task 4 — Hook** — `packages/tim-hooks/scripts/tim-post-commit.sh`; template `scripts/git-hooks/post-commit`; installed at `~/projects/tim/.git/hooks/post-commit`

## Decisions

1. **Title = full hash, body = message + `--stat`** — matches `project-schema.json` Commits section
2. **Hook silent skip** — no marker → exit 0 (same as session-start)
3. **Session from marker** — `.tim-project.session` auto-linked when present
4. **Idempotent** — re-commit / amend re-run returns existing node

## Edge Cases

| Case | Behavior |
|------|----------|
| No `.tim-project` | CLI/hook exit 0, no write |
| Duplicate hash | return existing commit node |
| sessionId invalid/missing | commit written, no edges |
| Not a git repo + no `--hash` | CLI error exit 1 |
| Detached HEAD | branch metadata = `HEAD` |

## Verify

```bash
cd ~/projects/tim && npx tsc -b
npx vitest run packages/tim-store/src/__tests__/commit.test.ts packages/tim-cli/src/__tests__/record-commit.test.ts
node packages/tim-cli/dist/cli.js record-commit --cwd ~/projects/tim --hash test --message "dry"  # needs marker + project in DB
```

Schema ref: `docs/project-schema.json` Commits section


# JOURNAL — Summarizer-Agent completion (3 gaps)

## Done

1. **GAP 1 — live trigger** — `SessionManager.setOnBatchFull()`; `logExchange` fires on batch roll; `tim-mcp` wires `maybeSpawnSummarizer(..., { batchFull: true })` using session `metadata.cwd`
2. **GAP 2 — spawn hardening** — `maybeSpawnSummarizer` shared by `onSessionStop` + live path; `buildSummarizerCommand` → `npx tim-summarizer` (no `claude -p`); EXIT trap lock release; `timeout` default 600s; `.tim/summarizer.log`; spawn errors logged + lock released
3. **GAP 3 — MCP tool** — `tim_write_batch_summary` → `writeBatchSummary`; metadata adds `summarized_at`; tags `#session-summary` + `#batch-summary`
4. **Package** — `packages/tim-summarizer` CLI loop: `tim_show_unsummarized` → `generateSummary` → `tim_write_batch_summary`

## Decisions

1. **Store stays cwd-agnostic** — spawn only in tim-mcp / tim-hooks, not `session.ts`
2. **Heuristic default** — no API key → compact local summary; `ANTHROPIC_API_KEY` optional for LLM
3. **`batchFull` flag** — live trigger skips pending threshold; session-stop keeps threshold gate

## Gotchas

1. **Lock** — shell EXIT trap releases `.tim-project.lock`; stale lock TTL still 10min in `marker.ts`
2. **MCP child** — summarizer spawns `npx tim-mcp` stdio client; needs built `tim-mcp` + `tim-summarizer` on PATH
3. **batchFull test** — reconciled `exchanges` from DB may be 1 with one user; `batchFull` still spawns

## Verify

```bash
cd ~/projects/tim && npm install && npx tsc -b
npm test
npx vitest run packages/tim-store/src/__tests__/session.test.ts packages/tim-hooks/src/__tests__/session-hooks.test.ts packages/tim-summarizer/src/__tests__
```


# JOURNAL — Design: .tim-project multi-session routing fix (2026-06-02, DESIGN ONLY)

## Root cause
Post-hook `o9k-log-exchange.sh` ignores the `.session_id` already in its own stdin payload and instead routes via the **global** `~/.tim-project` `route_exchanges_to` — a singleton, last-write-wins. Two parallel sessions binding different projects clobber it → exchanges misroute or drop (`sessions[route]` empty → exit 0). Key fact: the Hermes `session_id` (e.g. `20260602_155620_ee0929`) is in **both** hook payloads (`shell_hooks.py:478`) and is adopted *verbatim* as the TIM session id (`cli.ts:226`). So the live session is already uniquely identified at log time.

## Chosen fix — route by the id the hook already holds
In `o9k-log-exchange.sh` (Hermes hook, `~/projects/hmem/hermes-hooks/`): read `.session_id`; precedence (1) local `.tim-project` cwd-walk for in-project sessions, (2) use `.session_id` directly as the TIM session id. Remove `route_exchanges_to` from the logging path. Keep existing "no session → exit 0" guard.

## Why this beats all three proposed alternatives
- Logging hot path no longer reads/writes the shared global map → **no lost-update race, no lock, no per-session files, no contention** under the 30s hook timeout.
- session→project array / multi-entry sessions map / `.tim-project.<id>` files all solve a routing problem that evaporates once the hook uses its own payload id; they'd add the very RMW/lock/cleanup complexity we can avoid.
- Backward-compat: `sessions` map + `route_exchanges_to` stay (used by `tim-session-start.sh` for out-of-cwd binding injection) but are no longer authoritative for logging.

## Scope & caveats
- ~5-line change to one shell hook. **No TIM TS change, no harness plumbing** (id already passed). Optional honesty fix: add `sessions?`/`route_exchanges_to?` to `ProjectMarker` (`marker.ts`).
- Verify in impl: `tim-session-start.sh` starts/refreshes the TIM session for the live `session_id` before the first post-hook (`is_first_turn` gate); keep graceful no-op if the id has no project-bound TIM session.
- File distinction: race is on **global** `~/.tim-project`; project-scoped `.tim-project` (cwd) is untouched and remains the in-project routing source.


# JOURNAL — Impl: .tim-project multi-session routing fix (2026-06-03)

## Done

1. **`o9k-log-exchange.sh`** — resolve session: (1) cwd-walk `.tim-project.session`, (2) payload `.session_id`. Dropped `route_exchanges_to` / `sessions[]` lookup on log path.
2. **`tim_load_project`** — after `loadProject`, `startProjectSession` rebinds `project_ref` when `sessionId` known (`sessionId` arg → `TIM_SESSION_ID` → local marker `.session`). Global `~/.tim-project` still gets `route_exchanges_to` + `sessions[label]` for `tim-session-start.sh` directive only.
3. **`startProjectSession`** — existing session: update `project_ref` if label changed (no tree move).
4. **`ProjectMarker`** — optional `route_exchanges_to`, `sessions` for global marker typing.

## Decisions

- Log path **never** reads global singleton for routing — hook payload id is authoritative for out-of-cwd Hermes (~).
- `tim_load_project` rebind needs session id from env/marker/arg; MCP stdio has no Hermes session in request — `TIM_SESSION_ID` or first-turn marker fill gap.
- Physical session node stays under original project's `Sessions` section on mid-switch; `project_ref` metadata drives summarizer/checkpoint context. Tree move deferred (high blast radius).

## Edge cases

- `tim hook log` with unknown session id → CLI/store error swallowed in hook (`|| true`) — same as before when `sessions[route]` empty.
- Parallel sessions same project label → both log to distinct session ids; `sessions[P0062]` in global marker is last `tim_load_project` only (directive hint, not log route).
- Local `.tim-project.session` overrides payload id — intentional for in-repo dev sessions with explicit marker session field.
- `startProjectSession` rebind without `sessionId` in `tim_load_project` → brief only, no DB rebind (agent must have run session-start first or pass id).

## Gotchas

- Hermes hook lives in **`~/projects/hmem/hermes-hooks/`** — symlink to `~/.hermes/agent-hooks/` if deploy uses copy.
- Rebuild `tim-mcp` / `tim-store` before MCP picks up `tim_load_project` rebind.
- `tim-session-start.sh` unchanged — first turn still starts TIM session + updates global `sessions` map; logging no longer depends on it.

## Verify

```bash
cd ~/projects/tim && npx tsc -b
npx vitest run packages/tim-mcp packages/tim-hooks packages/tim-store/src/__tests__/session.test.ts
```
Manual: two Hermes sessions in `~`, bind P0062 vs MAIMO, exchange each — check TIM DB session ids get correct `project_ref` and exchanges under right session nodes.


# JOURNAL — Impl: tim statusline + marker test isolation (2026-06-03)

## Done

1. **`tim statusline`** — `packages/tim-cli/src/statusline.ts` + CLI case. Stdin JSON → `cwd` / `workspace.current_dir` → `findMarker` → one line: `P00XX · n/BATCH exchanges · summary in K`.
2. **`~/.claude/settings.json`** — `statusLine.command` → TIM CLI; `timeout: 3`.
3. **Marker test isolation** — `findMarker(cwd, { maxRoot })` stops walk before `/tmp/.tim-project` or `~/.tim-project`. Tests use `/tmp/tim-test-runs` + `maxRoot: dir`. CLI tests set `TIM_MARKER_MAX_ROOT`.

## Decisions

- **K (summary in)** — `batch_size - (exchanges % batch_size)`; at boundary (`exchanges > 0`, mod 0) → `summary in 0`; at zero exchanges → `summary in batch_size`.
- **Display n** — `exchangesInCurrentBatch` (mod; full batch shows `B/B` at boundary).
- **No marker** — plain `no project` (no ANSI; hmem used colors — TIM kept minimal for 3s timeout).
- **maxRoot** — production unset; test-only via arg or `TIM_MARKER_MAX_ROOT` env (not documented in user help — test harness).

## Edge cases

- Corrupt nearest marker → `no project` (findMarker returns null).
- `batch_size` missing/0 in marker → treat as 5 in formatter.
- Cwd-less stdin → `process.cwd()` for marker walk.
- `/tmp/.tim-project` on machine pollutes any cwd under `/tmp` without maxRoot — real footgun for ad-hoc /tmp workdirs.

## Gotchas

- Rebuild `packages/tim-cli/dist` after pull; Claude settings point at dist path.
- Statusline reads **marker cache** (`exchanges` field), not live DB — stale until reconcile/checkpoint updates marker.
- `detectProject` only reads exact cwd file (no walk) — unaffected by global markers.

## Verify

```bash
cd ~/projects/tim && npx tsc -b && npx vitest run packages/tim-cli packages/tim-hooks/src/__tests__/marker.test.ts
node packages/tim-cli/dist/cli.js statusline <<< '{"cwd":"/path/with/.tim-project"}'
```

---

# JOURNAL — Global post-commit hook (2026-06-03)

## Done

1. **`record-commit.ts`** — extracted from `cli.ts`; `cmdRecordCommit` unchanged behavior
2. **`post-commit.sh`** — `resolve_tim_cli`: `TIM_CLI` → `tim` on PATH → `../../tim-cli/dist/cli.js`; errors swallowed
3. **Global install** — `~/.hermes/git-hooks/post-commit` → script; `git config --global core.hooksPath`
4. **`tim-post-commit.sh`** — thin exec wrapper (back-compat)
5. **Test** — record-commit idempotent CLI test (+1 → 233 total)

## Decisions

- **Global hooksPath only** — repo `.git/hooks/post-commit` ignored when global set; one hook dir for all repos
- **Hook never fails commit** — `|| true` + exit 0 always
- **Dev fallback** — monorepo `dist/cli.js` when `tim` not on PATH

## Edge cases

| Case | Behavior |
|------|----------|
| No `.tim-project` | silent exit 0 |
| Duplicate hash | idempotent, first message kept |
| Not git repo | hook exit 0 (rev-parse fails) |
| `tim`/`node` missing | resolve fails → exit 0 |

## Gotchas

- **Global hooksPath replaces all local hooks** — only `post-commit` in `~/.hermes/git-hooks` unless more symlinks added
- Rebuild `tim-cli` after pull; hook uses `dist/cli.js` fallback
- P0063 marker in tim repo — commits record to that project's Commits section

## Verify

```bash
cd ~/projects/tim && npx tsc -b && npm test   # 233 pass
bash packages/tim-hooks/scripts/post-commit.sh
sqlite3 ~/.tim/tim.db "SELECT title FROM entries WHERE json_extract(metadata,'$.commit_hash')=substr('$(git rev-parse HEAD)',1,40)"
```


# JOURNAL — Impl: statusLine fix + project aliases (2026-06-03)

## Bug 1 — Claude statusLine

**Root cause:** `timeout: 3` on `statusLine` is invalid — Claude docs use `refreshInterval` (seconds), not `timeout` (hooks-only). Bad field likely dropped whole statusLine config.

**Fix:**
- Removed `timeout` from `~/.claude/settings.json`
- Wrapper `tim-hooks/scripts/tim-statusline.sh` (bash + stderr silenced) like hmem
- `readStatuslineInputSync()` via `fs.readFileSync(0)` — async stdin missed short pipes
- Trailing newline on stdout

## Feature 2 — Project aliases

- `tim-core/project.ts` — `ProjectMetadata.aliases`, `ResolveProjectResult`
- `TimStore.resolveProjectLabel()` — direct label → alias scan
- `tim_load_project` — ambiguous / not-found messages per spec
- `tim_create_project` — `aliases: string[]` (stored lowercase)

## Verify

```bash
npx tsc -b && npx vitest run packages/tim-store packages/tim-cli packages/tim-hooks
printf '{"workspace":{"current_dir":"~/projects/tim"}}' | bash packages/tim-hooks/scripts/tim-statusline.sh
```

Claude: restart / new message after settings change — statusLine reloads on next interaction.


# JOURNAL — Hermes status bar (TIM package) (2026-06-03)

## Correction

Statusline target is **Hermes TUI**, not Claude `statusLine`. Hermes has no settings.json statusLine hook.

## Mechanism (matches hmem)

1. **`tim-hermes-session-cache.sh`** — `pre_llm_call`, writes `~/.tim/.session-cache`, returns `{}`
2. **`tim-hermes-statusline.sh`** — Hermes patched `cli.py` calls via subprocess → JSON stdout
3. **`hermes-cli-tim-statusline.patch`** — `_get_tim_status()` in Hermes CLI
4. **`tim statusline --format hermes`** — `--cwd`, `--session` for marker or TIM DB fallback

`pre_llm_call` `{context:...}` = prompt injection only (`tim-session-start.sh`), not status bar.

## Install

See `packages/tim-hooks/scripts/README-hermes-statusline.md`. Reverted `~/.claude/settings.json` statusLine to hmem.

## Gotchas

- Hermes CLI patch required — stock Hermes has no status script hook
- If hmem patch already applied: point script to `tim-hermes-statusline.sh` or merge patches
- Cache TTL 1h in statusline script; cache hook runs every turn

## Setup command

`tim setup-hermes-statusline` — idempotent install (symlinks, config.yaml, programmatic cli.py patch, optional tsc). **Gotcha:** inject before `@staticmethod\n    def _status_bar_display_width` — inserting only at `def _status_bar_display_width` steals `@staticmethod` onto `_get_tim_status` and breaks Hermes TUI (`_status_bar_display_width() takes 1 positional argument but 2 were given`). `isHermesCliBroken()` + repair path in patcher.


# JOURNAL — Impl: tim-session-start race fix (2026-06-03)

## Done

1. **`tim resolve-session`** — `--session <id>` reads TIM DB → `metadata.project_ref`; formats `label|directive|json`. Directive via `buildSessionDirective` (TIM store, not `.tim-project` path).
2. **`tim-session-start.sh`** — resolve order: (1) cwd-walk `.tim-project`, (2) `resolve-session` from payload `session_id`. Removed `route_exchanges_to` read + global `~/.tim-project` sessions-map writes.
3. **`o9k-session-start` SKILL** — STEP 1 covers `📍 TIM session bound` directive.

## Decisions

- Session-start matches logging: per-session id authoritative; no global singleton reads.
- `hook session-start` still runs with resolved label (creates/refreshes subtree).
- Dropped global marker RMW on first turn — was last-write-wins; `tim_load_project` may still write `route_exchanges_to` for legacy tools (not used by this hook).

## Edge cases

- No local marker + session never in TIM → `{}` (no directive).
- Session in TIM without `project_ref` → skip TIM fallback.
- Local marker wins over TIM when both exist (in-repo dev).

## Verify

```bash
cd ~/projects/tim && npx tsc -b
npx vitest run packages/tim-cli packages/tim-hooks
printf '{"cwd":"%s","session_id":"KNOWN_ID","extra":{"is_first_turn":true}}' "$HOME" \
  | bash packages/tim-hooks/scripts/tim-session-start.sh
```

---

# JOURNAL — E2E Pipeline Test (session_log → summarizer → Summary tree → load_project)

Plan written to `docs/e2e-test-plan.md`. This is PLAN ONLY; implementer writes the test.

## Baseline (verified, commit cc40624)
- `npx tsc -b` → exit 0, clean.
- `npx vitest run` → **30 files, 222 tests, all pass** (~3s). Brief said "101 tests" — STALE. Anchor to 222.

## Decisions
- **In-process integration, NOT real subprocess.** `codex`/`opencode` absent in env; real spawn = non-deterministic + env-coupled. Mock the CLI leaf; exercise real store + SessionManager + runSummarizerLoop orchestration + project-output rendering.
- **No production code changes needed** — all DI seams already exist: `SessionManager.setOnBatchFull`, `maybeSpawnSummarizer(store,cwd,{spawn})`, public `showUnsummarized`/`writeBatchSummary`, `runSummarizerLoop` + `vi.mock('../mcp-client.js')`, `vi.mock('tim-core')` for chain control, env hooks (`TIM_DB_PATH`/`TIM_SESSION_ID`/`TIM_MCP_PATH`/`TIM_MARKER_MAX_ROOT`).
- New file: `packages/tim-summarizer/src/__tests__/pipeline-e2e.test.ts`. Genuinely new — no existing test crosses store+summarizer+output.

## Gotchas (the load-bearing ones — do NOT skip)
1. **Default load_project depth = 3 (TimLoadProjectSchema, server.ts:223). Batch-summary nodes live at depth 4 → INVISIBLE at default depth.** Walk: sessions-root(1) → session(2) → Summary/Exchanges(3) → Batch nodes(4). To assert the batch summary text landed, RE-LOAD at `depth: 4`. At depth 3 you only see the Summary node.
2. **`rollUpSession` (session.ts:412) has NO production caller.** The summarizer loop writes batch-summary KIND_BATCH nodes but never rolls them into the Summary node's `content`. So at default depth the Summary node a /new session sees is EMPTY (`content === ''`). Assert this explicitly + comment WHY. This is a real pipeline gap — flag it, don't mask it.
3. **`#session-summary` tag is on BOTH the per-session Summary node (session.ts:177) AND each batch-summary node (session.ts:399).** The project-output "Recent Sessions" filter (project-output.ts:286) only catches the Summary node at depth 3 (batch nodes too deep), so no double-count at default depth — but it WOULD double-count if loaded at depth >=4 and filtered naively. Keep assertions depth-aware. The rendered row (project-output.ts:316-317) is `${exchanges} exchanges · ${date}  "${summary}"` from `parseSessionEntry` — NOT the session title — and `summary` is the Summary node's `metadata.summary` (empty per Finding B). Assert the row's summary is `""`.
4. **The ONLY mechanism that surfaces aggregated summary TEXT to a /new default-depth session is the project-level `## Project Summary` block** in `project.content` (mergeProjectSummary summarize.ts:20 → renders as `── Project Summary ──` project-output.ts:273). This is a SEPARATE path: `runProjectSummary` gated by `maybeSpawnProjectSummary` (threshold 5 sessions, session-hooks.ts:181). Include an assertion for it.
5. **Batch rolls on the NEXT user, not the 5th.** logExchange (session.ts:256-273): batch fills when `usersInBatch.length >= batchSize` AND a new user arrives. So batch_size=5 needs a 6th user to roll Batch 1 and fire onBatchFull. batch_size=1 with N users → N-1 *roll/onBatchFull* events, last batch open.
5b. **CRITICAL off-by-one in summary COUNT (separate from roll count). `showUnsummarized` (session.ts:302) has NO fullness guard** — it returns the open trailing batch too, and `runSummarizerLoop` summarizes ANY batch with ≥1 user. So 6 users @ bs=5 → loop writes **2** summaries (Batch1 1–5, Batch2 6–6), `batchesSummarized===2`. 3 users @ bs=1 → loop writes **3** (not 2), even though Batch3 never fired onBatchFull. Invariant: summaries == # exchange-batch nodes with ≥1 user. DO NOT assert 1. Either test trigger+content separately (one iteration → assert Batch1 1–5, count 1) OR loop to completion (assert 2 / 3). Decide per test.
6. **`:memory:` DB is per-connection** but fine here because `maybeSpawnSummarizer(store,...)` takes the SAME store instance — no cross-connection read. Only a real-transport test (mcp-client spawns server.js) would need a temp-FILE db via TIM_DB_PATH.
7. **Marker isolation:** set `TIM_MARKER_MAX_ROOT` to the temp dir so findMarker walk-up doesn't grab the repo's own `~/projects/tim/.tim-project` or `~/.tim-project`. Use `vi.stubEnv`.
8. **`writeBatchSummary` is idempotent** (session.ts:383) — returns existing node on repeat batchIndex. Good positive assertion.
9. **FALLBACK string format** (summarize.ts:86): `[ALL SUMMARIZER CLIs FAILED — main agent please resummarize batch N]\nQ: <first 200 chars>` — em-dash, exact. Match `summarize-loop.test.ts:47`.

## Verify before/after
```bash
cd ~/projects/tim && npx tsc -b           # expect exit 0
npx vitest run                            # expect 222 (baseline), then 222+new, zero regressions
npx vitest run packages/tim-summarizer    # focused run of new file
```

---

# JOURNAL — E2E pipeline test (implemented)

## Done
- `packages/tim-summarizer/src/__tests__/pipeline-e2e.test.ts` — 10 tests: happy path (batch-full, spawn gate, one write, depth 3/4, idempotency, formatProjectOutput, runSummarizerLoop, mergeProjectSummary) + 7 edge cases
- `tim-hooks` added to `tim-summarizer` devDependencies (import `maybeSpawnSummarizer` / marker helpers)

## Decisions
- Happy path: one `writeBatchSummary` iteration only (not loop-to-completion) — trigger proves batch 1 roll; depth 4 proves write
- Recent Sessions row asserts `0 exchanges … "Summary"` (parseSessionEntry uses title, not empty `metadata.summary`) + explicit `metadata.summary === ''`

## Gotchas confirmed in tests
- 6 users @ bs=5 → onBatchFull×1 (batch 1), not 2 summaries unless loop runs to completion
- `vi.spyOn(child_process.spawn)` fails ESM — use real ENOENT binary via `loadConfig` chain instead
- Verify: `tsc -b` clean; `vitest run` → **232** tests (222+10)

---

# JOURNAL — Global post-commit hook (2026-06-03)

## Done
1. `record-commit.ts` extracted from `cli.ts`
2. `post-commit.sh` — TIM_CLI → `tim` PATH → monorepo `dist/cli.js`; errors swallowed
3. Global: `~/.hermes/git-hooks/post-commit` + `core.hooksPath`
4. Idempotent CLI test (+1 → **233** tests)

## Decisions
- Global hooksPath = all repos; local `.git/hooks` ignored
- Hook never fails commit (`|| true`, exit 0)

## Gotchas
- Only `post-commit` in global dir unless more hooks symlinked
- Rebuild `tim-cli` after pull for dev fallback path

## Verify
```bash
npx tsc -b && npm test
bash packages/tim-hooks/scripts/post-commit.sh
```

---

# JOURNAL — Impl: load_project gate + tim_read_project (2026-06-03)

## Done
- `tim-core/load-gate.ts` — `evaluateLoadGate(ref, label)` pure helper; 6 unit tests
- `tim_load_project` — gate before side effects; `switch:true` escape hatch; reject = plain text, names `tim_read_project`
- `tim_read_project` — `loadProject` + `formatProjectOutput`, no bind/marker/session; in READ_TOOLS
- `o9k-activate` skill — `switch:true` on mid-session load

## Decisions
- Gate in MCP handler only — `session.ts` reparent tests untouched
- P0000 = unbound → first real load OK; same label = refresh OK
- Reject before `loadProject`/markers — zero side effects on cross-project accident

## Verify
```bash
npx tsc -b && npx vitest run   # 240 pass (234+6)
```

Plan: `docs/load-project-gate-plan.md`

---

# JOURNAL — Session reparent on project switch (DONE)

Plan: `docs/exchange-reparent-plan.md`

## Done
- `startProjectSession` rebind: validate target → ensure Sessions section → `update(project_ref)` then `curate().moveEntry(session, newSessionsRoot)`
- Tests: `reparents the session node…` (exchange before switch, parentId + content); rebind test + back-and-forth + same-project no-op

## Decisions
- One session node per `sessionId` — move it, descendants follow; no per-exchange reparent
- `project_label` = parent-walk at read — no exchange metadata writes

## Edge / gotchas
- **update before moveEntry** — reverse clobbers `order` from move
- Missing project → throw; same `project_ref` → no-op; empty old Sessions section OK (hidden in UI)
- 234 tests, `tsc -b` clean; change only `session.ts` + tests
