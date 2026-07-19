# Marker Slimming Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** `docs/superpowers/specs/2026-07-19-marker-slimming-design.md`

**Goal:** Shrink `.tim-project` to a v3 label-only file, make the store authoritative for the current session id and all counters, move the summarizer lock out of the marker namespace, add the per-device `project-path` inventory, give `tim doctor` a binding section with opt-in `--bind`, and anchor the migration/curate binding obligations.

**Architecture:** `tim-store` gains the two new primitives every consumer needs: `resolveCurrentSession` (latest session entry for a project + cwd — replaces `marker.session`) and the `project-path` inventory upsert (one child row per device, so row-level LWW sync never loses a device's write). `tim-hooks` slims the marker schema and deletes the mutable-marker machinery (`rotateMarkerSession`, `reconcileMarker`, per-start marker rewrites); counters come from the existing `deriveCounters` everywhere. `tim-cli` and `tim-mcp` swap their `marker.session` reads for payload session ids or `resolveCurrentSession`. Binding writes stay funneled through `recoverProjectBinding` (`tim bind-project`), which additionally backfills `metadata.path` and seeds the inventory; `tim doctor --bind` and the migration report reuse it.

**Tech Stack:** TypeScript 5.9, Node.js 24 ESM, SQLite through `TimStore`, Vitest 3, npm workspaces, committed `dist` artifacts.

---

## File responsibility map

| File | Responsibility |
|---|---|
| `packages/tim-store/src/session.ts` | Add `resolveCurrentSession(store, projectLabel, cwd)`. |
| `packages/tim-store/src/project-path-inventory.ts` | New: `KIND_PROJECT_PATH`, `upsertProjectPathRow`, `listProjectPathRows`, staleness helper. |
| `packages/tim-store/src/session-tree.ts` | Align `MARKER_LOCK` re-export with the relocated lock. |
| `packages/tim-store/src/index.ts` | Export the new primitives. |
| `packages/tim-hooks/src/marker.ts` | v3 schema, v1/v2 read normalization, delete `rotateMarkerSession` + `reconcileMarker`, relocate lock to `.tim/summarizer.lock`. |
| `packages/tim-hooks/src/checkpoint.ts` | Write marker only when missing; cadence reminder from `deriveCounters`. |
| `packages/tim-hooks/src/cadence-runner.ts` | Drop marker read/write; counters from `deriveCounters` only. |
| `packages/tim-hooks/src/session-hooks.ts` | Summarizer gate on label-only marker + `resolveCurrentSession` + session-metadata `batch_size`. |
| `packages/tim-hooks/src/project-creation.ts` | v3 marker output; `recoverProjectBinding` backfills `metadata.path` + inventory row; drop `sessionId` from its args. |
| `packages/tim-hooks/scripts/tim-session-start.sh` | Delete the session-rotation block. |
| `packages/tim-cli/src/statusline.ts` | Session via `--session` arg else `resolveCurrentSession`; counters type decoupled from marker. |
| `packages/tim-cli/src/record-commit.ts` | Session via `--session` flag else `resolveCurrentSession`. |
| `packages/tim-cli/src/cli.ts` | v3 phantom-repair write; doctor binding section + `--bind`. |
| `packages/tim-cli/src/migrate-from-hmem.ts` | Closing per-project binding-state report. |
| `packages/tim-mcp/src/server.ts` | Replace four `marker.session` fallbacks with payload/`resolveCurrentSession`; remove `rotateMarkerSession` call. |
| `packages/tim-skills/skills/tim-project-curate/SKILL.md` + `src/tim-project-curate.ts` | Fix-order entry: doctor binding findings → `tim bind-project`. |
| `packages/tim-skills/skills/tim-hmem-import-audit/*` + `src/tim-hmem-import-audit.ts` | Mandatory post-import binding step. |
| `docs/hmem-to-tim-migration.md` | Runbook closing step: bind every imported project. |
| `docs/tim-cli-reference.md` | Document v3 marker, `doctor --bind`, enriched `bind-project`. |
| Package `__tests__` mirrors of every file above | Red/green coverage per task. |
| `packages/*/dist/**` | Rebuilt committed outputs. |

### Task 1: Store primitives — `resolveCurrentSession` and the path inventory

**Files:**
- Modify: `packages/tim-store/src/session.ts`
- Create: `packages/tim-store/src/project-path-inventory.ts`
- Modify: `packages/tim-store/src/index.ts`, `packages/tim-store/src/session-tree.ts`
- Test: `packages/tim-store/src/__tests__/resolve-current-session.test.ts`, `packages/tim-store/src/__tests__/project-path-inventory.test.ts`

- [ ] **Step 1: Write failing tests**

`resolveCurrentSession`: create a project, start two sessions via `SessionManager.startProjectSession` with different `cwd`s, assert the helper returns the latest session for the matching cwd, `null` for an unknown cwd, and the newest one when two sessions share a cwd.

`project-path-inventory`: upserting the same `(device, path)` twice yields one row with an advanced `last_seen_at`; two devices yield two rows; `listProjectPathRows` returns rows with device/path/last_seen_at; staleness helper flags a row older than the threshold.

- [ ] **Step 2: Run focused tests and observe red**

Run: `npx vitest run packages/tim-store/src/__tests__/resolve-current-session.test.ts packages/tim-store/src/__tests__/project-path-inventory.test.ts`

- [ ] **Step 3: Implement**

In `session.ts`:

```ts
/** Latest kind=session entry for a project whose metadata.cwd matches. */
export async function resolveCurrentSession(
  store: TimStore,
  projectLabel: string,
  cwd: string,
): Promise<Entry | null>
```

Resolution: project root → `Sessions` section → `kind=session` children filtered by `metadata.cwd === path.resolve(cwd)`, newest by `created_at` (fall back to newest session regardless of cwd only when the caller passes `cwd: undefined` — the MCP HTTP fallbacks need that mode).

New `project-path-inventory.ts`:

```ts
export const KIND_PROJECT_PATH = 'project-path';
export async function upsertProjectPathRow(
  store: TimStore, projectId: string, device: string, absPath: string,
): Promise<Entry>;
export async function listProjectPathRows(store: TimStore, projectId: string): Promise<Entry[]>;
export function isStalePathRow(row: Entry, now?: number, maxAgeDays?: number): boolean;
```

Each row is its own child entry of the project root (`metadata: { kind, device, path, last_seen_at }`) — never a map on the root node, per the spec's LWW rationale. Use the same device identifier the sync layer stamps into `lww_device`.

- [ ] **Step 4: Green, then commit**

```bash
git add packages/tim-store/src packages/tim-store/src/__tests__
git commit -m "feat(tim-store): resolveCurrentSession and project-path inventory"
```

### Task 2: Marker v3 schema and lock relocation

**Files:**
- Modify: `packages/tim-hooks/src/marker.ts`, `packages/tim-hooks/src/constants.ts`, `packages/tim-hooks/src/index.ts`
- Test: `packages/tim-hooks/src/__tests__/marker.test.ts`

- [ ] **Step 1: Write failing tests**

- A v2 file on disk reads as `{ version: 3, project: 'P0063' }` — runtime fields ignored; a v1 file likewise; label validation and corrupt-shadowing unchanged.
- `writeMarker(dir, { project: 'P0063' })` produces exactly the two-field v3 JSON; `writeMarkerExclusive` ditto and still no-clobbers.
- `rotateMarkerSession` and `reconcileMarker` no longer exist (`expect(m).not.toHaveProperty(...)` on the module namespace).
- Lock tests target `.tim/summarizer.lock` under cwd, same TTL semantics; a leftover `.tim-project.lock` is ignored.

- [ ] **Step 2: Red**

Run: `npx vitest run packages/tim-hooks/src/__tests__/marker.test.ts`

- [ ] **Step 3: Implement**

```ts
export const MARKER_VERSION = 3;
export interface ProjectMarker { version: 3; project: string }
export type ProjectMarkerInput = { project: string; version?: 3 };
```

`normalizeMarker` keeps only the label checks and returns the v3 shape; `readCanonicalProject` returns `{ version: 3, project }`. Delete `rotateMarkerSession`, `reconcileMarker`, and their exports. `syncNearestProjectMarker` drops the `sessionId` option. Lock path becomes `path.join(cwd, '.tim', 'summarizer.lock')` (create `.tim/` on acquire); update `MARKER_LOCK` naming to `SUMMARIZER_LOCK` and re-export a deprecated alias so `tim-store/session-tree.ts` compiles until Task 8 aligns it.

- [ ] **Step 4: Green, then commit**

```bash
git add packages/tim-hooks/src/marker.ts packages/tim-hooks/src/constants.ts packages/tim-hooks/src/index.ts packages/tim-hooks/src/__tests__/marker.test.ts
git commit -m "feat(tim-hooks): v3 label-only marker, relocate summarizer lock"
```

### Task 3: Hooks consumers — checkpoint, cadence, summarizer gate, start script

**Files:**
- Modify: `packages/tim-hooks/src/checkpoint.ts`, `packages/tim-hooks/src/cadence-runner.ts`, `packages/tim-hooks/src/session-hooks.ts`, `packages/tim-hooks/src/phantom-recovery.ts`, `packages/tim-hooks/scripts/tim-session-start.sh`
- Test: `packages/tim-hooks/src/__tests__/hooks.test.ts`, `packages/tim-hooks/src/__tests__/auto-load.test.ts`, `packages/tim-hooks/src/__tests__/session-start-script.test.ts`

- [ ] **Step 1: Write failing tests**

- `runSessionStart` on a dir with a valid marker performs **no marker write** (assert mtime/bytes unchanged); on a marker-less dir with explicit `projectId` it writes a v3 marker; `:memory:` stores still skip writes.
- The cadence reminder appears when `deriveCounters(sessionId)` reports exchanges > 0 — no marker counters involved.
- `afterExchangeLogged` returns DB-derived counts with and without a marker present, and no longer writes any file.
- `maybeSpawnSummarizer(store, cwd, { sessionId })` uses the passed session; without one it resolves via `resolveCurrentSession(store, marker.project, cwd)`; `batch_size` comes from session metadata; spawn/skip/lock decisions match today's fixtures against `.tim/summarizer.lock`.
- `tim-session-start.sh` output contains no rotation block; the directive text is unchanged.

- [ ] **Step 2: Red**

Run: `npx vitest run packages/tim-hooks/src/__tests__`

- [ ] **Step 3: Implement**

`checkpoint.ts`: in `runSessionStart`, replace the unconditional `writeMarker` with write-if-absent (v3, only when binding was explicit or auto-created); replace the `marker.exchanges` reminder block with `deriveCounters(store, params.sessionId)`. `validateMarkerAgainstStore` callers construct `{ version: 3, project }` probes. `cadence-runner.ts`: delete `readMarker`/`reconcileMarker`/`writeMarker`; single `deriveCounters` path. `session-hooks.ts`: `maybeSpawnSummarizer` gains an optional `sessionId`; `detectProject` now yields the label only. Delete the rotation block (lines 63–74) from `tim-session-start.sh`.

- [ ] **Step 4: Green, then commit**

```bash
git add packages/tim-hooks/src packages/tim-hooks/scripts packages/tim-hooks/src/__tests__
git commit -m "refactor(tim-hooks): store-authoritative session and counters"
```

### Task 4: CLI consumers — statusline, record-commit, phantom repair

**Files:**
- Modify: `packages/tim-cli/src/statusline.ts`, `packages/tim-cli/src/record-commit.ts`, `packages/tim-cli/src/cli.ts`
- Test: `packages/tim-cli/src/__tests__/record-commit.test.ts`, statusline tests

- [ ] **Step 1: Write failing tests**

- Statusline for a bound dir with an active session renders `<name> · n/5 exchanges · summary in k` from DB counters, resolving the session via `resolveCurrentSession` when no `--session` is given; a bound dir with no session renders `0/5`; `no project` path unchanged.
- `record-commit` without `--session` records under the project's current session for cwd; with `--session` it honors the flag; silent skip without marker unchanged.
- Phantom repair (`cli.ts:326`) writes a v3 marker.

- [ ] **Step 2: Red**

Run: `npm run build && npx vitest run packages/tim-cli/src/__tests__/record-commit.test.ts packages/tim-cli/src/__tests__/resolve-project.test.ts`

- [ ] **Step 3: Implement**

`statusline.ts`: replace `reconcileMarkerCounters(store, marker)` with a `StatuslineCounters { project, exchanges, batchSize, batchesSummarized }` resolved from `opts.sessionId ?? resolveCurrentSession(...)` + `deriveCounters` + session-metadata `batch_size` (keep the 5s cache keyed by session id); `formatTimStatusLine`/`formatHermesStatus` take that type instead of `ProjectMarkerInput`. `record-commit.ts:22`: `flags.session ?? (await resolveCurrentSession(store, located.marker.project, dir))?.id`.

- [ ] **Step 4: Green, then commit**

```bash
git add packages/tim-cli/src packages/tim-cli/src/__tests__
git commit -m "refactor(tim-cli): derive statusline and commit sessions from the store"
```

### Task 5: MCP server session fallbacks

**Files:**
- Modify: `packages/tim-mcp/src/server.ts` (call sites near lines 1589, 2167, 2728, 2740, 2962)
- Test: `packages/tim-mcp/src/__tests__/http-session-identity.test.ts` and the suites covering those tools

- [ ] **Step 1: Write failing tests**

For each tool that used `findConfiguredMarker(...)?.marker.session`: with no explicit session argument, the tool resolves the current session for the marker-bound project via `resolveCurrentSession`; HTTP transport still never guesses cwd (existing `vcs-project-path-wiring` behavior preserved).

- [ ] **Step 2: Red**

Run: `npm run build && npx vitest run packages/tim-mcp/src/__tests__`

- [ ] **Step 3: Implement**

Replace the four `marker.session` reads with a small `resolveMarkerSession(store, cwd)` helper (marker label → `resolveCurrentSession`); delete the `rotateMarkerSession` import and call (the marker no longer stores a session). Tool schemas and descriptions that mention marker session fields get updated text.

- [ ] **Step 4: Green, then commit**

```bash
git add packages/tim-mcp/src
git commit -m "refactor(tim-mcp): resolve sessions from the store, not the marker"
```

### Task 6: `bind-project` enrichment

**Files:**
- Modify: `packages/tim-hooks/src/project-creation.ts`
- Test: `packages/tim-hooks/src/__tests__/project-creation.test.ts`, `packages/tim-cli/src/__tests__/resolve-project.test.ts`

- [ ] **Step 1: Write failing tests**

`recoverProjectBinding`: a successful bind writes the v3 marker, backfills `metadata.path` when absent (and leaves an existing canonical path untouched), and upserts this device's `project-path` row; same-label rebind stays a byte-identical no-op; different-label marker still refuses with both labels in the message; `sessionId` is gone from the argument type.

- [ ] **Step 2: Red**

Run: `npx vitest run packages/tim-hooks/src/__tests__/project-creation.test.ts`

- [ ] **Step 3: Implement**

After the existing no-clobber write + verification, add the `metadata.path` backfill (`store.update` only when unset) and `upsertProjectPathRow`. `createProjectCoordinated`'s bound branch does the same inventory upsert (it already owns `metadata.path`).

- [ ] **Step 4: Green, then commit**

```bash
git add packages/tim-hooks/src/project-creation.ts packages/tim-hooks/src/__tests__ packages/tim-cli/src/__tests__
git commit -m "feat(tim-hooks): bind-project backfills path and seeds the inventory"
```

### Task 7: Doctor binding section and `--bind`

**Files:**
- Modify: `packages/tim-cli/src/cli.ts` (`cmdDoctor`)
- Test: `packages/tim-cli/src/__tests__/doctor-bindings.test.ts` (new)

- [ ] **Step 1: Write failing tests**

Fixtures: project A (`metadata.path` → existing dir, no marker) ⇒ `unbound`; project B (path → dir whose marker names another label) ⇒ `label-mismatch`; project C (path → missing dir) ⇒ `path-missing`; project D (no path) ⇒ `no-path`; one stale inventory row is listed. Default run: report only, zero filesystem writes (snapshot the tree). `tim doctor --bind`: A becomes bound via the `recoverProjectBinding` path and reports `bound` on re-run; B, C, D untouched; a marker racing in between detection and write is not clobbered (inject through the exclusive writer as in the creation tests).

- [ ] **Step 2: Red**

Run: `npm run build && npx vitest run packages/tim-cli/src/__tests__/doctor-bindings.test.ts`

- [ ] **Step 3: Implement**

Add a `Bindings` section to `cmdDoctor` output — one line per project with `metadata.path` plus stale inventory rows — and the `--bind` flag that loops `unbound` findings through `recoverProjectBinding`, printing per-project outcomes. No other finding class is ever written.

- [ ] **Step 4: Green, then commit**

```bash
git add packages/tim-cli/src/cli.ts packages/tim-cli/src/__tests__/doctor-bindings.test.ts
git commit -m "feat(tim-cli): doctor binding report with opt-in --bind"
```

### Task 8: Migration report, runbook, skills, docs, store re-export

**Files:**
- Modify: `packages/tim-cli/src/migrate-from-hmem.ts`
- Modify: `docs/hmem-to-tim-migration.md`, `docs/tim-cli-reference.md`
- Modify: `packages/tim-skills/skills/tim-project-curate/SKILL.md`, `packages/tim-skills/src/tim-project-curate.ts`
- Modify: `packages/tim-skills/skills/tim-hmem-import-audit/SKILL.md` (or its source module), `packages/tim-skills/src/tim-hmem-import-audit.ts`
- Modify: `packages/tim-store/src/session-tree.ts` (drop the stale `MARKER_LOCK` duplicate)
- Test: `packages/tim-skills/src/__tests__/skills.test.ts`, migrate-from-hmem tests

- [ ] **Step 1: Write failing tests**

- Migration wizard output ends with a binding-state line per imported `kind=project` (`bound` / `unbound` / `no-path`) from fixtures.
- Skills guards: curate skill text contains the doctor-findings fix-order entry and `tim bind-project`; import-audit skill text contains the mandatory binding step and the hand-written-marker prohibition; both in `SKILL.md` and the runtime export.

- [ ] **Step 2: Red**

Run: `npx vitest run packages/tim-skills/src/__tests__/skills.test.ts packages/tim-cli/src/__tests__ -t 'migrate|binding'`

- [ ] **Step 3: Implement**

Wizard: after the health check, classify each imported project against this device (reusing the doctor classification helper — extract it into `tim-hooks` or `tim-cli` shared module, not duplicated). Runbook: add the closing step — for every imported project, bind via `tim bind-project` (asking the user for directories when `metadata.path` is absent) or record it as intentionally memory-only; never hand-write markers. Curate skill fix order gains: "Doctor `unbound`/`label-mismatch` finding → confirm directory with user, then `tim bind-project`; never overwrite a mismatched marker without explicit user decision." CLI reference: v3 marker shape, `doctor --bind`, enriched `bind-project` side effects, `.tim/summarizer.lock`.

- [ ] **Step 4: Green, then commit**

```bash
git add packages/tim-cli/src packages/tim-skills docs packages/tim-store/src/session-tree.ts
git commit -m "feat: migration binding report, curate/audit binding obligations"
```

### Task 9: Rebuild, repo gates, spec status

**Files:**
- Modify generated: `packages/*/dist/**`
- Modify: `docs/superpowers/specs/2026-07-19-marker-slimming-design.md` (status line)

- [ ] **Step 1: Clean build and gates**

```bash
npm run clean && npm run build
npm run lint
npm test
git diff --check && git status --short
```

Expected: all green; only intended source/docs/dist changes staged.

- [ ] **Step 2: Grep-audit the deletions**

```bash
rg -n "rotateMarkerSession|reconcileMarker|batches_summarized|\.tim-project\.lock" packages/*/src packages/*/scripts
```

Expected: no hits outside historical docs/changelog (marker runtime fields survive only in `deriveCounters`' return names inside `tim-store`).

- [ ] **Step 3: Commit dist and flip the spec status to Implemented**

```bash
git add packages/*/dist docs/superpowers/specs/2026-07-19-marker-slimming-design.md
git commit -m "chore: rebuild dist for marker slimming"
```

## Self-review checklist

- [ ] `.tim-project` on disk is exactly `{version, project}` and nothing rewrites it during normal session traffic.
- [ ] Every former `marker.session` reader (statusline, record-commit, summarizer gate, four MCP call sites) uses the payload session or `resolveCurrentSession`.
- [ ] Counters come from `deriveCounters` alone; `reconcileMarker`, `rotateMarkerSession`, and the counter fields are gone from the codebase.
- [ ] The summarizer lock lives at `.tim/summarizer.lock` with unchanged TTL semantics.
- [ ] `project-path` rows are one entry per device; a two-device sync round keeps both; no resolution path reads them.
- [ ] `tim bind-project` is the only marker-writing path for repair/migration/doctor; it backfills `metadata.path` and seeds the inventory.
- [ ] `tim doctor` without flags performs zero filesystem writes; `--bind` closes only `unbound` findings and never clobbers a racing marker.
- [ ] Migration ends with a per-project binding report; runbook, import-audit skill, and curate skill carry the binding obligations verbatim.
- [ ] v1/v2 markers keep resolving read-only; corrupt-shadowing, P9999 gate, and unsafe-dir refusals hold on v3.
- [ ] Lint, full test suite, clean rebuild, and committed dist are green.
