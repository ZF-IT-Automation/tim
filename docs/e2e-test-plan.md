# E2E Test Plan — session_log → batch-full → Summarizer → Summary tree → /new load_project

Status: PLAN ONLY (no implementation). Grounded against the codebase at commit `cc40624`.
Baseline observed: `npx tsc -b` → exit 0 (clean). `npx vitest run` → **30 files, 222 tests, all pass** (~3s). The "101 tests" figure in the original brief is stale; current count is 222.

---

## 0. Critical findings that shape the test (READ FIRST)

Two facts about the *real* pipeline change what an honest E2E test can assert. Both confirmed by reading source:

### Finding A — Default `load_project` depth (3) cannot see batch-summary nodes (depth 4)

`tim_load_project` parses `depth` with `.default(3)` (`packages/tim-mcp/src/server.ts:223`, `TimLoadProjectSchema`). `TimStore.loadProject` (`packages/tim-store/src/store.ts:187`) flattens the subtree into ONE `children[]` array via `loadChildren(project.id, 1, true)` and stops when `currentDepth > depth`.

Tree depth walk (each level = one `loadChildren` recursion):
- depth 1: `sessions-root` (`KIND_SESSIONS_ROOT`) — pushed
- depth 2: `session` (`KIND_SESSION`) — pushed
- depth 3: `Summary` (`KIND_SUMMARY_ROOT`) and `Exchanges` (`KIND_EXCHANGES_ROOT`) — pushed
- depth 4: `Batch N` summary nodes (`KIND_BATCH`, under Summary) and `Batch N` exchange nodes (`KIND_EXCHANGE_BATCH`, under Exchanges) — **NOT pushed at depth 3**

Consequence: at the default depth a new session sees the **Summary node**, not the individual batch-summary nodes. The `#session-summary` tag filter in `formatProjectOutput` (`packages/tim-store/src/project-output.ts:286`, "Recent Sessions" block) therefore matches the per-session **Summary node**, NOT the batch nodes (which also carry `SESSION_SUMMARY_TAG` per `session.ts:399` but live one level too deep to appear).

### Finding B — Nothing rolls batch summaries up into the Summary node

`runSummarizerLoop` (`packages/tim-summarizer/src/summarize.ts:75`) writes only **batch summaries** via `tim_write_batch_summary` → `SessionManager.writeBatchSummary` → `KIND_BATCH` nodes under the Summary node. It never calls `SessionManager.rollUpSession` (`session.ts:412`). `rollUpSession` has **no production caller** (grep: defined + exported in `index.ts:55`, referenced only by `SESSION_ROLLUP_THRESHOLD` constant — never invoked outside its own definition). So the Summary node's `content`/`metadata.summary` stays `''` after the plain pipeline runs.

**Net effect:** the plain pipeline (session_log → batch-full trigger → summarizer loop writing batch summaries) produces nodes that a *default-depth-3* `load_project` renders as an **empty Summary node** in "Recent Sessions". The actual batch text is only visible at `depth >= 4`. The project-level `## Project Summary` block (`project.content`) is a SEPARATE path (`runProjectSummary`, gated by `maybeSpawnProjectSummary`, threshold 5 sessions) and is the only thing that surfaces aggregated summary *text* at default depth.

The test must assert against the level that is actually visible — and the plan explicitly documents this gap rather than pretending depth-3 shows batch text. This is itself a valuable finding; whether it's a bug (missing rollUp wiring) is a product decision, not something the test should mask.

---

## 1. Test approach

**In-process integration, mocked summarizer CLIs — NOT real subprocess.**

Rationale:
- `codex` / `opencode` binaries are not present in this environment; `generateSummary` with a failing/empty chain returns `FALLBACK_MARKER` (`generate-summary.ts:224,251`). Real spawn would make the test environment-dependent and non-deterministic.
- All seams needed for in-process testing already exist (see §5). No production code changes required.
- We exercise the real store, real `SessionManager` batch logic, real `runSummarizerLoop` orchestration, real `formatProjectOutput` rendering — only the leaf CLI spawn and the MCP stdio transport are faked.

