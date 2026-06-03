# Plan — `tim_load_project` gate + `tim_read_project` tool

**Goal:** One `tim_load_project` per session (binds). Cross-project lookups go through a new
read-only `tim_read_project` (no bind, no markers, no side effects). A second `tim_load_project`
for a *different* project is rejected with a clear message — unless an explicit switch is requested.

Status: PLAN ONLY. Implementer writes code + tests.

---

## 1. Decisions (read before coding)

### D1 — Gate lives in the MCP handler, NOT in `session.ts`
Put the gate in the `tim_load_project` case in `packages/tim-mcp/src/server.ts` (≈ line 1253).
Do **not** touch `SessionManager.startProjectSession`.

Why: `startProjectSession` reparent/rebind is store-level mechanism, exercised directly by
`session.test.ts` (reparent + rebind tests, session.test.ts:359–420) and reused by
`tim_session_start`. Gating there breaks those green tests and the session_start path. The
"one load per session" rule is a *tool-policy* concern → it belongs at the tool boundary.

### D2 — Gate decision is a PURE helper (the only unit-testable piece)
Extract the decision to a pure function so it can be tested without spawning an MCP server
(tim-mcp has zero test infra — confirmed: no `__tests__`, handler is a closure inside
`startServer`). Signature:

```ts
// returns 'bind' (proceed: first bind or same-project refresh) or 'reject' (different project)
export function evaluateLoadGate(
  existingProjectRef: string | undefined | null,
  requestedLabel: string,
): 'bind' | 'reject'
```

Rule: `reject` iff `existingProjectRef` is set, non-empty, !== `'P0000'`, and !== `requestedLabel`.
Otherwise `bind`. (P0000 Inbox counts as *unbound* → first real load is always allowed.)

Place it in **`tim-core`** (has a test file + is imported by server.ts already) and unit-test it
there. Do NOT invent MCP test infra for this task.

### D3 — Escape hatch for genuine switches (`switch: true`)  ← reconciles with shipped work
This task reverses the recent direction of travel: `cc40624` (multi-session routing) and
`8bdd819` (reparent-on-switch) *built* mid-session switching, and the **`o9k-activate` skill
exists specifically to "switch active project mid-session via tim_load_project."** Hard-gating
would break o9k-activate on day one.

Resolution: add optional `switch?: boolean` (default false) to `TimLoadProjectSchema`. When
`switch === true`, skip the gate (genuine switch → reparent proceeds via existing
`startProjectSession` path). Accidental cross-project *lookups* (no flag) get rejected and
pointed at `tim_read_project`.

- **o9k-activate** skill must be updated to pass `switch: true` (it is the one legitimate
  mid-session switcher). List it under §5.
- This keeps `startProjectSession`'s reparent code (8bdd819) *live and reachable*, not dead.

### D4 — `tim_read_project` = `loadProject` + `formatProjectOutput`, nothing else
Verified `store.loadProject` is read-only (SELECT-only, store.ts:187). The new tool reuses it
with the SAME resolve/ambiguous/not_found handling and SAME `formatProjectOutput`, but performs
**none** of: `startProjectSession`, `syncNearestProjectMarker`, global `~/.tim-project` write.
No `sessionId`/`switch` params. Identical visual output to load_project, zero side effects.

---

## 2. Gate logic — handler changes (`tim_load_project` case, server.ts:1253)

Order of operations (early-reject before any side effect):
1. Parse args (now incl. `switch`). Resolve label (`resolveProjectLabel`) — ambiguous/not_found
   unchanged, return plain text (NOT `isError`).
2. Resolve `sessionId` (existing `resolveActiveSessionId` call, unchanged).
3. **Gate** — only when a `sessionId` resolved AND `switch !== true`:
   - `const existing = await s.read(sessionId)` (or `getSessions()` read).
   - If `existing?.metadata.kind === 'session'`, compute
     `evaluateLoadGate(existing.metadata.project_ref, projectLabel)`.
   - If `'reject'` → return plain-text message, **do nothing else** (no loadProject render, no
     marker writes, no bind). Message must name the alternative, e.g.:
     > Session already bound to `<ref>`. One `tim_load_project` per session. Use
     > `tim_read_project` for cross-project lookups, or pass `switch:true` to switch this session.
