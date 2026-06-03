# Auto-reparent exchanges on mid-session project switch — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When `tim_load_project` rebinds a live session to a new project, the session node (and all its exchanges/summaries) physically moves to the new project's tree, so no exchanges stay stranded under the old project.

**Architecture:** One session node per `sessionId`. It lives as a child of `<project>/Sessions`. Exchanges/Summary/Batches are its descendants. On rebind, `startProjectSession` already updates `project_ref` metadata but leaves the node parented under the OLD project — so exchanges stay there. Fix: in the rebind branch, also `moveEntry` the session node to the NEW project's `Sessions` section. Descendants follow (parent_id unchanged for them); `findProjectLabelForParent` re-derives project attribution by walking parents at read time; `moveEntry` cascades `depth` and stages all affected ids for sync.

**Tech Stack:** TypeScript, vitest, better-sqlite3 (`TimStore`), existing `CurateManager.moveEntry`.

---

## Background: why "move one node", not "reparent each exchange"

The prompt's Q3 framing ("old session tree → new session tree", "move each exchange / Exchanges root") is based on a wrong mental model. Facts from the code:

- `tim_load_project` calls `startProjectSession` with the **same `sessionId`**. A session is keyed by id. **No second tree is ever created** on switch — there is exactly one session node.
- The session node is `parentId = <oldProject>/Sessions` section (`session.ts:150`). Summary, Exchanges, Batch, and exchange entries are all descendants.
- `findProjectLabelForParent` (`store.ts:378`) derives `project_label` at read time by walking `parent_id` up to the nearest `kind:'project'`. Exchange metadata does **not** store a project. So moving the session node auto-fixes attribution for every descendant — zero per-node writes.
- Edges are keyed by entry id; ids don't change on move → edges survive.
- Depth is identical before/after (both projects have shape `project(1)→Sessions(2)→session(3)→Exchanges(4)→Batch(5)→exchange(5)`), and `moveEntry` recomputes it anyway.

**Decision: move the single session node.** It dominates per-exchange / bulk / Exchanges-root variants on every axis (atomic, fewer writes, attribution + summaries + batches all follow, depth + sync handled by `moveEntry`).

The primitive already exists: `CurateManager.moveEntry(id, newParentId, order?)` (`curate.ts:179`) — sets `parent_id` + `depth`, assigns `order = max+1` when `order` omitted, cascades depth to descendants via recursive CTE, and stages all affected ids (`stageEntries`). It is **synchronous** (returns `Entry`, no `await`). Reached via `this.store.curate().moveEntry(...)`.

## Edge cases (answers to prompt Q5)

| Case | Behavior | Why |
|------|----------|-----|
| Target project missing | Validate `read(projectId).kind === 'project'`, else `throw` | Matches create-path (`session.ts:135`). Defensive only — MCP already validates via `resolveProjectLabel` before calling. |
| Exchanges already under new session | Cannot happen | One node per `sessionId`. If already bound to target, `project_ref === projectId` → branch doesn't fire (no-op). |
| Multiple / back-and-forth switches | Each switch fires once, moves the one node; switching back = another move | `project_ref` differs each real switch → idempotent. |
| Old `Sessions` section left empty | Leave it (YAGNI) | Harmless — `project-output.ts` excludes `sessions-root` from the Sections list, so it's invisible. This is also how "zero user-visible changes" holds. |
| Old project deleted/missing | Move still works | `moveEntry` only needs the **node id** and the **new** parent; it never reads the old parent. |

## Ordering gotcha (critical)

`moveEntry` rewrites the node's `metadata.order` (to `max+1` under new parent). `update()` writes whatever `metadata` you hand it. If you `moveEntry` first, then `update` with the pre-move `existing.metadata`, you **clobber** the new `order` with the stale one.

**Fix: `update` first (sets `project_ref`), then `moveEntry`.** Safe because:
- `update()` (`store.ts:478`) never touches `parent_id` — running it first does not interfere with the move.
- `moveEntry` reads the row fresh inside its transaction, `JSON.parse`s metadata, and only mutates `meta.order` (`curate.ts:199-225`) — it **preserves `project_ref`** we just set.
- `moveEntry`'s `stageEntry` uses `Date.now()`, running after `update`'s timestamp → its (new-parent) payload wins LWW on sync.

---

## File Structure

- **Modify:** `packages/tim-store/src/session.ts` — `startProjectSession`, the existing-session rebind branch (lines 124-132). Only change.
- **Modify (tests):** `packages/tim-store/src/__tests__/session.test.ts` — strengthen the existing rebind test + add a new structural-move test.

No new files. No MCP/server changes — `tim_load_project` already calls `startProjectSession` on rebind (`server.ts:1283`).

---

## Task 1: Failing test — exchanges follow the session on switch