Two injection strategies, used together:
- **Spawn gate / batch-full trigger:** inject a fake `Spawner` into `maybeSpawnSummarizer(store, cwd, { spawn })` (`packages/tim-hooks/src/session-hooks.ts:102`). Assert the fake fires (it does NOT actually run the summarizer). This proves the *trigger* fires; we then drive the summarizer step explicitly.
- **Summarizer step:** prefer calling `SessionManager.showUnsummarized` + `writeBatchSummary` directly (skips stdio transport entirely, deterministic), OR reuse the `vi.mock('../mcp-client.js')` pattern from `summarize-loop.test.ts` to drive `runSummarizerLoop`. Recommend the direct-SessionManager path for the main happy-path test (no transport flakiness) and one `runSummarizerLoop` test for the orchestration/fallback wiring.

This is genuinely NEW coverage: no existing test crosses store + summarizer + project-output together. Existing `summarize-loop.test.ts` mocks both `mcp-client` and `tim-core`; `session.test.ts` covers store-only; `project-output.test.ts` covers rendering only.

---

## 2. Test file(s) and location

Primary new file:
- `packages/tim-summarizer/src/__tests__/pipeline-e2e.test.ts`

Why this package: the summarizer package is the orchestration entry point (`runSummarizerLoop`) and already depends on `tim-store` + `tim-core` (workspace deps), so importing `TimStore`, `SessionManager`, and `formatProjectOutput` is clean. The batch-full trigger lives in `tim-hooks`; import `maybeSpawnSummarizer` from `tim-hooks` (add it as a devDependency reference if not already resolvable — verify `packages/tim-summarizer/package.json` deps; `tim-hooks` is a sibling workspace).

Alternative if cross-package import is awkward: split into
- `packages/tim-hooks/src/__tests__/batch-full-trigger.test.ts` (trigger half, imports store + session-hooks)
- `packages/tim-summarizer/src/__tests__/pipeline-e2e.test.ts` (summarizer + load_project half)

Recommend the single-file approach in `tim-summarizer` first; fall back to split only if `tim-hooks` import fails to resolve.

---

## 3. Test structure

### Setup (per `beforeEach`)
- `store = new TimStore(':memory:')` (matches `session.test.ts:10` idiom).
- `sessions = new SessionManager(store)`.
- Create a project: `store.write('TIM', { id: 'P0063', metadata: { kind: 'project', label: 'P0063', render_depth: 1 }, tags: ['#project'] })` (mirror `ensureInboxProject` shape in `session-tree.ts:98`).
- Start a project session: `sessions.startProjectSession({ sessionId: 'sess-e2e', projectId: 'P0063', agentName: 'claude', cwd: tmpCwd, harness: 'claude-code', batchSize: 5 })`. This builds the Sessions → session → Summary + Exchanges → Batch 1 subtree (`session.ts:121-189`).
- For the trigger test, create a temp dir with a `.tim-project` marker (`writeMarker` from `tim-hooks/marker.ts:35`) so `detectProject`/`reconcileMarker` work. Set `TIM_DB_PATH` to a temp-file DB (NOT `:memory:`) for any test that needs `reconcileMarker` to re-open the same DB — `:memory:` is per-connection, so the marker reconcile in `maybeSpawnSummarizer` reads `deriveCounters` on the SAME `store` instance passed in, which IS fine because `maybeSpawnSummarizer(store, ...)` takes the store directly. So `:memory:` is acceptable for the trigger test as long as the same `store` object is passed.
- `afterEach`: `store.close()`; clean temp marker dir.
- Env isolation: set `TIM_MARKER_MAX_ROOT` to the temp dir (`marker.ts:135` — `findMarkerOptionsFromEnv`) so the real `~/.tim-project` / `~/projects/tim/.tim-project` is never picked up. Set/restore via `vi.stubEnv`.

