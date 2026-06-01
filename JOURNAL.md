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