The existing test at `session.test.ts:359` asserts only `project_ref`, which **already passes on buggy code** (`update()` sets it). It logs zero exchanges, so it cannot prove the user requirement ("must not lose those exchanges"). We add a test that fails on current code.

**Files:**
- Test: `packages/tim-store/src/__tests__/session.test.ts` (inside `describe('startProjectSession', ...)`, after the existing rebind test at line 377)

- [ ] **Step 1: Write the failing test**

Insert after line 377 (the closing `});` of the `updates project_ref...` test), still inside `describe('startProjectSession')`:

```typescript
    it('reparents the session node + its exchanges to the new project on switch', async () => {
      await store.createProject('P0096');
      await store.createProject('P0095');

      // Session starts under P0096, logs exchanges there.
      await sessions.startProjectSession({
        sessionId: 'switch-s',
        projectId: 'P0096',
        agentName: 'a',
        cwd: '/',
        harness: 't',
      });
      await sessions.logExchange('switch-s', [
        { role: 'user', content: 'first question' },
        { role: 'agent', content: 'first answer' },
      ]);

      // Grab an exchange id while still under P0096.
      const exBefore = await sessions.getSessionExchanges('switch-s');
      const userExchangeId = exBefore.find(e => e.metadata.role === 'user')!.id;

      // Switch to P0095.
      const rebound = await sessions.startProjectSession({
        sessionId: 'switch-s',
        projectId: 'P0095',
        agentName: 'a',
        cwd: '/',
        harness: 't',
      });

      // project_ref updated.
      expect(rebound.metadata.project_ref).toBe('P0095');

      // Session node now lives under P0095's Sessions section...
      const p0095 = await store.read('P0095');
      const newSection = (await store.getChildByKind(p0095!.id, 'sessions-root'))[0];
      expect(rebound.parentId).toBe(newSection.id);
      const movedNodes = await store.getChildByKind(newSection.id, 'session');
      expect(movedNodes.map(s => s.id)).toContain('switch-s');

      // ...and no longer under P0096's Sessions section.
      const p0096 = await store.read('P0096');
      const oldSections = await store.getChildByKind(p0096!.id, 'sessions-root');
      const oldSessionIds = oldSections.length
        ? (await store.getChildByKind(oldSections[0].id, 'session')).map(s => s.id)
        : [];
      expect(oldSessionIds).not.toContain('switch-s');

      // Strongest check, mapped to the requirement: the moved exchange's
      // derived project_label (parent-walk, read-time) now resolves to P0095.
      const movedExchange = await store.read(userExchangeId);
      expect(movedExchange!.content || movedExchange!.title).toContain('first question');
      const kids = await store.getChildren(newSection.id);
      const sessionChild = kids.find(k => k.id === 'switch-s');
      expect(sessionChild!.metadata.project_ref).toBe('P0095');
    });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/bbbee/projects/tim && npx vitest run packages/tim-store/src/__tests__/session.test.ts -t "reparents the session node"`
Expected: FAIL — `rebound.parentId` still equals P0096's `sessions-root` id (current code only updates `project_ref`, never moves the node), so `expect(rebound.parentId).toBe(newSection.id)` fails.

---

## Task 2: Implement the reparent in `startProjectSession`

**Files:**
- Modify: `packages/tim-store/src/session.ts:124-132`

- [ ] **Step 1: Replace the rebind branch**

Find this block (`session.ts`, inside `startProjectSession`):

```typescript
    const existing = await this.store.read(sessionId);
    if (existing?.metadata.kind === KIND_SESSION) {
      if (existing.metadata.project_ref !== projectId) {
        await this.store.update(sessionId, {
          metadata: { ...existing.metadata, project_ref: projectId },
        });
      }
      return (await this.store.read(sessionId))!;
    }
```

Replace with:

```typescript
    const existing = await this.store.read(sessionId);
    if (existing?.metadata.kind === KIND_SESSION) {
      if (existing.metadata.project_ref !== projectId) {
        // Validate target project (defensive — MCP pre-validates via resolveProjectLabel).
        const newProject = await this.store.read(projectId);
        if (!newProject || newProject.metadata.kind !== 'project') {
          throw new Error(`Project not found: ${projectId}`);
        }

        // Ensure the new project has a Sessions section.
        let newSessionsSection = await findChildByKind(
          this.store,
          newProject.id,
          KIND_SESSIONS_ROOT,
        );
        if (!newSessionsSection) {
          newSessionsSection = await this.store.write(SESSIONS_SECTION_TITLE, {
            parentId: newProject.id,
            metadata: { kind: KIND_SESSIONS_ROOT, render_depth: 0, order: SESSIONS_SECTION_ORDER },
            tags: ['#sessions'],
          });
        }

        // ORDER MATTERS: update project_ref FIRST, then move.
        // update() never touches parent_id; moveEntry preserves project_ref and
        // re-derives order/depth + cascades to descendants. Reversing the order
        // would clobber the order moveEntry assigns. moveEntry is synchronous.
        await this.store.update(sessionId, {
          metadata: { ...existing.metadata, project_ref: projectId },
        });
        this.store.curate().moveEntry(sessionId, newSessionsSection.id);
      }
      return (await this.store.read(sessionId))!;
    }
```

