# Session Tracking & Summarization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every project-bound session a dedicated subtree under its project that logs raw user/agent exchanges and auto-summarizes them in batches, driven by a Stop hook + an external summarizer agent.

**Architecture:** A new nested tree (`Sessions → <session> → {Summary, Exchanges}`) lives under each project. Raw exchanges accumulate under `Exchanges`; an external CLI summarizer reads unsummarized batches via a new MCP tool and writes `Batch` summary nodes under `Summary`. **All "what's summarized" state is derived from the DB tree** — the `.tim-project` marker file is only a rebuildable cache the Stop hook uses to decide whether to spawn the summarizer. New behavior is **additive**: legacy root-level sessions keep working unchanged.

**Tech Stack:** TypeScript (ESM, `.js` import specifiers), `better-sqlite3`, `ulid`, `zod`, `@modelcontextprotocol/sdk`, `vitest`. Monorepo packages: `tim-core`, `tim-store`, `tim-mcp`, `tim-hooks`.

---

## 0. Read-this-first: the two constraints that shape everything

Before any code, internalize the two hard constraints discovered in the codebase. Every design choice below follows from them.

### Constraint A — `loadProject` depth, NOT `render_depth`, is what keeps exchanges out

`render_depth` (`packages/tim-store/src/project-output.ts:122-141`) is consumed **only by the output formatter**. `loadProject` (`packages/tim-store/src/store.ts:109-158`) ignores it entirely and walks children purely by its `depth` (default 3) and `budget` (default 200) parameters.

What actually keeps raw exchanges out of `load_project` is the **traversal depth**:

```
loadChildren(project,  currentDepth=1)  → loads Sessions section
loadChildren(Sessions, currentDepth=2)  → loads <session> nodes
loadChildren(<session>,currentDepth=3)  → loads Summary + Exchanges nodes
loadChildren(Summary,  currentDepth=4)  → 4 > depth(3) → STOPS (Batch nodes NOT loaded)
loadChildren(Exchanges,currentDepth=4)  → 4 > depth(3) → STOPS (messages NOT loaded)
```

So at the default `depth:3`, `load_project` loads `Summary` and `Exchanges` **nodes** but not their children. `render_depth: 0` on those nodes is still set — it makes the **formatter** collapse them — but it is documentation, not a load filter. **A `tim_load_project(depth:5)` call WILL pull every raw exchange.** We accept this (Design Decision D2) rather than re-plumbing `loadProject`.

### Constraint B — entry `depth` caps at 5, and the existing SessionManager contract is flat

- `store.write` computes `depth = min(parent.depth + 1, 5)` (`store.ts:269-275`). Project(1)→Sessions(2)→session(3)→Exchanges(4)→userMsg(5)→agentReply(6→**capped to 5**). The cap is harmless (we never rely on `depth` to distinguish nodes — we use `metadata.kind`, `role`, `seq`), but the plan must not assume `depth` uniquely identifies a level.
- The current `SessionManager` (`packages/tim-store/src/session.ts`) writes exchanges as **flat siblings** directly under the session id, and `checkpoint`/`getSessionExchanges` read **direct children** of the session id. The nested model breaks both. We keep the old path working (Design Decision D3).

---

## 1. Architecture Overview

### 1.1 Target tree structure

```
P0062  (kind: 'project', depth 1)
└── Sessions                          kind: 'sessions-root'  · render_depth: 0 · order: 1000
    └── 2026-06-01-1123               kind: 'session'  · id = harness sessionId · title = date-time
        │                               metadata: { date, batch_size, summarizer:{cli,model},
        │                                           project_ref, exchange_count*, batches_summarized* }
        │                               (* = cached convenience copies; DB tree is authoritative)
        ├── Summary                   kind: 'session-summary-root' · tags: ['#session-summary']
        │   │                           metadata: { exchanges, date, summary }  (read by existing rollup)
        │   ├── Batch 1               kind: 'batch-summary' · metadata: { batch_index:1, seq_from:1, seq_to:5 }
        │   └── Batch 2               kind: 'batch-summary' · metadata: { batch_index:2, seq_from:6, seq_to:10 }
        └── Exchanges                 kind: 'exchanges-root' · render_depth: 0
            ├── "User message 1"      kind: 'exchange' · role: 'user'  · seq: 1   (depth 5)
            │   └── "Agent reply 1"   kind: 'exchange' · role: 'agent' · seq: 1   (child of user; depth 5)
            ├── "User message 2"      kind: 'exchange' · role: 'user'  · seq: 2
            │   └── "Agent reply 2"   kind: 'exchange' · role: 'agent' · seq: 2
            └── …
```

Key points:

- **Session node id = the harness `sessionId`** (so later `tim_session_log` calls find it via `store.read`). Its **title** is the human date-time string.
- **One "exchange" = one user-message node (with its agent-reply child).** `seq` increments **only on user nodes**; the agent reply inherits its parent's `seq` for traceability.
- **`Summary` is tagged `#session-summary`** and carries `{exchanges, date, summary}` metadata so the *existing* rollup in `project-output.ts:252-284` renders it **for free** — it filters `children` by that tag across the whole flat result set, and the default `tim_load_project(depth:3)` reaches Summary. `buildCortexReadyBlock` (`server.ts:333-369`) uses the same tag filter but loads with `depth:1`, so it needs a depth bump to see Summary nodes (Task 9 Step 6).

### 1.2 Counters are DERIVED, never trusted from the marker

| Quantity | Authoritative source (DB) | Cache (rebuildable) |
|----------|---------------------------|---------------------|
| `exchange_count` | `getChildren(ExchangesNodeId)` filtered `role === 'user'` → `.length` | `session.metadata.exchange_count`, `.tim-project.exchanges` |
| `batches_summarized` | `getChildren(SummaryNodeId, {metadataKind:'batch-summary'})` → `.length` | `session.metadata.batches_summarized`, `.tim-project.batches_summarized` |

The marker and session metadata are *mirrors* for fast hook decisions. Every consumer (`showUnsummarized`, the Stop hook) **re-derives from the DB** before acting. This collapses all three required edge cases (crash mid-batch, counter desync, summarizer failure) into "re-derive and continue" (see §8).

---

## 2. Design Decisions (explicit — user may veto any)

- **D1 — DB tree is the single source of truth.** `.tim-project` and `session.metadata` counters are caches reconciled from the DB on every read. The vision's "counter is source of truth" is implemented as "the *derived* count is the source of truth; the stored counter is a cache."
- **D2 — `render_depth:0` is formatter-only; rely on `loadProject` `depth` for bloat control.** We set `render_depth:0` on `Sessions` and `Exchanges` for the formatter, and depend on the default `depth:3` to keep raw exchanges unloaded. We do **not** modify `loadProject` recursion. Documented caveat: `depth:5` loads everything. (Optional hardening task §6 Task 12 if a guarantee is later required.)
- **D3 — Additive, backward-compatible.** `sessionStart`/`sessionLog`/`checkpoint` gain a *project-bound* path keyed on an optional `projectId`. Without `projectId`, behavior is byte-for-byte unchanged, so all existing tests in `session.test.ts` stay green. New methods/tests cover the nested path.
- **D4 — Marker I/O lives in `tim-hooks` (runs with project cwd); DB counters live in `tim-store`/`tim-mcp`.** `tim_session_log` must **never** touch `.tim-project` — the MCP server's `process.cwd()` is not reliably the project dir.
- **D5 — Summary node wired into the existing `#session-summary` rollup.** The `project-output.ts` rollup renders nested Summary nodes **for free** at the default `tim_load_project(depth:3)` (Summary sits at traversal level 3). The `buildCortexReadyBlock` rollup does **not** get it for free — it calls `loadProject(depth:1)`, which returns only the `Sessions` section node and never descends to Summary nodes; its depth must be bumped (Task 9 Step 6). One small exclusion edit (Task 8) keeps the `Sessions` *section* node from double-rendering.
- **D6 — Summarizer batch write is the single atomic final step.** The summarizer's last action is one `store.write` of the `Batch` node. A crash before that leaves `batches_summarized` underived-unchanged → safe re-run. Idempotency guaranteed by counting existing `Batch` nodes.
- **D7 — Stop hook single-flights via a lockfile** (`.tim-project.lock`) so two Stop events can't summarize the same range concurrently.
- **D8 — Legacy sessions are not migrated.** Existing root-level `kind:'session'`/`kind:'checkpoint'` entries remain readable in place; no re-homing (see §7).

---

## 3. File Structure