4. Otherwise proceed exactly as today (loadProject → startProjectSession → markers → format).

Same-project reload (`project_ref === projectLabel`) → `'bind'` → falls through → refreshes
brief + markers as today. No error. ✔ (edge: same project twice = allowed refresh.)

---

## 3. `tim_read_project` — new tool

- **Schema** `TimReadProjectSchema`: `label` (req), `depth` (1–5, def 3), `budget` (1–1000,
  def 200), `sections` (string[]|null, def null). No `sessionId`, no `switch`.
- **Tool def** in the `tools:` list (near load_project, server.ts:868): name `tim_read_project`,
  description e.g. *"Read a project's brief + tree WITHOUT binding the session (cross-project
  lookup). Use tim_load_project to start working on a project."*
- **Handler case**: resolveProjectLabel (ambiguous/not_found same plain-text returns) →
  `s.loadProject(label,{depth,budget,sections})` → `formatProjectOutput(result, budget,
  loadProjectSchema())`. No session, no marker, no bind.
- **Register** `tim_read_project` in `READ_TOOLS` (server.ts:463) so autoPull fires like
  load_project.

---

## 4. Edge cases

| Case | Behavior |
|------|----------|
| Same project loaded twice | `bind` → refresh brief/markers, no error |
| First load (no session yet / session unbound) | `bind` |
| Bound to P0000 Inbox, then real project | `bind` (P0000 = unbound) |
| Different project, no `switch` | **reject**, plain text, zero side effects |
| Different project, `switch:true` | `bind` → reparent via startProjectSession (8bdd819) |
| `sessionId` unresolvable (MCP stdio, no arg/env/marker) | gate can't fire AND no bind happens — coherent, not a bug (see §6) |
| `tim_read_project` non-existent project | same `Project not found` plain text as load |
| `tim_read_project` ambiguous alias | same `Ambiguous alias` plain text as load |

---

## 5. Files / skills to touch

| File | Change |
|------|--------|
| `packages/tim-core/src/…` (+ index export) | add `evaluateLoadGate` pure helper |
| `packages/tim-core/src/__tests__/…` | unit-test helper (P0000-unbound, same-project, reject, first-bind) |
| `packages/tim-mcp/src/server.ts` | `switch` in TimLoadProjectSchema; gate in load case; `TimReadProjectSchema`; read_project tool def + case; READ_TOOLS entry |
| `o9k-activate` skill (machine state, not repo) | pass `switch:true` on its `tim_load_project` call |
| `docs/` (optional) | note new tool + one-load rule if a user-facing doc lists tools |

---

## 6. Testing reality (do not over-promise)

- **Unit-testable:** `evaluateLoadGate` only. Cover: undefined ref→bind, `'P0000'`→bind,
  same label→bind, different label→reject.
- **NOT unit-testable without new infra:** the handler's reject path (returns message? skips
  markers? skips bind?). tim-mcp has no test harness and the handler is a closure in
  `startServer`. The prompt's "tests in `tim-mcp/__tests__`" assumes infra that does not exist —
  do NOT build an MCP-server spawn harness for this task. If coverage of the handler is later
  required, that is its own task (extract handler or add server-spawn infra).
- **Audit of existing multi-load tests — done:**
  - `session.test.ts` reparent/rebind (359–420) call `startProjectSession` directly (store
    level) → unaffected by the MCP gate → stay green. No change needed.
  - `pipeline-e2e.test.ts` calls `store.loadProject` (read-only) on a single project, never
    drives the MCP handler with two different projects → unaffected.
  - No existing test calls the MCP `tim_load_project` handler twice with different projects
    (no MCP test infra exists). Nothing to fix.

## 7. Verify

```bash
cd ~/projects/tim && npx tsc -b               # expect exit 0
npx vitest run packages/tim-core packages/tim-store packages/tim-summarizer  # gate helper + no regressions
npm test                                       # full suite green (baseline 234)
```
