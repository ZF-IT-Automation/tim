# PLAN — P0063 Bugs (FTS / project-label lookup + projectId validation)

Date: 2026-06-03 · Author: PLAN agent · Status: ready to execute

## TL;DR

Brief's two hypotheses are **reproduced as symptoms but partly misdiagnosed as causes**.
Empirical testing against the *current* built code (`packages/*/dist`) shows:

- **`tim_load_project` / `tim_read_project` "not found" → NOT a current code bug.** Already fixed
  in commit `cc40624` (`resolveProjectLabel` + `read()` metadata.label fallback). The live failure
  was **stale deployed code**. → remediation = redeploy + re-verify on the live server.
- **`tim_search("P0063")` empty → GENUINE bug.** FTS5 indexes only `title/content/tags`, never
  `metadata`. Labels/aliases live in `metadata` → never in the search corpus. NOT a staleness/trigger
  issue (triggers fire synchronously; `search("Infinite")` works). → CODE FIX needed.
- **projectId validation → mostly already enforced** in current code (`write`, `record_commit`,
  `session_start` all throw `Project not found`). Two REAL residual gaps:
  1. **`createProject` enforces no label uniqueness** → duplicate `P0063` entries already exist in
     the live DB; `read()`'s `.get()` then non-deterministically returns the wrong one. CODE FIX.
  2. Validation uses `store.read()` (P-label regex fallback only), **not `resolveProjectLabel`**, so
     valid **aliases are wrongly rejected** (`recordCommit("o9k")` throws though P0048 exists). CODE FIX.

So: the single highest-impact action is **redeploy current code + clean the duplicate**, then ship
two small code fixes (FTS label search, createProject uniqueness) and one consistency fix
(validate via `resolveProjectLabel`).

---

## Evidence (reproduced, not theorized)

Clean-DB repro against `packages/tim-store/dist` (current build):

```
created.id = ubun-0603-ns-01KT6EQ...      # formatEntryId, NOT "P0063"
created.metadata = {"kind":"project","label":"P0063"}
read(created.id)            => ubun-0603-ns-...   OK (primary key)
read("P0063")               => ubun-0603-ns-...   OK (metadata.label fallback)
resolveProjectLabel("P0063")=> {"status":"found"} OK
loadProject("P0063")        => ubun-0603-ns-...   OK   ← brief said "not found" → stale deploy
search("P0063")             => []                 BUG  ← label not in FTS corpus
search("Infinite")          => [ubun-0603-ns-...] OK   ← proves FTS+triggers work
```

Validation repro:

```
recordCommit("P9999")  => THROW "Project not found: P9999"   (validation EXISTS)
recordCommit("P0048")  => OK                                  (valid label)
recordCommit("o9k")    => THROW "Project not found: o9k"      BUG: alias rejected
```

Live DB (`~/.tim/tim.db`) — **two** `kind=project` entries with `label=P0063`:

```
01KSTQ4AB1...                 title "TIM — ... | Active | TS/SQLite/MCP | ..."   (full brief)
ubun-0603-ns-01KT6DRBQF...    title "TIM — Theoretically Infinite Memory"        (stub, made today)
```

`createProject` never checked uniqueness → both coexist → `read("P0063")` returns whichever has the
lower rowid. This is the concrete proof of the "pure convention, no enforced constraint" the brief
described, and it can silently load the wrong project tree.

---

## Why the brief's mental model was off

| Brief hypothesis | Reality |
|---|---|
| "Label lookups use FTS/metadata-index not updated synchronously with write" | `better-sqlite3` is synchronous + WAL; no data/index staleness is possible in-process. `resolveProjectLabel`/`loadProject` use a direct `json_extract` read, not FTS, and work in current code. The only thing that can be stale is the **deployed JS**. |
| "Direct-ID works because it hits the primary key" | Half-right. `tim_read("P0063")` does NOT hit the PK (ids are `formatEntryId` ULIDs); it succeeds via the `/^[A-Z]\d{4}$/` → `metadata.label` fallback in `read()` (store.ts:84-88). |
| "create_project doesn't trigger reindex" | The `entries_ai` AFTER INSERT trigger DOES reindex FTS synchronously and correctly. The label simply isn't in any indexed column. Reindex is not the problem; **corpus coverage** is. |
| "No projectId validation anywhere" | `write`(parentTitle path), `record_commit`, `session_start` all already validate existence. Gaps are narrower: no uniqueness on create, and alias-blind validation. |

---

## Code map (where things live)

- FTS schema + triggers: `packages/tim-store/src/schema.ts`
  - `MIGRATIONS` v1/v4 create `fts_entries USING fts5(title, content, tags, content='entries', content_rowid='rowid')`
  - `createTriggers()` — `entries_ai/ad/au` keep FTS in sync (synchronous, correct)