### Execution (happy path)

> **CRITICAL off-by-one — the summarizer loop summarizes the trailing OPEN batch too.**
> `showUnsummarized` (`session.ts:302`) has NO fullness guard: it returns the batch at `batchIndex = batchesSummarized+1` with whatever users it has, and sets `hasMore=false` only when batch `batchIndex+1` does not exist. `runSummarizerLoop` writes ANY batch with `exchanges.length > 0` and breaks on `!hasMore`. So with 6 users at batch_size 5 (Batch1=u1–u5, Batch2=u6 open): loop writes Batch1 (seq 1–5, hasMore=true) THEN Batch2 (seq 6–6, hasMore=false) → **2 batch summaries, `batchesSummarized === 2`**, not 1.
> The correct invariant to assert: **summaries written == number of exchange-batch nodes that have ≥1 user**, regardless of "full". Decide per test which of these you measure:
> - **Trigger vs. content, separated (recommended for the main happy path):** log 6 → assert `onBatchFull` fired exactly once with `batchIndex===1`; then drive `showUnsummarized`/`writeBatchSummary` for ONE iteration and assert Batch1 seq_from=1 seq_to=5. Stop after one batch — do not loop to completion in this test.
> - **Loop to completion:** drive until `exchanges.length===0` and assert **2** nodes (Batch1 seq1–5, Batch2 seq6–6), `batchesSummarized===2`.

1. Log 5 user+agent exchanges to fill Batch 1, then a 6th user exchange to ROLL the batch:
   `sessions.logExchange('sess-e2e', [{role:'user',content:'Q1'},{role:'agent',content:'A1'}, ... Q5/A5])` then a separate call with `[{role:'user',content:'Q6'}]`.
   The roll happens inside `logExchange` at `session.ts:256-273`: when `usersInBatch.length >= batchSize` on the next user, it creates `Batch 2` and fires `this.onBatchFull?.(...)`.
2. Wire `sessions.setOnBatchFull(...)` to record the `BatchFullInfo` (sessionId, batchId, batchIndex) — assert it fired exactly once with `batchIndex === 1`.
3. (Trigger-gate sub-test) Call `maybeSpawnSummarizer(store, tmpCwd, { batchFull: true, spawn: fakeSpawner })` and assert `result.spawned === true`, `result.reason === 'spawned'`, and `fakeSpawner` was called once with a command string containing `summarize.js` and `TIM_SESSION_ID`.
4. Drive the summarizer step directly (deterministic): loop
   `const batch = await sessions.showUnsummarized('sess-e2e')` (`session.ts:302`), compute `seqFrom/seqTo` from `batch.exchanges`, then `await sessions.writeBatchSummary('sess-e2e', batch.batchIndex, '<summary text>', { seqFrom, seqTo })` (`session.ts:374`). Repeat while `batch.exchanges.length > 0` (re-derive `batchIndex` each call). This mirrors `runSummarizerLoop` exactly but without MCP transport.
   - To exercise the orchestrator itself, ALSO add one test using `runSummarizerLoop('sess-e2e')` with `vi.mock('../mcp-client.js')` returning batches backed by the real store calls (per `summarize-loop.test.ts:33-37`).

### Execution (the "/new load_project" half)
5. Simulate a fresh session: call `store.loadProject('P0063', { depth: 3, budget: 200 })` (the exact defaults the MCP handler uses — `server.ts:1270` passes through schema defaults 3/200).
6. Render: `formatProjectOutput(result, 200, loadProjectSchema?)` (`packages/tim-store/src/project-output.ts`). For the test, pass `undefined`/no schema (the schema arg is optional in the renderer signature — verify at call site `server.ts:1323`).

