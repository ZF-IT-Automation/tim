# /tim-resume — Review-Fix Round 2

Branch: `feature/tim-resume` (continue on it). Context: the resume feature landed but a
multi-agent review found the alias mechanism does not work in the real harness flow. All 8
findings below are CONFIRMED with primary-source evidence. Root cause: alias resolution was
placed at the wrong layer (a copy-pasted line per method) and its ordering is inverted.

Fix in TDD style, commit per fix. Do NOT weaken existing tests. End with `npm run build && npm test`.

## The core fix (do this first — it dissolves findings 1, 4, 5, 6)

**Central resolution point + inverted ordering.**

1. In `packages/tim-store/src/store.ts` `resolveSessionAlias(harnessId)`: **look up the
   `resumed_by` alias FIRST**, and only fall back to identity if no session node claims
   `harnessId` as an alias. Concretely: if some live session node S has `harnessId` in its
   `metadata.resumed_by`, return S.id — even when `harnessId` is itself a (empty) session
   node. Rationale: in the real flow the resuming tool's `session_start`/`load_project`
   has already created an empty session node whose id == the harness id, so the current
   direct-first ordering permanently shadows the alias (Finding 1).
   - Guard against a node aliasing itself; if `harnessId` is both a session node AND
     appears in another node's `resumed_by`, the alias owner wins.
   - Keep it a single indexed-ish path; see Finding 6 for the perf note below.

2. **Single choke point.** Right now `sessionId = this.store.resolveSessionAlias(sessionId)`
   is copy-pasted at the top of ~10 `SessionManager` methods AND three consumers outside
   `SessionManager` forgot it. Introduce one resolution gateway that every session-id
   consumer passes through. Options (pick the one that fits the codebase best):
   - Resolve inside the low-level session-id read path in `TimStore`, OR
   - A `TimStore.resolveSession(id)` returning the canonical entry that all callers use.
   Then the three external misses (Findings 2, 3, 5) are covered structurally, not by
   remembering to add a line. Remove the now-redundant per-method lines where the gateway
   makes them dead.

## Findings to fix

### Finding 1 — resolveSessionAlias ordering (store.ts ~866) — CORRECTNESS, top severity
Direct-id branch returns before the `resumed_by` lookup, so an alias whose id is an empty
session node never resolves to canonical. Covered by the core fix above.
**Required test:** in `session-resume.test.ts`, add an end-to-end test that mirrors the real
flow: `startSession('H2')` to create an EMPTY session node, then
`resumeSession('sess-Z', { newHarnessId: 'H2' })`, then `logExchange('H2', …)`, then assert
the new exchange landed in `sess-Z` (canonical) — `resolveSessionAlias('H2') === 'sess-Z'`
and `sess-Z` exchange_count increased, `H2` still has 0. This test must FAIL before the fix.

### Finding 2 — tim_session_log routes on unresolved id (server.ts ~2708) — CORRECTNESS
The batch-tree vs. legacy-flat decision uses the raw id, so a resumed alias routes to the
flat writer and exchanges become invisible to summarizer/resume. Resolve the alias BEFORE
the `isProjectBound` branch (the central gateway from the core fix should be applied here).
**Test (tim-mcp or tim-store):** after resume, logging via the alias must append into the
canonical session's exchanges-root batch tree and be returned by `showUnsummarized`.

### Finding 3 — recordCommit no resolution (commit.ts ~68) — CORRECTNESS
`store.read(params.sessionId)` on a raw alias → undefined → links silently skipped.
Route `params.sessionId` through the resolution gateway before the read.
**Test:** record a commit during a resumed session (alias id) → assert relates/implements
edges link to the canonical session node.

### Finding 5 — getPreviousSession excludeSessionId not resolved (store.ts ~2049) — CORRECTNESS
`e.id != excludeSessionId` compares canonical node id against a raw alias, so the active
resumed session isn't excluded and becomes its own delta baseline. Resolve `excludeSessionId`
(in `getPreviousSession`, or at both callers `server.ts` tim_delta ~2130 and
`packages/tim-hooks/src/delta.ts` ~40).
**Test:** after resume, `getPreviousSession(project, aliasId)` must not return the current
canonical session.

### Finding 4 — resume handler harness-id derivation skips session-cache (server.ts ~2686) — CORRECTNESS
`newHarnessId = env.TIM_SESSION_ID ?? marker.session` diverges from the shared
`resolveActiveSessionId` (arg→env→cache→marker) used by tim_session_log/tim_delta/
tim_load_project. In cache-based harnesses (Hermes) the alias binds to a stale id.
Replace with:
```ts
const newHarnessId = resolveActiveSessionId({
  markerSession: cwd ? findMarker(cwd, { walkUp: true })?.marker.session : undefined,
  useSessionCache: !isHttp,
  useEnv: !isHttp,
});
```
Import `resolveActiveSessionId` the same way the other handlers do.

### Finding 6 — resolveSessionAlias hot-path O(all-sessions) scan (store.ts ~604) — EFFICIENCY
The `EXISTS json_each(metadata.resumed_by)` fallback can't use an index and runs per
exchange in the resumed steady state. With the ordering now alias-first (Finding 1), this
path fires on EVERY resumed exchange, so it matters more, not less.
**Fix:** maintain a cheap reverse lookup so alias→canonical is O(1): e.g. when
`resumeSession` records an alias, also write a small mapping row/entry keyed by the alias id
(kind e.g. `session-alias`, metadata.canonical = S.id, id = harnessId), and have
`resolveSessionAlias` do a direct PK lookup on that mapping first. (This also neatly makes
the empty-node case unambiguous.) Choose the representation that fits the schema; if you add
a table/kind, no migration bump is needed for a new metadata kind, but confirm sync carries
it. Keep identity-fast-path for the common non-aliased case.
**Test:** alias resolution still correct; add a note/assert that no full-table scan is needed
(at minimum, behavior-preserving tests from Finding 1 still pass).

### Finding 8 — cross-project resume has no project guard (server.ts ~2694) — CORRECTNESS (lower)
`tim_session_resume` accepts any sessionId and never checks the resumed session's
`project_ref` against the bound/cwd project; `rotateMarkerSession` leaves `marker.project`
stale. Only reachable when a foreign sessionId is passed directly (tim_resume_list is already
project-scoped). **Fix:** in the handler (or `resumeSession`), reject a session whose
`project_ref` differs from the bound project with a clear error. Add the bound project label
to the handler and compare.
**Test:** resuming a session from another project throws.

## Finding 7 — altitude (already addressed by the core fix)
The "copy-pasted resolve line, no choke point" finding IS the core fix above. No separate
work item; verify the three external misses are covered by the gateway, not by re-adding
lines.

## Deliverable
- One commit per finding (or logically grouped), messages `fix(tim-store|tim-mcp): …`.
- Final `npm run build && npm test` green, including the new failing-first tests.
- Summary at the end: which findings fixed, new tests added, any deviation.