- Search: `packages/tim-store/src/store.ts` → `search()` (566) → `searchFts()` (570) — FTS MATCH only
- Project create: `store.ts` → `createProject()` (134-147) — **no uniqueness check**
- Label resolution: `store.ts` → `resolveProjectLabel()` (153-185), `read()` fallback (84-88)
- Validation surfaces:
  - `session.ts` → `startProjectSession()` (132) — validates at lines 139 & 165 via `store.read()`
  - `commit.ts` → `ensureCommitsSection()` (26-39) — validates via `store.read()`
  - `server.ts` `tim_write` (967) — validates only the parentTitle→section JOIN
- MCP handlers: `packages/tim-mcp/src/server.ts` — `tim_search`(1003), `tim_create_project`(1296),
  `tim_session_start`(1156), `tim_record_commit`(1232), `tim_load_project`(1304), `tim_read_project`(1403)

---

## Fixes

### FIX 0 — Redeploy current code + clean duplicate (do FIRST; resolves load_project/read_project)

This is the biggest lever and a prerequisite for trusting any later verification.

Deploy path is **`npx tim-mcp`** (`~/.tim/mcp.json`), package **unpublished** (npm 404),
version `0.1.0-alpha`, **no `bin` field** (`main: dist/index.js`), with a **dangling
`node_modules/.bin/tim-mcp` symlink** and multiple stale `~/.npm/_npx/*` caches. Provenance of the
running JS is therefore ambiguous — do NOT assume "rebuild = deployed".

Steps:
1. Determine what `npx tim-mcp` actually executes:
   `npm exec --offline -- which tim-mcp` / inspect `~/.npm/_npx/*/node_modules/tim-mcp` and the
   dangling `.bin` link. Identify whether the live server runs workspace `dist/`, a `.bin` link, or
   an npx-cached copy.
2. `npm run build` at repo root (rebuild all `dist/`).
3. **Commit the currently-uncommitted `dist/`** (git status shows `tim-mcp/dist/server.js`,
   `tim-store/dist/session.js`, etc. modified) — otherwise synced/other devices stay stale.
4. If the live server runs an npx cache: clear it (`rm -rf ~/.npm/_npx/*` or targeted) and/or repair
   the local link so `npx tim-mcp` resolves to fresh `dist/`. Consider adding a real `bin` entry to
   `tim-mcp/package.json` to make resolution deterministic (removes the dangling-symlink ambiguity).
5. Restart the TIM MCP server (restart the Claude session / MCP host).
6. De-duplicate `P0063` in `~/.tim/tim.db`: keep the full entry (`01KSTQ4AB1...`), tombstone/merge
   the stub (`ubun-0603-ns-...`). Use the curate path, not raw SQL, so staging/sync stays consistent.
7. **Re-verify on the LIVE server** (CLAUDE.md "Vor Deployment IMMER testen"): `tim_load_project`,
   `tim_read_project`, `tim_read` for P0063 all succeed and return the canonical entry.

### FIX 1 — Make labels/aliases searchable (BUG 1, genuine)

**Recommended (low-risk, no migration): augment `search()` in `store.ts`.**
Run FTS as today, then also resolve the query as a project label/alias and merge that entry in
(dedupe by id, label-hit ranked first). Reuse `resolveProjectLabel`; if `found`, `read()` the label
and prepend.

```ts
async search(options: SearchOptions): Promise<Entry[]> {
  const fts = await this.searchFts(options.query, options.topK ?? 10);
  const resolved = await this.resolveProjectLabel(options.query);   // label OR alias
  if (resolved.status === 'found') {
    const proj = await this.read(resolved.label);
    if (proj && !fts.some(e => e.id === proj.id)) return [proj, ...fts];
  }
  return fts;
}
```