### Assertions
Anchored to what is ACTUALLY visible (per §0):
- **Batch nodes were written:** `result.children.filter(c => c.metadata.kind === 'batch-summary')` — at depth 3 this is EMPTY (Finding A). At `depth: 4` it contains the batch node(s). For the "one iteration" happy path: 1 node (Batch 1) with `batch_index===1`, `seq_from===1`, `seq_to===5`, content === summary text, tags include `#session-summary` + `#batch-summary`. For "loop to completion": 2 nodes (Batch1 seq1–5, Batch2 seq6–6). **Assert by re-loading at depth 4** (`store.loadProject('P0063', { depth: 4 })`) — proves the write landed in the Summary tree.
- **Summary node visible at depth 3 but empty:** `result.children.find(c => c.metadata.kind === 'session-summary-root')` exists; its `content`/`metadata.summary` is `''` (Finding B). Assert this explicitly and comment WHY (no rollUp caller) so the test documents the gap.
- **Counters reconciled:** `deriveCounters(store, 'sess-e2e')` returns `batchesSummarized ===` (1 for one-iteration test; 2 for loop-to-completion); session metadata `batches_summarized` matches (`session.ts:402-408`). DO NOT assert 1 unconditionally — see the off-by-one note above.
- **Idempotency:** calling `writeBatchSummary('sess-e2e', 1, ...)` again returns the EXISTING node, no duplicate (`session.ts:383-385`). Assert `getChildByKind(summaryNodeId, 'batch-summary').length === 1`.
- **Rendered output:** `formatProjectOutput(...)` contains a `── Recent Sessions (n/m) ──` header (`project-output.ts:314`). GROUNDED: each row renders `parseSessionEntry(session)` → `\`${exchanges} exchanges · ${date}  "${summary}"\`` (`project-output.ts:316-317`), NOT the session title. The filtered node is the **Summary node** (kind `session-summary-root`), so `summary` comes from its `metadata.summary` — which is `''` (Finding B). So the row renders an EMPTY `""` summary. Assert the header line and the `exchanges` count appear; assert the summary string is empty (documents Finding B end-to-end). Do NOT assert batch text appears at depth 3 — it can't.
- **Project-summary path (separate, optional assertion):** to show aggregated text DOES surface, call `mergeProjectSummary(project.content, 'agg summary')` (`summarize.ts:20`) → `store.update` → reload at depth 3 → assert `formatProjectOutput` output contains `── Project Summary ──` (`project-output.ts:273`). This is the real mechanism by which a /new session sees summary TEXT.

---

## 4. Edge cases

Each as a separate `it(...)`:

1. **Missing summarizer CLI / empty chain → FALLBACK_MARKER path.** Mock `tim-core` `loadConfig` to return `summarizer.chain = []` (per `summarize-loop.test.ts:5-11`). Drive `runSummarizerLoop` (mocked mcp-client) and assert the batch summary written is the fallback string `[ALL SUMMARIZER CLIs FAILED — main agent please resummarize batch 1]\nQ: <first 200 chars>` (`summarize.ts:86-88`). Already partially covered by `summarize-loop.test.ts`; the E2E variant should additionally verify the fallback marker LANDS in the Summary tree via the real store (not just that `callTimTool` was invoked).
2. **All CLIs fail (non-empty chain, every `tryCli` returns null).** Mock `loadConfig` chain to point at a nonexistent binary (e.g. `cli: 'definitely-not-a-real-cli'`) so `tryCli` hits the spawn-error catch (`generate-summary.ts:170-177`) and returns null for every entry → `generateSummary` returns `FALLBACK_MARKER` (`generate-summary.ts:251`). Assert fallback lands. (This actually spawns; keep it but mark it as the one test that touches real spawn, OR mock `child_process.spawn` to emit an `error` event.)
3. **Empty batch / no exchanges.** Start a project session, log nothing, call `showUnsummarized` → `exchanges.length === 0`, `hasMore === false`. `runSummarizerLoop` should write 0 summaries (`summarize.ts:80` `while` loop body never runs). Assert returned count `=== 0` and Summary tree has no batch nodes.
4. **batch_size = 1.** Start session with `batchSize: 1`. A batch rolls on the NEXT user (`session.ts:256`). Log 3 user+agent pairs → `onBatchFull` fires for batches 1 and 2 (Batch 3 is open, never fired a roll). BUT the summarizer loop has no fullness guard (see happy-path note): driving `runSummarizerLoop` to completion summarizes ALL THREE non-empty batches → **3 batch summaries written**, `batchesSummarized===3`. Assert 3 — NOT 2. The "N users → N-1 rolled" rule applies to the `onBatchFull` TRIGGER count (2), not to the summary count (3). State both numbers and which event each measures.
5. **Below-threshold gate (no spawn).** With pending exchanges < batch_size and `batchFull` NOT set, `maybeSpawnSummarizer(store, cwd, { spawn: fake })` returns `{ spawned:false, reason:'below-threshold' }` and fake is NOT called (`session-hooks.ts:114`). Asserts the gate.
6. **Lock held → no double spawn.** Call `acquireLock(cwd)` first, then `maybeSpawnSummarizer(store, cwd, { batchFull:true, spawn:fake })` → `{ spawned:false, reason:'locked' }` (`session-hooks.ts:118`). Then `releaseLock`.
7. **No marker → no spawn.** `maybeSpawnSummarizer(store, dirWithoutMarker, { batchFull:true })` → `{ spawned:false, reason:'no-marker' }` (`session-hooks.ts:110`).