| File | New/Modify | Responsibility |
|------|------------|----------------|
| `packages/tim-store/src/store.ts` | Modify | Add `getChildByKind(parentId, kind)` and `getChildrenBySeq(parentId)` helpers. |
| `packages/tim-store/src/session.ts` | Modify | Add project-bound session tree: `startProjectSession`, nested `logExchange`, `showUnsummarized`, `writeBatchSummary`, `rollUpSession`; make `getSessionExchanges`/`checkpoint` tree-aware (fallback to legacy). |
| `packages/tim-store/src/session-tree.ts` | **New** | Pure constants + helpers: node kinds, titles, `deriveCounters`, locating `Sessions`/`Summary`/`Exchanges` nodes. Keeps `session.ts` focused. |
| `packages/tim-store/src/project-output.ts` | Modify | Exclude `kind:'sessions-root'` from the Sections list (D5). |
| `packages/tim-store/src/index.ts` | Modify | Export new types/functions. |
| `packages/tim-mcp/src/server.ts` | Modify | `projectId` on `tim_session_start`; nested `tim_session_log`; register `tim_show_unsummarized` (READ tool). |
| `packages/tim-hooks/src/marker.ts` | **New** | `.tim-project` read/write/reconcile; project detection order; lockfile single-flight. |
| `packages/tim-hooks/src/session-hooks.ts` | **New** | Stop-hook entry: reconcile from DB, decide, spawn summarizer detached. |
| `packages/tim-hooks/src/index.ts` | Modify | Export marker + session-hook APIs. |
| `packages/tim-store/src/__tests__/session.test.ts` | Modify | Add project-bound lifecycle, `showUnsummarized`, batch/roll-up, idempotency tests. |
| `packages/tim-hooks/src/__tests__/marker.test.ts` | **New** | Marker reconcile + project detection + lockfile tests. |
| `packages/tim-hooks/src/__tests__/session-hooks.test.ts` | **New** | Spawn-decision tests (injected spawner). |

**Shared constants (define once in `session-tree.ts`, import everywhere):**

```typescript
export const SESSIONS_SECTION_TITLE = 'Sessions';
export const SUMMARY_NODE_TITLE = 'Summary';
export const EXCHANGES_NODE_TITLE = 'Exchanges';
export const SESSIONS_SECTION_ORDER = 1000; // sorts AFTER schema sections so budget truncation hits sessions, not real content

export const KIND_SESSIONS_ROOT = 'sessions-root';
export const KIND_SESSION = 'session';
export const KIND_SUMMARY_ROOT = 'session-summary-root';
export const KIND_BATCH = 'batch-summary';
export const KIND_EXCHANGES_ROOT = 'exchanges-root';
export const KIND_EXCHANGE = 'exchange';

export const SESSION_SUMMARY_TAG = '#session-summary';
export const DEFAULT_BATCH_SIZE = 5;
export const SESSION_ROLLUP_THRESHOLD = 3; // roll up Summary when batches_summarized >= this
export const MARKER_FILENAME = '.tim-project';
export const MARKER_LOCK = '.tim-project.lock';
```

---

## 4. Data Flow: marker → hook → summarizer → write back

```
┌────────────────────────────────────────────────────────────────────────────┐
│ DURING SESSION (MCP server, cwd-agnostic, DB-authoritative)                 │
│                                                                            │
│  tim_session_start({sessionId, projectId})                                  │
│     └─ SessionManager.startProjectSession                                    │
│          ├─ find/create Sessions section under project (order 1000)         │
│          ├─ create <session> node (id = sessionId)                          │
│          ├─ create Summary node (tag #session-summary, render_depth 0 N/A)  │
│          └─ create Exchanges node (render_depth 0)                          │
│                                                                            │
│  tim_session_log({sessionId, entries:[{role,content}]})                     │
│     └─ SessionManager.logExchange                                           │
│          ├─ locate Exchanges node                                          │
│          ├─ user entry  → new child of Exchanges, seq = lastUserSeq+1       │
│          ├─ agent entry → child of the current/last user node              │
│          └─ refresh session.metadata cache (exchange_count) — DB stays auth │
└────────────────────────────────────────────────────────────────────────────┘
                                   │  (session ends → harness fires Stop hook)
                                   ▼
┌────────────────────────────────────────────────────────────────────────────┐
│ STOP HOOK (tim-hooks, runs with PROJECT cwd)                                 │
│                                                                            │
│  1. readMarker(cwd)  → {project, session, batch_size, summarizer}           │
│       detection order: (1) .tim-project, (2) session-binding cache, (3) skip│
│  2. reconcileFromDb(store, session):                                        │
│       exchange_count      = count user nodes under Exchanges  (DB)          │
│       batches_summarized  = count Batch nodes under Summary   (DB)          │
│  3. pending = exchange_count - batches_summarized * batch_size              │
│  4. if pending >= batch_size:                                              │
│       acquireLock(.tim-project.lock)  ── single-flight (D7)                  │
│       spawn summarizer DETACHED + unref  ── does NOT block session end      │
│       writeMarker(reconciled counters)                                      │
└────────────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌────────────────────────────────────────────────────────────────────────────┐
│ SUMMARIZER AGENT (external CLI, e.g. `claude -p --model haiku`)             │
│                                                                            │
│  A. tim_show_unsummarized({sessionId})                                      │
│       → { sessionId, summaryNodeId, batchIndex, batchSize,                  │
│           exchanges:[{seq,userContent,agentContent}], hasMore }            │
│  B. read raw exchanges, summarize thematically                             │
│  C. tim_write({ parentId: summaryNodeId, title:`Batch ${batchIndex}`,       │
│                 metadata:{kind:'batch-summary', batch_index, seq_from,       │
│                           seq_to} })   ◄── SINGLE ATOMIC FINAL STEP (D6)     │
│  D. loop A–C while hasMore (catch-up after multiple unsummarized batches)   │
│  E. if batches_summarized >= 3 (or session-end flag):                       │
│       tim show/roll-up → update Summary node body + {exchanges,date,summary}│
│       (releaseLock on exit)                                                 │
└────────────────────────────────────────────────────────────────────────────┘
```

Idempotency invariant: step C is the *only* state-advancing write. Re-running A→C after any crash sees the already-written `Batch` nodes (via DB count), recomputes `batchIndex`, and never duplicates.

### 4.1 `.tim-project` marker shape

```json
{
  "project": "P0063",
  "session": "01KT1ABCDEF...",
  "exchanges": 14,
  "batch_size": 5,
  "batches_summarized": 2,
  "summarizer": { "cli": "claude", "model": "haiku" }
}
```

`exchanges` and `batches_summarized` are **caches**; the hook overwrites them with DB-derived values before every spawn decision. `summarizer` is per-project config (CLI tool + model), default `{cli:"claude", model:"haiku"}`.

---

## 5. Helper module: `session-tree.ts` (write this first)

Create `packages/tim-store/src/session-tree.ts` with the constants above plus these pure helpers used by `session.ts` and the hooks. Each is a thin wrapper over existing `TimStore` methods.

```typescript
import type { Entry } from 'tim-core';
import type { TimStore } from './store.js';
import {
  KIND_SUMMARY_ROOT, KIND_EXCHANGES_ROOT, KIND_EXCHANGE, KIND_BATCH,
  SUMMARY_NODE_TITLE, EXCHANGES_NODE_TITLE,
} from './session-tree-constants.js'; // or co-locate constants in this file

export interface DerivedCounters {
  exchangeCount: number;     // # user nodes under Exchanges
  batchesSummarized: number; // # Batch nodes under Summary
}

/** Locate the single child of `parentId` with the given metadata.kind, or null. */
export async function findChildByKind(
  store: TimStore, parentId: string, kind: string,
): Promise<Entry | null> {
  const kids = await store.getChildByKind(parentId, kind);
  return kids[0] ?? null;
}

/** Re-derive counters from the DB tree. Authoritative — never trusts caches. */
export async function deriveCounters(
  store: TimStore, sessionId: string,
): Promise<DerivedCounters> {
  const exchangesNode = await findChildByKind(store, sessionId, KIND_EXCHANGES_ROOT);
  const summaryNode   = await findChildByKind(store, sessionId, KIND_SUMMARY_ROOT);

  let exchangeCount = 0;
  if (exchangesNode) {
    const users = await store.getChildren(exchangesNode.id);
    exchangeCount = users.filter(u => u.metadata.role === 'user').length;
  }

  let batchesSummarized = 0;
  if (summaryNode) {
    const batches = await store.getChildByKind(summaryNode.id, KIND_BATCH);
    batchesSummarized = batches.length;
  }

  return { exchangeCount, batchesSummarized };
}
```

> Note: keep constants and helpers in one file if you prefer; the import line above is illustrative. Do **not** introduce a second source of truth for the constants.

---

## 6. Implementation Tasks (TDD, bite-sized)

> Test runner: from the package directory, `npx vitest run <relative-test-path>`. Build a package with `npm run build` (tsc) inside that package. Commit after each green task.

### Task 1: Store helpers `getChildByKind` and `getChildrenBySeq`