Pros: no schema change, fixes both label and alias search, tiny surface.
Cons: only covers the *project* case (acceptable — that's the reported bug).

**Alternative (broader, higher-risk): extend the FTS corpus.** Add a `labels` column to `fts_entries`
fed by `metadata.label` + `aliases`, via a new migration (drop/recreate fts5 with the extra column,
repopulate from `entries` with `json_extract`, and rewrite `entries_ai/au` triggers to compute it).
More invasive (migration + trigger rewrite + backfill); defer unless general metadata search is wanted.

→ Implement the Recommended option. Note the alternative in a code comment for future scope.

### FIX 2 — Enforce project-label uniqueness on create (BUG 2, genuine)

In `createProject()` (`store.ts:134`), before writing, check for an existing non-tombstoned,
non-irrelevant `kind=project` entry with the same `label`. On conflict: throw
`Project label already exists: ${label}` (or return the existing entry — pick throw for a hard
constraint; safer default). This prevents the duplicate-`P0063` class of bug at the source.

```ts
const dup = this.db.prepare(`
  SELECT id FROM entries
  WHERE json_extract(metadata,'$.kind')='project'
    AND json_extract(metadata,'$.label')=?
    AND irrelevant=0 AND tombstoned_at IS NULL
`).get(label) as { id: string } | undefined;
if (dup) throw new Error(`Project label already exists: ${label} (${dup.id})`);
```

(Optional hardening: a partial unique index can't easily target a JSON path in SQLite without a
generated column; the app-level guard above is the pragmatic enforcement point.)

### FIX 3 — Validate projectId via resolveProjectLabel, not raw read (BUG 2, consistency)

`startProjectSession` (session.ts:138,164) and `ensureCommitsSection` (commit.ts:27) call
`store.read(projectId)`, which only resolves P-label-pattern ids and silently rejects valid
**aliases**. Route these through `resolveProjectLabel` first (canonicalize to the P-label, then read),
so the validation accepts the same identifiers `tim_load_project` does. Handle `ambiguous` explicitly
(throw with the candidate list). This makes validation *consistent*, not looser.

---

## Implementation order & dependencies

1. **FIX 0** (redeploy + dedupe + live re-verify) — unblocks/closes the load_project & read_project
   symptoms; establishes a trustworthy baseline. Do before claiming anything else "works".
2. **FIX 2** (createProject uniqueness) — independent; prevents recurrence of the duplicate. Land early.
3. **FIX 1** (label/alias search) — independent; depends on `resolveProjectLabel` (already present).
4. **FIX 3** (validate via resolveProjectLabel) — independent; pairs naturally with FIX 1 (same helper).
   Sequence FIX 3 after FIX 2 only to keep one PR's tests coherent; no hard dependency.

All four can be one branch; FIX 0's redeploy/commit-dist step gates the final live verification.

---

## Test strategy

Unit (vitest, `packages/tim-store/src/__tests__/`):

- **FIX 1:** create project (with body content so label ∉ title/content), assert
  `search({query: label})` returns it; assert `search({query: alias})` returns it; assert a normal
  content query (`"Infinite"`) still works and isn't duplicated.
- **FIX 2:** `createProject('P0001')` twice → second throws; assert only one project entry exists;
  assert a tombstoned same-label project does NOT block re-create.
- **FIX 3:** `createProject('P0048',{aliases:['o9k']})` then `recordCommit({projectId:'o9k'})`
  succeeds; `startProjectSession({projectId:'o9k'})` binds to P0048; nonexistent → still throws;
  ambiguous alias (two projects share it) → throws with candidates.
- **Regression:** existing `project-resolve.test.ts`, `commit.test.ts`, `session.test.ts`,
  `store.test.ts` stay green (these encode current validation behavior — confirm FIX 3 doesn't
  loosen the nonexistent-project rejection).

Integration / live (after FIX 0 redeploy):

- On the running MCP server: `tim_create_project` a throwaway label, then `tim_search`,
  `tim_load_project`, `tim_read_project` against it; confirm all four agree and return one entry.
- Confirm `~/.tim/tim.db` has exactly one `kind=project` row per label (`GROUP BY label HAVING
  COUNT(*)>1` returns nothing).

---

## Risks / edge cases / what could still bite

- **Tombstoned/irrelevant same-label projects:** FIX 2's guard must exclude them, or legitimate
  re-creation after deletion breaks. (Covered in test.)
- **Alias collisions (FIX 3):** `resolveProjectLabel` already returns `ambiguous`; callers currently
  don't handle it — make them throw, don't let `undefined` slip through.
- **FIX 1 ranking:** prepending the label hit changes result order; fine for the reported use, but
  any caller relying on pure FTS rank should be checked (none found).
- **`tim_search` topK:** prepending may exceed `topK` by one; trim to `topK` after merge if strict.
- **Deploy ambiguity (FIX 0):** if `npx tim-mcp` silently runs a stale npx cache, a rebuild alone
  fixes nothing — verifying resolution (step 1) is mandatory, not optional. Adding a `bin` field is
  the durable fix.
- **Sync fan-out:** the duplicate may have already propagated via staging/`hmem sync`; dedupe on one
  device then push, and check other devices don't re-introduce it.
- **Don't over-build FIX 1:** full metadata FTS indexing is tempting but is a migration + trigger
  rewrite + backfill — out of scope for the reported bug; leave as a documented alternative.