---

## 5. Code changes needed for testability

**None.** All seams already exist — state this explicitly:

- `SessionManager.setOnBatchFull(handler)` (`session.ts:97`) — DI for the batch-full callback.
- `maybeSpawnSummarizer(store, cwd, { spawn })` (`session-hooks.ts:102`) — DI for the `Spawner` (avoids real subprocess).
- `SessionManager.showUnsummarized` / `writeBatchSummary` (`session.ts:302,374`) — public methods, callable without MCP transport.
- `runSummarizerLoop(sessionId)` (`summarize.ts:75`) — testable with `vi.mock('../mcp-client.js')` (proven by `summarize-loop.test.ts`).
- `generateSummary` / `generateProjectSummary` read chain from `loadConfig()` — controllable via `vi.mock('tim-core')`.
- Env hooks: `TIM_DB_PATH` (`summarize.ts:27`, `mcp-client.ts:27`), `TIM_SESSION_ID` (`summarize.ts:119`), `TIM_MCP_PATH` (`mcp-client.ts:34`), `TIM_MARKER_MAX_ROOT` (`marker.ts:137`), `TIM_SUMMARIZER_VERBOSE` (logging).
- `:memory:` DB constructor (`new TimStore(':memory:')`) — same-instance store passed to both `SessionManager` and `maybeSpawnSummarizer`, so no cross-connection issue.

Optional (NOT required, only if a *true* end-to-end-with-real-MCP-transport test is later desired): a `--db-path` flag or already-present `TIM_DB_PATH` + `TIM_MCP_PATH` let `connectTimMcp` spawn the real `tim-mcp/dist/server.js` against a temp DB. This is heavier and flakier; the plan recommends AGAINST it for CI — keep the transport mocked.

---

## 6. Pre-flight for the implementer

- Run `npx tsc -b` (expect exit 0) and `npx vitest run` (expect 222 passing) BEFORE writing, to confirm baseline.
- After adding the file, `npx vitest run packages/tim-summarizer` then full `npx vitest run` — target 222 + new tests, zero regressions.
- Build dist if any test imports compiled output: the in-process plan imports TS source via workspace package names (`tim-store`, `tim-core`, `tim-hooks`), so `dist` is only needed if a real-transport test is added (it is not in this plan).
- Verify `tim-hooks` is importable from `tim-summarizer` test (`packages/tim-summarizer/package.json` dependencies). If absent, either add the split-file layout (§2) or add `tim-hooks` to summarizer devDependencies (a package.json edit, NOT product code).