**Files:**
- Modify: `packages/tim-store/src/store.ts` (add methods near `getChildren`, store.ts:160-183)
- Test: `packages/tim-store/src/__tests__/store.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `store.test.ts`:

```typescript
describe('getChildByKind / getChildrenBySeq', () => {
  it('returns only children matching a metadata.kind', async () => {
    const parent = await store.write('parent', {});
    await store.write('a', { parentId: parent.id, metadata: { kind: 'apple' } });
    await store.write('b', { parentId: parent.id, metadata: { kind: 'banana' } });
    await store.write('c', { parentId: parent.id, metadata: { kind: 'apple' } });

    const apples = await store.getChildByKind(parent.id, 'apple');
    expect(apples.map(e => e.title)).toEqual(['a', 'c']);
  });

  it('orders children by metadata.seq ascending', async () => {
    const parent = await store.write('p', {});
    await store.write('third',  { parentId: parent.id, metadata: { seq: 3 } });
    await store.write('first',  { parentId: parent.id, metadata: { seq: 1 } });
    await store.write('second', { parentId: parent.id, metadata: { seq: 2 } });

    const ordered = await store.getChildrenBySeq(parent.id);
    expect(ordered.map(e => e.title)).toEqual(['first', 'second', 'third']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/tim-store && npx vitest run src/__tests__/store.test.ts -t "getChildByKind"`
Expected: FAIL — `store.getChildByKind is not a function`.

- [ ] **Step 3: Implement the methods**

Add to `class TimStore` (after `getChildren`):

```typescript
async getChildByKind(parentId: string, kind: string): Promise<Entry[]> {
  const rows = this.db.prepare(`
    SELECT * FROM entries
    WHERE parent_id = ?
      AND json_extract(metadata, '$.kind') = ?
      AND irrelevant = 0
      AND tombstoned_at IS NULL
    ORDER BY COALESCE(CAST(json_extract(metadata, '$.seq') AS INTEGER), 999999),
             COALESCE(CAST(json_extract(metadata, '$.order') AS INTEGER), 999999),
             created_at ASC
  `).all(parentId, kind) as RowEntry[];
  return rows.map(rowToEntry);
}

async getChildrenBySeq(parentId: string): Promise<Entry[]> {
  const rows = this.db.prepare(`
    SELECT * FROM entries
    WHERE parent_id = ?
      AND irrelevant = 0
      AND tombstoned_at IS NULL
    ORDER BY COALESCE(CAST(json_extract(metadata, '$.seq') AS INTEGER), 999999),
             created_at ASC
  `).all(parentId) as RowEntry[];
  return rows.map(rowToEntry);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/tim-store && npx vitest run src/__tests__/store.test.ts -t "getChildByKind"`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/tim-store/src/store.ts packages/tim-store/src/__tests__/store.test.ts
git commit -m "feat(store): add getChildByKind and getChildrenBySeq helpers"
```

---

### Task 2: `session-tree.ts` constants + `deriveCounters`

**Files:**
- Create: `packages/tim-store/src/session-tree.ts`
- Modify: `packages/tim-store/src/index.ts` (export it)
- Test: `packages/tim-store/src/__tests__/session.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `session.test.ts`:

```typescript
import { deriveCounters } from '../session-tree.js';

describe('deriveCounters', () => {
  it('returns zeros for a session with no Exchanges/Summary nodes', async () => {
    const s = await store.write('bare', { id: 'bare-sess', metadata: { kind: 'session' } });
    const c = await deriveCounters(store, s.id);
    expect(c).toEqual({ exchangeCount: 0, batchesSummarized: 0 });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/tim-store && npx vitest run src/__tests__/session.test.ts -t "deriveCounters"`
Expected: FAIL — cannot find module `../session-tree.js`.

- [ ] **Step 3: Implement `session-tree.ts`**

Create the file with the constants block from §3 and the helper functions from §5 (`findChildByKind`, `deriveCounters`). Then add to `packages/tim-store/src/index.ts`:

```typescript
export {
  deriveCounters,
  findChildByKind,
  type DerivedCounters,
  SESSIONS_SECTION_TITLE, SUMMARY_NODE_TITLE, EXCHANGES_NODE_TITLE,
  KIND_SESSIONS_ROOT, KIND_SESSION, KIND_SUMMARY_ROOT,
  KIND_BATCH, KIND_EXCHANGES_ROOT, KIND_EXCHANGE,
  SESSION_SUMMARY_TAG, DEFAULT_BATCH_SIZE, SESSION_ROLLUP_THRESHOLD,
} from './session-tree.js';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/tim-store && npx vitest run src/__tests__/session.test.ts -t "deriveCounters"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/tim-store/src/session-tree.ts packages/tim-store/src/index.ts packages/tim-store/src/__tests__/session.test.ts
git commit -m "feat(store): session-tree constants and DB-derived counters"
```

---

### Task 3: `SessionManager.startProjectSession` (creates the subtree)

**Files:**
- Modify: `packages/tim-store/src/session.ts`
- Test: `packages/tim-store/src/__tests__/session.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
describe('startProjectSession', () => {
  it('creates Sessions section + session node + Summary + Exchanges', async () => {
    await store.createProject('P0099');
    const session = await sessions.startProjectSession({
      sessionId: 'sess-proj-1', projectId: 'P0099',
      agentName: 'claude', cwd: '/p', harness: 'claude-code',
    });

    expect(session.id).toBe('sess-proj-1');
    expect(session.metadata.kind).toBe('session');
    expect(session.metadata.project_ref).toBe('P0099');
    expect(session.metadata.batch_size).toBe(5);

    // Sessions section under the project
    const project = await store.read('P0099');
    const sectionKids = await store.getChildByKind(project!.id, 'sessions-root');
    expect(sectionKids).toHaveLength(1);
    expect(sectionKids[0].metadata.order).toBe(1000);

    // session node under Sessions section
    expect(session.parentId).toBe(sectionKids[0].id);

    // Summary + Exchanges under session
    const summary   = await store.getChildByKind(session.id, 'session-summary-root');
    const exchanges = await store.getChildByKind(session.id, 'exchanges-root');
    expect(summary).toHaveLength(1);
    expect(exchanges).toHaveLength(1);
    expect(summary[0].tags).toContain('#session-summary');
  });

  it('is idempotent and reuses the Sessions section across sessions', async () => {
    await store.createProject('P0098');
    await sessions.startProjectSession({ sessionId: 's1', projectId: 'P0098', agentName: 'a', cwd: '/', harness: 't' });
    await sessions.startProjectSession({ sessionId: 's1', projectId: 'P0098', agentName: 'a', cwd: '/', harness: 't' }); // repeat
    await sessions.startProjectSession({ sessionId: 's2', projectId: 'P0098', agentName: 'a', cwd: '/', harness: 't' });

    const project = await store.read('P0098');
    const sections = await store.getChildByKind(project!.id, 'sessions-root');
    expect(sections).toHaveLength(1); // only ONE Sessions section
    const sessionNodes = await store.getChildByKind(sections[0].id, 'session');
    expect(sessionNodes.map(s => s.id).sort()).toEqual(['s1', 's2']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/tim-store && npx vitest run src/__tests__/session.test.ts -t "startProjectSession"`
Expected: FAIL — `sessions.startProjectSession is not a function`.

- [ ] **Step 3: Implement `startProjectSession`**

Add to `SessionManager` (import constants + `findChildByKind` from `./session-tree.js`):

```typescript
export interface ProjectSessionParams extends SessionStartParams {
  projectId: string;
  batchSize?: number;
  summarizer?: { cli: string; model: string };
}

async startProjectSession(params: ProjectSessionParams): Promise<Entry> {
  const { sessionId, projectId, agentName, cwd, harness } = params;

  // Idempotent: if the session node already exists, return it.
  const existing = await this.store.read(sessionId);
  if (existing?.metadata.kind === KIND_SESSION) return existing;

  const project = await this.store.read(projectId);
  if (!project || project.metadata.kind !== 'project') {
    throw new Error(`Project not found: ${projectId}`);
  }

  // 1. Find-or-create the Sessions section under the project.
  let sessionsSection = await findChildByKind(this.store, project.id, KIND_SESSIONS_ROOT);
  if (!sessionsSection) {
    // Explicit `order` is preserved: store.write only auto-assigns when metadata.order === undefined
    // (store.ts:278). order 1000 sorts AFTER schema sections so budget truncation drops sessions, not content.
    sessionsSection = await this.store.write(SESSIONS_SECTION_TITLE, {
      parentId: project.id,
      metadata: { kind: KIND_SESSIONS_ROOT, render_depth: 0, order: SESSIONS_SECTION_ORDER },
      tags: ['#sessions'],
    });
  }

  // 2. Create the session node (id = harness sessionId, title = date-time).
  const date = new Date().toISOString();
  const title = date.slice(0, 16).replace('T', '-').replace(':', ''); // 2026-06-01-1123
  const session = await this.store.write(title, {
    id: sessionId,
    parentId: sessionsSection.id,
    metadata: {
      kind: KIND_SESSION,
      sessionId, project_ref: projectId,
      agent: agentName, harness, cwd, date,
      batch_size: params.batchSize ?? DEFAULT_BATCH_SIZE,
      summarizer: params.summarizer ?? { cli: 'claude', model: 'haiku' },
      exchange_count: 0, batches_summarized: 0,
    },
    tags: ['#session'],
  });

  // 3. Create empty Summary (tagged for the existing rollup) and Exchanges nodes.
  await this.store.write(SUMMARY_NODE_TITLE, {
    parentId: session.id,
    metadata: { kind: KIND_SUMMARY_ROOT, exchanges: 0, date, summary: '' },
    tags: [SESSION_SUMMARY_TAG],
  });
  await this.store.write(EXCHANGES_NODE_TITLE, {
    parentId: session.id,
    metadata: { kind: KIND_EXCHANGES_ROOT, render_depth: 0 },
    tags: ['#exchanges'],
  });

  return session;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/tim-store && npx vitest run src/__tests__/session.test.ts -t "startProjectSession"`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/tim-store/src/session.ts packages/tim-store/src/__tests__/session.test.ts
git commit -m "feat(session): startProjectSession builds Sessions/Summary/Exchanges subtree"
```

---

### Task 4: Nested `SessionManager.logExchange`

**Files:**
- Modify: `packages/tim-store/src/session.ts`
- Test: `packages/tim-store/src/__tests__/session.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
describe('logExchange (nested)', () => {
  beforeEach(async () => {
    await store.createProject('P0097');
    await sessions.startProjectSession({ sessionId: 'sx', projectId: 'P0097', agentName: 'a', cwd: '/', harness: 't' });
  });

  it('nests agent reply under its user message and seqs only user nodes', async () => {
    await sessions.logExchange('sx', [
      { role: 'user',  content: 'Q1' },
      { role: 'agent', content: 'A1' },
      { role: 'user',  content: 'Q2' },
      { role: 'agent', content: 'A2' },
    ]);

    const exNode = (await store.getChildByKind('sx', 'exchanges-root'))[0];
    const users = await store.getChildrenBySeq(exNode.id);
    expect(users.map(u => [u.title, u.metadata.seq, u.metadata.role]))
      .toEqual([['Q1', 1, 'user'], ['Q2', 2, 'user']]);

    const a1 = await store.getChildren(users[0].id);
    expect(a1).toHaveLength(1);
    expect(a1[0].title).toBe('A1');
    expect(a1[0].metadata.role).toBe('agent');
    expect(a1[0].metadata.seq).toBe(1); // inherits parent seq
  });

  it('continues seq across calls and updates the cached exchange_count', async () => {
    await sessions.logExchange('sx', [{ role: 'user', content: 'first' }]);
    await sessions.logExchange('sx', [{ role: 'user', content: 'second' }]);

    const exNode = (await store.getChildByKind('sx', 'exchanges-root'))[0];
    const users = await store.getChildrenBySeq(exNode.id);
    expect(users.map(u => u.metadata.seq)).toEqual([1, 2]);

    const session = await store.read('sx');
    expect(session!.metadata.exchange_count).toBe(2); // cache refreshed
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/tim-store && npx vitest run src/__tests__/session.test.ts -t "logExchange"`
Expected: FAIL — `sessions.logExchange is not a function`.

- [ ] **Step 3: Implement `logExchange`**

```typescript
async logExchange(sessionId: string, entries: Exchange[]): Promise<Entry[]> {
  const session = await this.store.read(sessionId);
  if (!session || session.metadata.kind !== KIND_SESSION) {
    throw new Error(`Project session not found: ${sessionId}`);
  }
  const exNode = await findChildByKind(this.store, sessionId, KIND_EXCHANGES_ROOT);
  if (!exNode) throw new Error(`Exchanges node missing for session: ${sessionId}`);

  // Current max user seq (DB-derived).
  const userNodes = (await this.store.getChildrenBySeq(exNode.id))
    .filter(u => u.metadata.role === 'user');
  let seq = userNodes.reduce(
    (m, u) => Math.max(m, typeof u.metadata.seq === 'number' ? u.metadata.seq : 0), 0);

  // Cursor to the user node that agent replies attach to (last existing or newly created).
  let currentUser: Entry | null = userNodes[userNodes.length - 1] ?? null;

  const written: Entry[] = [];
  for (const e of entries) {
    if (e.role === 'user') {
      seq += 1;
      currentUser = await this.store.write(e.content, {
        parentId: exNode.id,
        metadata: { kind: KIND_EXCHANGE, role: 'user', seq, sessionId },
        tags: ['#exchange'],
      });
      written.push(currentUser);
    } else {
      // agent reply → child of the current user node (fallback: directly under Exchanges)
      const parentId = currentUser ? currentUser.id : exNode.id;
      const agentSeq = currentUser ? currentUser.metadata.seq : seq;
      const a = await this.store.write(e.content, {
        parentId,
        metadata: { kind: KIND_EXCHANGE, role: 'agent', seq: agentSeq, sessionId },
        tags: ['#exchange'],
      });
      written.push(a);
    }
  }

  // Refresh the cached counter on the session node (DB stays authoritative).
  const { exchangeCount } = await deriveCounters(this.store, sessionId);
  await this.store.update(sessionId, {
    metadata: { ...session.metadata, exchange_count: exchangeCount },
  });

  return written;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/tim-store && npx vitest run src/__tests__/session.test.ts -t "logExchange"`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/tim-store/src/session.ts packages/tim-store/src/__tests__/session.test.ts
git commit -m "feat(session): nested logExchange (agent reply child of user, user-only seq)"
```

---

### Task 5: `SessionManager.showUnsummarized`

**Files:**
- Modify: `packages/tim-store/src/session.ts`
- Test: `packages/tim-store/src/__tests__/session.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
describe('showUnsummarized', () => {
  beforeEach(async () => {
    await store.createProject('P0096');
    await sessions.startProjectSession({
      sessionId: 'su', projectId: 'P0096', agentName: 'a', cwd: '/', harness: 't', batchSize: 2,
    });
    await sessions.logExchange('su', [
      { role: 'user', content: 'Q1' }, { role: 'agent', content: 'A1' },
      { role: 'user', content: 'Q2' }, { role: 'agent', content: 'A2' },
      { role: 'user', content: 'Q3' }, { role: 'agent', content: 'A3' },
    ]);
  });

  it('returns the first unsummarized batch with user+agent content', async () => {
    const batch = await sessions.showUnsummarized('su');
    expect(batch.batchIndex).toBe(1);
    expect(batch.batchSize).toBe(2);
    expect(batch.exchanges.map(e => [e.seq, e.userContent, e.agentContent]))
      .toEqual([[1, 'Q1', 'A1'], [2, 'Q2', 'A2']]);
    expect(batch.hasMore).toBe(true); // Q3 remains
    expect(batch.summaryNodeId).toBeTruthy();
  });

  it('skips already-summarized batches (derived from existing Batch nodes)', async () => {
    const summaryNode = (await store.getChildByKind('su', 'session-summary-root'))[0];
    await store.write('Batch 1', {
      parentId: summaryNode.id,
      metadata: { kind: 'batch-summary', batch_index: 1, seq_from: 1, seq_to: 2 },
    });

    const batch = await sessions.showUnsummarized('su');
    expect(batch.batchIndex).toBe(2);
    expect(batch.exchanges.map(e => e.seq)).toEqual([3]); // only Q3 left
    expect(batch.hasMore).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/tim-store && npx vitest run src/__tests__/session.test.ts -t "showUnsummarized"`
Expected: FAIL — `sessions.showUnsummarized is not a function`.

- [ ] **Step 3: Implement `showUnsummarized`**

```typescript
export interface UnsummarizedExchange {
  seq: number;
  userId: string; userContent: string;
  agentId: string | null; agentContent: string | null;
}

export interface UnsummarizedBatch {
  sessionId: string;
  summaryNodeId: string;
  exchangesNodeId: string;
  batchIndex: number;      // 1-based index of THIS batch
  batchSize: number;
  exchanges: UnsummarizedExchange[];
  hasMore: boolean;        // more unsummarized exchanges remain after this batch
}

async showUnsummarized(sessionId: string): Promise<UnsummarizedBatch> {
  const session = await this.store.read(sessionId);
  if (!session || session.metadata.kind !== KIND_SESSION) {
    throw new Error(`Project session not found: ${sessionId}`);
  }
  const exNode      = await findChildByKind(this.store, sessionId, KIND_EXCHANGES_ROOT);
  const summaryNode = await findChildByKind(this.store, sessionId, KIND_SUMMARY_ROOT);
  if (!exNode || !summaryNode) throw new Error(`Session subtree incomplete: ${sessionId}`);

  const batchSize = typeof session.metadata.batch_size === 'number'
    ? session.metadata.batch_size : DEFAULT_BATCH_SIZE;

  const { batchesSummarized } = await deriveCounters(this.store, sessionId);
  const skip = batchesSummarized * batchSize;

  const users = (await this.store.getChildrenBySeq(exNode.id))
    .filter(u => u.metadata.role === 'user');
  const slice = users.slice(skip, skip + batchSize);

  const exchanges: UnsummarizedExchange[] = [];
  for (const u of slice) {
    const replies = await this.store.getChildren(u.id);
    const agent = replies.find(r => r.metadata.role === 'agent') ?? null;
    exchanges.push({
      seq: Number(u.metadata.seq),
      userId: u.id, userContent: u.content || u.title,
      agentId: agent?.id ?? null,
      agentContent: agent ? (agent.content || agent.title) : null,
    });
  }

  return {
    sessionId, summaryNodeId: summaryNode.id, exchangesNodeId: exNode.id,
    batchIndex: batchesSummarized + 1, batchSize, exchanges,
    hasMore: users.length > skip + batchSize,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/tim-store && npx vitest run src/__tests__/session.test.ts -t "showUnsummarized"`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/tim-store/src/session.ts packages/tim-store/src/__tests__/session.test.ts
git commit -m "feat(session): showUnsummarized returns next DB-derived batch"
```

---

### Task 6: `writeBatchSummary` (idempotent) + `rollUpSession`

**Files:**
- Modify: `packages/tim-store/src/session.ts`
- Test: `packages/tim-store/src/__tests__/session.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
describe('writeBatchSummary + rollUpSession', () => {
  beforeEach(async () => {
    await store.createProject('P0095');
    await sessions.startProjectSession({
      sessionId: 'sb', projectId: 'P0095', agentName: 'a', cwd: '/', harness: 't', batchSize: 2,
    });
    await sessions.logExchange('sb', [
      { role: 'user', content: 'Q1' }, { role: 'agent', content: 'A1' },
      { role: 'user', content: 'Q2' }, { role: 'agent', content: 'A2' },
    ]);
  });

  it('writes a Batch node under Summary and bumps derived batches_summarized', async () => {
    const batch = await sessions.showUnsummarized('sb');
    const node = await sessions.writeBatchSummary('sb', batch.batchIndex, 'themes: greetings', {
      seqFrom: 1, seqTo: 2,
    });
    expect(node.metadata.kind).toBe('batch-summary');
    expect(node.metadata.batch_index).toBe(1);

    const { batchesSummarized } = await deriveCounters(store, 'sb');
    expect(batchesSummarized).toBe(1);
  });

  it('is idempotent: re-writing the same batch_index does not duplicate', async () => {
    await sessions.writeBatchSummary('sb', 1, 'first', { seqFrom: 1, seqTo: 2 });
    await sessions.writeBatchSummary('sb', 1, 'again', { seqFrom: 1, seqTo: 2 });
    const summaryNode = (await store.getChildByKind('sb', 'session-summary-root'))[0];
    const batches = await store.getChildByKind(summaryNode.id, 'batch-summary');
    expect(batches).toHaveLength(1); // no duplicate
  });

  it('rollUpSession folds all batches into the Summary node body + metadata (multi-line safe)', async () => {
    await sessions.writeBatchSummary('sb', 1, 'batch one summary', { seqFrom: 1, seqTo: 2 });
    // Multi-line fold — the FIRST line must survive (regression guard for store.update title-split).
    const summary = await sessions.rollUpSession('sb', async (batches) =>
      `Themes:\n${batches.map(b => b.content).join('\n')}`);

    expect(summary.content.startsWith('Themes:')).toBe(true); // first line not dropped
    expect(summary.content).toContain('batch one summary');
    expect(summary.metadata.summary).toContain('Themes:');
    expect(summary.metadata.exchanges).toBe(2);
    expect(summary.tags).toContain('#session-summary');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/tim-store && npx vitest run src/__tests__/session.test.ts -t "writeBatchSummary"`
Expected: FAIL — `sessions.writeBatchSummary is not a function`.

- [ ] **Step 3: Implement both methods**

```typescript
async writeBatchSummary(
  sessionId: string, batchIndex: number, summaryText: string,
  range: { seqFrom: number; seqTo: number },
): Promise<Entry> {
  const summaryNode = await findChildByKind(this.store, sessionId, KIND_SUMMARY_ROOT);
  if (!summaryNode) throw new Error(`Summary node missing for session: ${sessionId}`);

  // Idempotency guard: if a Batch with this index already exists, return it (no dup write).
  const existing = (await this.store.getChildByKind(summaryNode.id, KIND_BATCH))
    .find(b => b.metadata.batch_index === batchIndex);
  if (existing) return existing;

  // SINGLE ATOMIC FINAL STEP (D6): one write advances state.
  const node = await this.store.write(summaryText, {
    parentId: summaryNode.id,
    title: `Batch ${batchIndex}`,
    metadata: {
      kind: KIND_BATCH, batch_index: batchIndex,
      seq_from: range.seqFrom, seq_to: range.seqTo, sessionId,
    },
    tags: ['#batch-summary'],
  });

  // Refresh cached counter (DB authoritative).
  const session = await this.store.read(sessionId);
  const { batchesSummarized } = await deriveCounters(this.store, sessionId);
  if (session) {
    await this.store.update(sessionId, {
      metadata: { ...session.metadata, batches_summarized: batchesSummarized },
    });
  }
  return node;
}

async rollUpSession(
  sessionId: string, fold: (batches: Entry[]) => Promise<string>,
): Promise<Entry> {
  const summaryNode = await findChildByKind(this.store, sessionId, KIND_SUMMARY_ROOT);
  if (!summaryNode) throw new Error(`Summary node missing for session: ${sessionId}`);

  const batches = await this.store.getChildByKind(summaryNode.id, KIND_BATCH);
  const text = await fold(batches);
  const { exchangeCount } = await deriveCounters(this.store, sessionId);
  const date = String(summaryNode.metadata.date ?? new Date().toISOString());

  // Pass `title` explicitly. store.update (store.ts:346-357) otherwise treats the first line of
  // `content` as a title-update on a node whose title is non-empty ("Summary") and DROPS it.
  await this.store.update(summaryNode.id, {
    title: SUMMARY_NODE_TITLE,
    content: text,
    metadata: { ...summaryNode.metadata, summary: text, exchanges: exchangeCount, date },
  });
  const updated = await this.store.read(summaryNode.id);
  return updated!;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/tim-store && npx vitest run src/__tests__/session.test.ts -t "writeBatchSummary"`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/tim-store/src/session.ts packages/tim-store/src/__tests__/session.test.ts
git commit -m "feat(session): idempotent writeBatchSummary + rollUpSession"
```

---

### Task 7: Make legacy `getSessionExchanges`/`checkpoint` tree-aware (backward compatible)

**Files:**
- Modify: `packages/tim-store/src/session.ts`
- Test: `packages/tim-store/src/__tests__/session.test.ts`

- [ ] **Step 1: Write the failing test** (existing legacy tests must still pass; add a project-bound checkpoint test)

```typescript
describe('getSessionExchanges tree-awareness', () => {
  it('reads exchanges from the Exchanges subtree for project sessions', async () => {
    await store.createProject('P0094');
    await sessions.startProjectSession({ sessionId: 'sc', projectId: 'P0094', agentName: 'a', cwd: '/', harness: 't' });
    await sessions.logExchange('sc', [
      { role: 'user', content: 'U1' }, { role: 'agent', content: 'Ag1' },
    ]);

    const ex = await sessions.getSessionExchanges('sc');
    // user node + nested agent node both returned, user first
    expect(ex.map(e => e.metadata.role)).toEqual(['user', 'agent']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/tim-store && npx vitest run src/__tests__/session.test.ts -t "tree-awareness"`
Expected: FAIL — `getSessionExchanges` reads direct children of `sc` (the session node), which are `Summary`/`Exchanges`, not exchanges.

- [ ] **Step 3: Make `getSessionExchanges` detect the project-bound shape**

Replace the body of `getSessionExchanges`:

```typescript
async getSessionExchanges(sessionId: string): Promise<Entry[]> {
  // Project-bound sessions store exchanges under an Exchanges subtree.
  const exNode = await findChildByKind(this.store, sessionId, KIND_EXCHANGES_ROOT);
  if (exNode) {
    const users = (await this.store.getChildrenBySeq(exNode.id))
      .filter(u => u.metadata.role === 'user');
    const out: Entry[] = [];
    for (const u of users) {
      out.push(u);
      const replies = await this.store.getChildren(u.id);
      for (const r of replies) if (r.metadata.role === 'agent') out.push(r);
    }
    return out;
  }
  // Legacy flat shape: exchanges are direct children of the session id.
  return this.store.getChildren(sessionId, { metadataKind: KIND_EXCHANGE });
}
```

`checkpoint` already calls `getSessionExchanges`, so it now works for both shapes with no change to `checkpoint` itself. Verify the existing legacy `checkpoint` tests still pass.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/tim-store && npx vitest run src/__tests__/session.test.ts`
Expected: PASS — all new tests AND all pre-existing legacy tests (`sessionStart`, flat `sessionLog`, `checkpoint`).

- [ ] **Step 5: Commit**

```bash
git add packages/tim-store/src/session.ts packages/tim-store/src/__tests__/session.test.ts
git commit -m "feat(session): tree-aware getSessionExchanges (legacy fallback preserved)"
```

---

### Task 8: Formatter — exclude `sessions-root` section from double-render (D5)

**Files:**
- Modify: `packages/tim-store/src/project-output.ts:248-250`
- Test: `packages/tim-store/src/__tests__/` (project-output test file; create if absent)

- [ ] **Step 1: Write the failing test**

```typescript
import { formatProjectOutput } from '../project-output.js';
// build a LoadProjectResult fixture with a sessions-root child and a #session-summary Summary child
it('does not list the Sessions section twice', () => {
  const project = { id: 'P1', metadata: { label: 'P1', kind: 'project' }, title: 'P1 — x',
    content: '', tags: [], createdAt: '2026-06-01T00:00:00Z' } as any;
  const sessionsRoot = { id: 's-root', parentId: 'P1', title: 'Sessions',
    metadata: { kind: 'sessions-root', order: 1000 }, tags: ['#sessions'], content: '',
    createdAt: '2026-06-01T00:00:00Z' } as any;
  const summary = { id: 'sum', parentId: 'sess', title: 'Summary',
    metadata: { kind: 'session-summary-root', exchanges: 4, date: '2026-06-01', summary: 'did things' },
    tags: ['#session-summary'], content: 'did things', createdAt: '2026-06-01T00:00:00Z' } as any;

  const out = formatProjectOutput({ project, children: [sessionsRoot, summary], truncated: false }, 200);
  // The "Sessions" SECTION header line must NOT appear in the Sections block,
  // but the rollup "── Sessions (1) ──" MUST appear.
  expect(out).toMatch(/── Sessions \(1\) ──/);
  expect(out).not.toMatch(/^ {2}Sessions {2,}/m); // no section row for sessions-root
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/tim-store && npx vitest run src/__tests__/project-output.test.ts`
Expected: FAIL — `sessions-root` currently renders as a normal section row.

- [ ] **Step 3: Exclude `sessions-root` from the Sections list**

Edit `project-output.ts:248-250`:

```typescript
const sections = children
  .filter(c =>
    c.parentId === project.id &&
    !c.tags.includes('#session-summary') &&
    c.metadata.kind !== 'sessions-root')   // ← new: hide the Sessions container; rollup shows sessions
  .sort(compareEntryOrder);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/tim-store && npx vitest run src/__tests__/project-output.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/tim-store/src/project-output.ts packages/tim-store/src/__tests__/project-output.test.ts
git commit -m "feat(output): hide sessions-root container; rely on #session-summary rollup"
```

---

### Task 9: MCP — `projectId` on start, nested log, register `tim_show_unsummarized`

**Files:**
- Modify: `packages/tim-mcp/src/server.ts`
- (Manual/integration verification — MCP has no unit harness here; verify by build + a scripted stdio call or the CLI.)

- [ ] **Step 1: Extend the Zod schemas** (`server.ts:120-137`)

```typescript
const TimSessionStartSchema = z.object({
  sessionId: z.string(),
  projectId: z.string().optional().describe('Project label, e.g. P0062 — enables the nested session tree'),
  agentName: z.string().optional().default('default'),
  cwd: z.string().optional(),
  harness: z.string().optional().default('mcp'),
  batchSize: z.number().min(1).max(50).optional(),
});

const TimShowUnsummarizedSchema = z.object({
  sessionId: z.string(),
});
```

- [ ] **Step 2: Add the tool to the `ListTools` array** (after `tim_session_log`, near `server.ts:645`)

```typescript
{
  name: 'tim_show_unsummarized',
  description: 'Return the next unsummarized batch of exchanges for a session (UUIDs + user/agent bodies). Summarizer reads this, writes a Batch node under Summary.',
  inputSchema: {
    type: 'object',
    properties: { sessionId: { type: 'string' } },
    required: ['sessionId'],
  },
},
```

Also add `projectId` and `batchSize` to the `tim_session_start` inputSchema properties block (`server.ts:611-623`).

- [ ] **Step 3: Update the handlers** (`server.ts:987-1010`) and add the new case

```typescript
case 'tim_session_start': {
  const { sessionId, projectId, agentName, cwd, harness, batchSize } =
    TimSessionStartSchema.parse(args);
  const entry = projectId
    ? await getSessions().startProjectSession({
        sessionId, projectId, agentName, cwd: cwd ?? process.cwd(), harness, batchSize,
      })
    : await getSessions().sessionStart({
        sessionId, agentName, cwd: cwd ?? process.cwd(), harness,
      });
  const cortex = await buildCortexReadyBlock(s, entry);
  const text = cortex ? `${cortex}\n\n${JSON.stringify(entry, null, 2)}`
                      : JSON.stringify(entry, null, 2);
  return { content: [{ type: 'text', text }] };
}

case 'tim_session_log': {
  const { sessionId, entries } = TimSessionLogSchema.parse(args);
  // Route to nested logger when the session is project-bound (has an Exchanges node).
  const sessionEntry = await s.read(sessionId);
  const isProjectBound =
    !!(sessionEntry && (await s.getChildByKind(sessionId, 'exchanges-root')).length > 0);
  const written = isProjectBound
    ? await getSessions().logExchange(sessionId, entries)
    : await getSessions().sessionLog(sessionId, entries);
  return { content: [{ type: 'text', text: JSON.stringify(written, null, 2) }] };
}

case 'tim_show_unsummarized': {
  const { sessionId } = TimShowUnsummarizedSchema.parse(args);
  const batch = await getSessions().showUnsummarized(sessionId);
  return { content: [{ type: 'text', text: JSON.stringify(batch, null, 2) }] };
}
```

- [ ] **Step 4: Register `tim_show_unsummarized` as a READ tool** (`server.ts:400-403`)

```typescript
const READ_TOOLS = new Set([
  'tim_read', 'tim_search', 'tim_trace', 'tim_health', 'tim_stats',
  'tim_export', 'tim_doctor', 'tim_sync', 'tim_load_project',
  'tim_show_unsummarized',   // ← new
]);
```

- [ ] **Step 5: Bump `buildCortexReadyBlock` load depth so it can see nested Summary nodes** (`server.ts:344`)

```typescript
// was: const loadResult = await store.loadProject(label, { depth: 1, budget: 100 });
const loadResult = await store.loadProject(label, { depth: 3, budget: 150 });
```

At `depth:1`, `loadChildren` returns only the `Sessions` section node and never descends to the per-session `Summary` nodes, so `sessionSummaries` would always be empty for new-model projects (the "[CORTEX READY] · N sessions this week / Last: <date>" line would read 0/stale). `depth:3` reaches Summary nodes (traversal level 3); the modest budget keeps the cost bounded. Verify the `[CORTEX READY]` block still emits and the session count is non-zero after a project-bound session.

- [ ] **Step 6: Build + smoke test, then commit**

```bash
cd packages/tim-store && npm run build && cd ../tim-mcp && npm run build
# Smoke: start the server, issue session_start(projectId)/session_log/show_unsummarized via the CLI or an stdio script,
# and confirm the [CORTEX READY] block reports the new session.
git add packages/tim-mcp/src/server.ts
git commit -m "feat(mcp): projectId session_start, nested session_log, tim_show_unsummarized, cortex depth"
```

---

### Task 10: `.tim-project` marker module (`tim-hooks/src/marker.ts`)

**Files:**
- Create: `packages/tim-hooks/src/marker.ts`
- Create: `packages/tim-hooks/src/__tests__/marker.test.ts`
- Modify: `packages/tim-hooks/src/index.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readMarker, writeMarker, detectProject, reconcileMarker, acquireLock, releaseLock, MARKER_FILENAME } from '../marker.js';
import { TimStore, SessionManager } from 'tim-store';

describe('marker', () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-marker-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it('round-trips a marker file', () => {
    writeMarker(dir, { project: 'P1', session: 's1', exchanges: 3, batch_size: 5, batches_summarized: 0 });
    expect(readMarker(dir)).toMatchObject({ project: 'P1', session: 's1', exchanges: 3 });
  });

  it('detectProject prefers the .tim-project marker', () => {
    writeMarker(dir, { project: 'P9', session: 's', exchanges: 0, batch_size: 5, batches_summarized: 0 });
    expect(detectProject(dir)?.project).toBe('P9');
  });

  it('detectProject returns null when no marker exists', () => {
    expect(detectProject(dir)).toBeNull();
  });

  it('reconcileMarker overwrites cached counters with DB-derived values', async () => {
    const store = new TimStore(':memory:');
    const sessions = new SessionManager(store);
    await store.createProject('P2');
    await sessions.startProjectSession({ sessionId: 'sm', projectId: 'P2', agentName: 'a', cwd: dir, harness: 't', batchSize: 2 });
    await sessions.logExchange('sm', [{ role: 'user', content: 'q' }, { role: 'agent', content: 'a' }]);
    writeMarker(dir, { project: 'P2', session: 'sm', exchanges: 99, batch_size: 2, batches_summarized: 7 }); // stale

    const reconciled = await reconcileMarker(store, dir);
    expect(reconciled.exchanges).toBe(1);          // DB-derived user count
    expect(reconciled.batches_summarized).toBe(0); // DB-derived
    store.close();
  });

  it('acquireLock single-flights: second acquire fails while the lock is fresh', () => {
    expect(acquireLock(dir)).toBe(true);
    expect(acquireLock(dir)).toBe(false); // held
    releaseLock(dir);
    expect(acquireLock(dir)).toBe(true);  // released → reacquirable
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/tim-hooks && npx vitest run src/__tests__/marker.test.ts`
Expected: FAIL — cannot find module `../marker.js`.

- [ ] **Step 3: Implement `marker.ts`**

```typescript
import * as fs from 'fs';
import * as path from 'path';
import type { TimStore } from 'tim-store';
import { deriveCounters } from 'tim-store';

export const MARKER_FILENAME = '.tim-project';
export const MARKER_LOCK = '.tim-project.lock';

export interface SummarizerConfig { cli: string; model: string; }
export interface ProjectMarker {
  project: string;
  session: string;
  exchanges: number;          // CACHE — reconciled from DB
  batch_size: number;
  batches_summarized: number; // CACHE — reconciled from DB
  summarizer?: SummarizerConfig;
}

export function markerPath(cwd: string): string {
  return path.join(cwd, MARKER_FILENAME);
}

export function readMarker(cwd: string): ProjectMarker | null {
  const p = markerPath(cwd);
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) as ProjectMarker; }
  catch { return null; }
}

export function writeMarker(cwd: string, marker: ProjectMarker): void {
  fs.writeFileSync(markerPath(cwd), JSON.stringify(marker, null, 2));
}

/**
 * Project detection. The vision lists three steps; v1 implements ONLY step 1.
 * Steps (2) session-binding cache and (3) interactive user prompt are descoped —
 * if there is no .tim-project marker, the Stop hook simply skips (see onSessionStop → 'no-marker').
 */
export function detectProject(cwd: string): ProjectMarker | null {
  return readMarker(cwd);
}

/** Re-derive counters from the DB and persist them into the marker. DB is authoritative. */
export async function reconcileMarker(store: TimStore, cwd: string): Promise<ProjectMarker> {
  const marker = readMarker(cwd);
  if (!marker) throw new Error(`No ${MARKER_FILENAME} in ${cwd}`);
  const { exchangeCount, batchesSummarized } = await deriveCounters(store, marker.session);
  const reconciled: ProjectMarker = {
    ...marker, exchanges: exchangeCount, batches_summarized: batchesSummarized,
  };
  writeMarker(cwd, reconciled);
  return reconciled;
}

export const LOCK_TTL_MS = 10 * 60_000; // reclaim locks left by a crashed/hard-killed summarizer

/**
 * Single-flight lock (D7). Returns true if acquired.
 * Writes {pid, ts}; if the lock already exists, reclaims it ONLY when older than LOCK_TTL_MS.
 * The lock is released by the spawned summarizer command's trailing `rm -f` (see session-hooks.ts);
 * the TTL is the backstop for SIGKILL that skips that cleanup.
 */
export function acquireLock(cwd: string): boolean {
  const lock = path.join(cwd, MARKER_LOCK);
  try {
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, ts: Date.now() }), { flag: 'wx' });
    return true;
  } catch {
    try {
      const raw = JSON.parse(fs.readFileSync(lock, 'utf8')) as { ts: number };
      if (Date.now() - raw.ts > LOCK_TTL_MS) {
        fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, ts: Date.now() })); // reclaim stale
        return true;
      }
    } catch { /* unreadable lock → treat as held */ }
    return false; // a fresh lock is held → another summarizer is running
  }
}

export function releaseLock(cwd: string): void {
  try { fs.rmSync(path.join(cwd, MARKER_LOCK), { force: true }); } catch { /* ignore */ }
}
```

Add exports to `packages/tim-hooks/src/index.ts`:

```typescript
export {
  readMarker, writeMarker, detectProject, reconcileMarker,
  acquireLock, releaseLock, markerPath,
  MARKER_FILENAME, MARKER_LOCK, LOCK_TTL_MS,
  type ProjectMarker, type SummarizerConfig,
} from './marker.js';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/tim-hooks && npx vitest run src/__tests__/marker.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/tim-hooks/src/marker.ts packages/tim-hooks/src/index.ts packages/tim-hooks/src/__tests__/marker.test.ts
git commit -m "feat(hooks): .tim-project marker read/write/reconcile + single-flight lock"
```

---

### Task 11: Stop hook — decide + spawn summarizer detached (`session-hooks.ts`)

**Files:**
- Create: `packages/tim-hooks/src/session-hooks.ts`
- Create: `packages/tim-hooks/src/__tests__/session-hooks.test.ts`
- Modify: `packages/tim-hooks/src/index.ts`

The spawner is **injected** so tests stay deterministic (no real child process).

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { onSessionStop } from '../session-hooks.js';
import { writeMarker } from '../marker.js';
import { TimStore, SessionManager } from 'tim-store';

describe('onSessionStop', () => {
  let dir: string; let store: TimStore; let sessions: SessionManager;
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-stop-'));
    store = new TimStore(':memory:'); sessions = new SessionManager(store);
    await store.createProject('P3');
    await sessions.startProjectSession({ sessionId: 'st', projectId: 'P3', agentName: 'a', cwd: dir, harness: 't', batchSize: 2 });
  });
  afterEach(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });

  it('spawns the summarizer when pending >= batch_size', async () => {
    await sessions.logExchange('st', [
      { role: 'user', content: 'q1' }, { role: 'agent', content: 'a1' },
      { role: 'user', content: 'q2' }, { role: 'agent', content: 'a2' },
    ]);
    writeMarker(dir, { project: 'P3', session: 'st', exchanges: 0, batch_size: 2, batches_summarized: 0,
      summarizer: { cli: 'claude', model: 'haiku' } });

    const spawn = vi.fn();
    const res = await onSessionStop(store, dir, { spawn });
    expect(res.spawned).toBe(true);
    expect(spawn).toHaveBeenCalledOnce();
    const [cmd, ctx] = spawn.mock.calls[0];
    expect(cmd).toContain('claude');
    expect(cmd).toContain('haiku');
    expect(ctx.sessionId).toBe('st');
  });

  it('does NOT spawn when pending < batch_size', async () => {
    await sessions.logExchange('st', [{ role: 'user', content: 'only one' }]);
    writeMarker(dir, { project: 'P3', session: 'st', exchanges: 0, batch_size: 2, batches_summarized: 0 });
    const spawn = vi.fn();
    const res = await onSessionStop(store, dir, { spawn });
    expect(res.spawned).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('skips silently when no marker is present', async () => {
    const spawn = vi.fn();
    const res = await onSessionStop(store, dir, { spawn });
    expect(res.spawned).toBe(false);
    expect(res.reason).toBe('no-marker');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/tim-hooks && npx vitest run src/__tests__/session-hooks.test.ts`
Expected: FAIL — cannot find module `../session-hooks.js`.

- [ ] **Step 3: Implement `session-hooks.ts`**

```typescript
import { spawn as nodeSpawn } from 'child_process';
import * as path from 'path';
import type { TimStore } from 'tim-store';
import {
  detectProject, reconcileMarker, acquireLock,
  MARKER_LOCK, type SummarizerConfig,
} from './marker.js';

export interface SpawnContext { sessionId: string; cwd: string; }
export type Spawner = (command: string, ctx: SpawnContext) => void;

export interface SessionStopResult {
  spawned: boolean;
  reason: 'spawned' | 'no-marker' | 'below-threshold' | 'locked';
  pending?: number;
}

/** Default spawner: detached child process that does not block session end. */
export const detachedSpawner: Spawner = (command, ctx) => {
  const child = nodeSpawn(command, {
    shell: true, cwd: ctx.cwd, detached: true, stdio: 'ignore',
    env: { ...process.env, TIM_SESSION_ID: ctx.sessionId },
  });
  child.unref();
};

function buildSummarizerCommand(
  cfg: SummarizerConfig | undefined, sessionId: string, lockPath: string,
): string {
  const cli = cfg?.cli ?? 'claude';
  const model = cfg?.model ?? 'haiku';
  // The summarizer agent loops show_unsummarized → write Batch (see §4). Prompt the agent to do so.
  const prompt =
    `Summarize TIM session ${sessionId}: repeatedly call tim_show_unsummarized({sessionId:"${sessionId}"}), ` +
    `summarize each returned batch thematically, and tim_write the summary as a Batch node under summaryNodeId ` +
    `with metadata.kind="batch-summary". Stop when hasMore is false.`;
  // The trailing `rm -f` releases the single-flight lock when the agent exits (success OR failure).
  // acquireLock's stale-TTL is the backstop for a SIGKILL that skips this cleanup.
  return `${cli} -p --model ${model} ${JSON.stringify(prompt)} ; rm -f ${JSON.stringify(lockPath)}`;
}

export async function onSessionStop(
  store: TimStore, cwd: string, opts: { spawn?: Spawner } = {},
): Promise<SessionStopResult> {
  const spawn = opts.spawn ?? detachedSpawner;

  const marker = detectProject(cwd);
  if (!marker) return { spawned: false, reason: 'no-marker' };

  const reconciled = await reconcileMarker(store, cwd); // DB-authoritative
  const pending = reconciled.exchanges - reconciled.batches_summarized * reconciled.batch_size;
  if (pending < reconciled.batch_size) {
    return { spawned: false, reason: 'below-threshold', pending };
  }

  if (!acquireLock(cwd)) return { spawned: false, reason: 'locked', pending };
  // Do NOT release here: the lock's lifetime spans the asynchronous summarizer run.
  // The spawned command's trailing `rm -f` releases it on exit; acquireLock's TTL reclaims it on hard-kill.
  const lockPath = path.join(cwd, MARKER_LOCK);
  spawn(buildSummarizerCommand(reconciled.summarizer, reconciled.session, lockPath),
        { sessionId: reconciled.session, cwd });
  return { spawned: true, reason: 'spawned', pending };
}
```

> **Lock lifetime (D7), made concrete:** `acquireLock` is held across the *entire* detached summarizer run — `onSessionStop` never releases it itself (releasing right after a fire-and-forget spawn would defeat the lock, since the child has barely started). Release happens two ways: (1) the spawned command ends with `; rm -f <lock>`, removing it when the agent exits normally or with an error; (2) if the agent is `SIGKILL`ed before that runs, the next `acquireLock` reclaims the lock once it is older than `LOCK_TTL_MS`. The injected test spawner is synchronous and does not run the `rm -f`, which is why the "spawns" test below uses a fresh tmpdir per case.

Add to `packages/tim-hooks/src/index.ts`:

```typescript
export {
  onSessionStop, detachedSpawner,
  type SpawnContext, type Spawner, type SessionStopResult,
} from './session-hooks.js';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/tim-hooks && npx vitest run src/__tests__/session-hooks.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/tim-hooks/src/session-hooks.ts packages/tim-hooks/src/index.ts packages/tim-hooks/src/__tests__/session-hooks.test.ts
git commit -m "feat(hooks): Stop hook decides + spawns detached summarizer (single-flight)"
```

---

### Task 12 (OPTIONAL hardening): `loadProject` honors `render_depth:0`

Only do this if you need a *hard* guarantee that no `tim_load_project(depth:5)` ever pulls raw exchanges (Design Decision D2 default is to NOT do this). Blast radius: this also changes loading for every other `render_depth:0` node (e.g. `Previous Steps`). Gate it behind a test that asserts existing sections still load.

- [ ] Add to `loadChildren` (`store.ts:128-153`), before recursing into a child:

```typescript
const child = rowToEntry(row);
children.push(child);
const childRenderDepth = child.metadata.render_depth;
if (childRenderDepth === 0 || childRenderDepth === '0') continue; // do not descend
loadChildren(child.id, currentDepth + 1, false);
```

- [ ] Add a test proving `Exchanges` children are not loaded even at `depth:5`, AND that a normal `render_depth:0` section's own row still appears.
- [ ] Commit: `feat(store): loadProject stops descending into render_depth:0 nodes`.

---

## 7. Migration Considerations (existing session entries)

**Decision (D8): no data migration. Legacy sessions remain readable in place.**

- The current `sessionStart` writes a root-level `kind:'session'` node (no parent); `checkpoint` writes a root-level `kind:'checkpoint'` node linked via a `summarizes` edge. These were never under a project, so the new nested model does not collide with them.
- The `tim_session_start`/`tim_session_log` tools stay **backward compatible**: omit `projectId` → old flat behavior (legacy callers unaffected). Provide `projectId` → new nested tree.
- `getSessionExchanges`/`checkpoint` auto-detect shape (Task 7), so a legacy session can still be checkpointed.

**Optional follow-up migration (out of scope, document only):** a one-off script could, per project, create a `Sessions` section and `tim_move_entry` legacy `kind:'session'` nodes under it, then wrap their children in an `Exchanges` node. Not required for the feature to ship. If built, it must:
1. Be idempotent (skip sessions already under a `sessions-root`).
2. Preserve `seq`/`role` metadata.
3. Run inside a single transaction per session and verify with `deriveCounters` before/after.

**Schema note:** `docs/project-schema.json` does not currently list a `Sessions` section. The `Sessions` container is created dynamically by `startProjectSession` (with `render_depth:0`), so the schema file does **not** need editing for functionality. Optionally add a documentation-only `Sessions` entry to the schema's `sections` array with `"render_depth": 0` so the formatter's `findSchemaSection` lookup has a default — but the per-node `metadata.render_depth:0` already overrides, so this is cosmetic.

---

## 8. Edge Cases

| Edge case | Why it's safe | Mechanism |
|-----------|---------------|-----------|
| **Session crash mid-batch** (summarizer dies before writing the Batch node) | `batches_summarized` is derived by counting `Batch` nodes. A crash before the single atomic write leaves the count unchanged; the next Stop hook re-derives `pending` and re-spawns. No partial state. | D6 single atomic write; `deriveCounters` in `reconcileMarker`/`showUnsummarized`. |
| **Counter desync** (marker edited/deleted/stale, or `session.metadata` cache wrong) | Every decision path re-derives from the DB tree and overwrites the cache. Marker is rebuildable; deleting it only loses the spawn hint until the next reconcile. | `reconcileMarker`, `deriveCounters`; marker is never authoritative (D1). |
| **Summarizer writes a batch twice** (re-run, double Stop event) | `writeBatchSummary` checks for an existing `Batch` with the same `batch_index` and returns it without writing. | Idempotency guard in Task 6. |
| **Two Stop events race** | Second `acquireLock` fails with `EEXIST` → `onSessionStop` returns `{spawned:false, reason:'locked'}`. | D7 lockfile single-flight (Task 10/11). |
| **Stale lock after crash** | `acquireLock` records `{pid, ts}`; a held lock older than `LOCK_TTL_MS` (10 min) is reclaimed. Normal exit is released by the spawned command's trailing `rm -f`. No permanent lock. | `acquireLock` TTL (Task 10) + `rm -f` (Task 11). |
| **Agent reply with no preceding user** (first entry is `agent`, or a log batch starts with `agent`) | `logExchange` keeps a `currentUser` cursor seeded from the last existing user node; if none exists, the agent node is written directly under `Exchanges` (orphan, role `agent`, no parent user). It is excluded from `exchange_count` (which counts `role:'user'`). | Task 4 fallback branch. |
| **`tim_load_project(depth:5)` pulls raw exchanges** | Accepted under D2. Default `depth:3` keeps them out. Hard guarantee only via optional Task 12. | Constraint A; documented. |
| **Many sessions exhaust `load_project` budget** | `Sessions` section gets `order:1000` so it sorts after real sections; DFS budget truncation drops session detail, not project content. The compact `#session-summary` rollup still lists sessions. | `SESSIONS_SECTION_ORDER` (Task 3). |
| **`show_unsummarized` called on a legacy/non-project session** | Throws `Project session not found` / `Session subtree incomplete` (no `Exchanges`/`Summary`). Caller should only call it for project-bound sessions. | Guards in Task 5. |
| **Empty `Summary` node renders as a session with 0 exchanges** | Acceptable — surfaces in-progress sessions in the rollup. `metadata.exchanges` starts at 0, updated by `rollUpSession`. | By design. |
| **`store.write` depth cap (5) flattens user/agent levels** | We never rely on `depth` to distinguish nodes; `metadata.kind`/`role`/`seq` carry identity. | Constraint B. |

---

## 9. Test Plan (consolidated)

Run the full suites after the last task:

```bash
cd packages/tim-store && npx vitest run
cd packages/tim-hooks && npx vitest run
```

**Coverage matrix:**

| Behavior | Test (file · `describe`) |
|----------|--------------------------|
| `getChildByKind` filters by kind; `getChildrenBySeq` orders by seq | `store.test.ts · getChildByKind / getChildrenBySeq` |
| `deriveCounters` returns DB-derived zeros/counts | `session.test.ts · deriveCounters` |
| `startProjectSession` builds Sessions/Summary/Exchanges; idempotent; one section reused | `session.test.ts · startProjectSession` |
| Nested `logExchange`: agent child of user, user-only seq, cross-call seq, cache refresh | `session.test.ts · logExchange (nested)` |
| `showUnsummarized`: first batch; skip summarized; `hasMore` | `session.test.ts · showUnsummarized` |
| `writeBatchSummary` idempotent; bumps derived count; `rollUpSession` folds + tags | `session.test.ts · writeBatchSummary + rollUpSession` |
| `getSessionExchanges` tree-aware + legacy fallback; legacy `checkpoint` still green | `session.test.ts · getSessionExchanges tree-awareness` + pre-existing legacy tests |
| Formatter hides `sessions-root`, shows rollup | `project-output.test.ts` |
| Marker round-trip, detection, DB reconcile, single-flight lock | `marker.test.ts` |
| Stop hook spawn/no-spawn/no-marker; injected spawner | `session-hooks.test.ts` |
| MCP wiring (`projectId`, nested log, `show_unsummarized`) | manual stdio/CLI smoke (no MCP unit harness) |

**Regression guard:** the pre-existing `session.test.ts` blocks (`sessionStart`, flat `sessionLog`, `checkpoint`, integration lifecycle) MUST remain unmodified and green — they prove D3 (additive, backward compatible).

---

## 10. Self-Review (run against the spec)

- **Spec coverage:** Project detection (`.tim-project`) → Task 10. Session tree → Tasks 3–4. Summarizer agent → Task 11 (spawn) + §4 (agent loop). `show_unsummarized` → Tasks 5 + 9. Session hooks (Stop) → Task 11. Implementation-files table → §3. Constraints (async, configurable summarizer, explicit empty nodes, counter-as-truth-reinterpreted, render_depth:0) → §2 D1–D8 + Constraint A/B. All six required OUTPUT sections present: ASCII tree (§1.1), per-file steps (§6), data flow (§4), test plan (§9), migration (§7), edge cases (§8).
- **Placeholder scan:** no `TBD`/"add error handling"/"similar to Task N"; every code step shows full code; every command shows expected result.
- **Type consistency:** `startProjectSession`, `logExchange`, `showUnsummarized`, `writeBatchSummary`, `rollUpSession`, `getChildByKind`, `getChildrenBySeq`, `deriveCounters`, `reconcileMarker`, `onSessionStop` names are used identically across tasks. `UnsummarizedBatch.summaryNodeId` matches the field read in Task 6. Constants (`KIND_*`, `SESSIONS_SECTION_ORDER`, `DEFAULT_BATCH_SIZE`) defined once in §3/Task 2 and referenced thereafter.

---

## 11. Execution Handoff

Recommended order: Tasks 1 → 11 (Task 12 optional). Tasks 1–8 are `tim-store`/`tim-mcp`; Tasks 10–11 are `tim-hooks` and depend on the `deriveCounters` export from Task 2. Build dependency packages (`npm run build` in `tim-core` → `tim-store` → `tim-hooks` → `tim-mcp`) before cross-package tests.

Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks (REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`).
2. **Inline Execution** — execute tasks in this session with checkpoints (REQUIRED SUB-SKILL: `superpowers:executing-plans`).