(All referenced symbols — `findChildByKind`, `KIND_SESSIONS_ROOT`, `SESSIONS_SECTION_TITLE`, `SESSIONS_SECTION_ORDER`, `KIND_SESSION` — are already imported at the top of `session.ts:4-21`. No new imports.)

- [ ] **Step 2: Run the new test to verify it passes**

Run: `cd /home/bbbee/projects/tim && npx vitest run packages/tim-store/src/__tests__/session.test.ts -t "reparents the session node"`
Expected: PASS.

- [ ] **Step 3: Run the full session test file**

Run: `cd /home/bbbee/projects/tim && npx vitest run packages/tim-store/src/__tests__/session.test.ts`
Expected: PASS (existing `updates project_ref...` test still passes — it asserts a subset of the new behavior).

---

## Task 3: Strengthen the existing rebind test (optional hardening)

The old test at line 359 is now a weaker subset. Make it explicit that it covers the no-exchange path and add a back-and-forth assertion so multi-switch idempotency is covered.

**Files:**
- Modify: `packages/tim-store/src/__tests__/session.test.ts:359-377`

- [ ] **Step 1: Append a back-and-forth switch assertion**

Inside the existing `it('updates project_ref when rebinding...')` test, after `expect(rebound.metadata.project_ref).toBe('P0095');` (line 376), add:

```typescript
      // Switch back to P0096 — node moves again, idempotent.
      const back = await sessions.startProjectSession({
        sessionId: 'rebind-s',
        projectId: 'P0096',
        agentName: 'a',
        cwd: '/',
        harness: 't',
      });
      expect(back.metadata.project_ref).toBe('P0096');
      const p0096b = await store.read('P0096');
      const sec96 = (await store.getChildByKind(p0096b!.id, 'sessions-root'))[0];
      expect(back.parentId).toBe(sec96.id);

      // No-op switch to the same project leaves it put.
      const noop = await sessions.startProjectSession({
        sessionId: 'rebind-s',
        projectId: 'P0096',
        agentName: 'a',
        cwd: '/',
        harness: 't',
      });
      expect(noop.parentId).toBe(sec96.id);
```

- [ ] **Step 2: Run the file**

Run: `cd /home/bbbee/projects/tim && npx vitest run packages/tim-store/src/__tests__/session.test.ts`
Expected: PASS.

---

## Task 4: Full verification + commit

- [ ] **Step 1: Typecheck**

Run: `cd /home/bbbee/projects/tim && npx tsc -b`
Expected: clean, no errors. (Build order per JOURNAL gotcha: `tsc -b` walks project refs — no manual ordering needed for a `tim-store`-internal change.)

- [ ] **Step 2: Full test suite**

Run: `cd /home/bbbee/projects/tim && npm test`
Expected: all green — prior count + the new test(s). No regressions in `tim-mcp` / `tim-summarizer` (they call `startProjectSession`; the create path is unchanged and the rebind path is a superset of old behavior).

- [ ] **Step 3: Commit**

```bash
cd /home/bbbee/projects/tim
git add packages/tim-store/src/session.ts packages/tim-store/src/__tests__/session.test.ts docs/exchange-reparent-plan.md
git commit -m "feat(session): reparent session node to new project on mid-session switch

On tim_load_project rebind, move the session node (and its exchange
descendants) into the new project's Sessions section instead of leaving
them stranded under the old project. moveEntry cascades depth + stages
for sync; project_label re-derives via parent walk.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

- **Spec coverage (prompt Qs):** Q1 rebind location → `startProjectSession` rebind branch (`session.ts:124`), reached from `server.ts:1283` (documented). Q2 find old exchanges → not needed; descendants follow the node. Q3 how to reparent → `moveEntry` on the **session node**, with rationale why this beats per-exchange. Q4 old tree fate → node moves (not copied); empty old `Sessions` section left behind deliberately (table). Q5 edge cases → table. ✅
- **Constraints:** 233/full suite + new tests (Tasks 1,3,4). `tsc -b` clean (Task 4.1). Zero user-visible changes — `sessions-root` excluded from Sections render. ✅
- **Placeholder scan:** none — every code step has full code + exact paths + commands. ✅
- **Type consistency:** `moveEntry(id, newParentId)` matches `curate.ts:179`; sync (no `await`). `findChildByKind`, `KIND_SESSIONS_ROOT`, `SESSIONS_SECTION_TITLE`, `SESSIONS_SECTION_ORDER` all pre-imported. `update`-then-`moveEntry` ordering matches the gotcha section. ✅
