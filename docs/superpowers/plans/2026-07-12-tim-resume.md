# /tim-resume — Cross-Tool Session Resumption Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resume a previous TIM session from any tool (Claude/Cursor/Codex): inject session summary + batch summaries + last 10 raw exchanges via MCP tool, and alias the new harness session to the old session node so exchanges keep appending there.

**Architecture:** All logic + tests in `tim-store` (alias resolution on `TimStore`, `resumeSession`/`listResumableSessions` on `SessionManager`). Thin tool wrappers `tim_resume_list` + `tim_session_resume` in `tim-mcp` (payload formatting in a new `resume-output.ts`). Presentation protocol as skill `tim-resume` in `tim-skills`.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), better-sqlite3 via existing `TimStore.db`, zod schemas, vitest.

**Spec:** `docs/superpowers/specs/2026-07-12-tim-resume-design.md` — read it first.

## Global Constraints

- Work on branch `feature/tim-resume` (create from `master` at start; do NOT commit to master)
- Monorepo workspaces; run tests per package: `cd packages/tim-store && npx vitest run` (same for tim-mcp)
- Node ESM: relative imports need `.js` suffix (`from './store.js'`)
- `resolveSessionAlias` MUST be identity for non-aliased IDs — all existing session tests must pass unchanged
- No schema migration; `resumed_by` / `tool_history` are plain metadata fields
- `metadata.resumed_by` is `string[]`, no duplicates; `metadata.tool_history` is `string[]`
- Never edit files under `packages/*/dist/` — source only, build via `npm run build`
- Session-tree constants come from `packages/tim-store/src/session-tree.ts` (KIND_SESSION, KIND_SUMMARY_ROOT, KIND_BATCH, KIND_EXCHANGES_ROOT, KIND_EXCHANGE_BATCH)

---

### Task 0: Branch

- [ ] **Step 1:** `cd /home/bbbee/projects/tim && git checkout -b feature/tim-resume`

---

### Task 1: `TimStore.resolveSessionAlias`

**Files:**
- Modify: `packages/tim-store/src/store.ts` (add one method, near `countSessionSummaries`)
- Test: `packages/tim-store/src/__tests__/session-resume.test.ts` (new file)

**Interfaces:**
- Produces: `TimStore.resolveSessionAlias(harnessId: string): string` — sync method, returns canonical session id if `harnessId` is a recorded alias, else the input unchanged.

- [ ] **Step 1: Write the failing test**

Create `packages/tim-store/src/__tests__/session-resume.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TimStore, SessionManager } from '../index.js';

describe('resolveSessionAlias', () => {
  let store: TimStore;
  let sessions: SessionManager;

  beforeEach(async () => {
    store = new TimStore(':memory:');
    sessions = new SessionManager(store);
    await store.createProject('P0099', { content: 'Test project' });
  });

  afterEach(() => {
    store.close();
  });

  async function startSession(id: string) {
    return sessions.startProjectSession({
      sessionId: id,
      projectId: 'P0099',
      agentName: 'test',
      cwd: '/tmp/x',
      harness: 'test',
    });
  }

  it('is identity for unknown ids', () => {
    expect(store.resolveSessionAlias('nope')).toBe('nope');
  });

  it('is identity for canonical session ids', async () => {
    await startSession('sess-A');
    expect(store.resolveSessionAlias('sess-A')).toBe('sess-A');
  });

  it('resolves an aliased harness id to the canonical session', async () => {
    const s = await startSession('sess-A');
    await store.update(s.id, {
      metadata: { ...s.metadata, resumed_by: ['harness-B'] },
    });
    expect(store.resolveSessionAlias('harness-B')).toBe('sess-A');
  });

  it('resolves any of multiple aliases', async () => {
    const s = await startSession('sess-A');
    await store.update(s.id, {
      metadata: { ...s.metadata, resumed_by: ['harness-B', 'harness-C'] },
    });
    expect(store.resolveSessionAlias('harness-C')).toBe('sess-A');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/tim-store && npx vitest run src/__tests__/session-resume.test.ts`
Expected: FAIL — `resolveSessionAlias is not a function`

- [ ] **Step 3: Implement**

In `packages/tim-store/src/store.ts`, add after `countSessionSummaries`:

```ts
  /** Resolve a harness session id to its canonical session node id.
   *  Identity for non-aliased ids (including canonical session ids). */
  resolveSessionAlias(harnessId: string): string {
    const direct = this.db.prepare(`
      SELECT id FROM entries
      WHERE id = ?
        AND json_extract(metadata, '$.kind') = 'session'
        AND tombstoned_at IS NULL
    `).get(harnessId) as { id: string } | undefined;
    if (direct) return harnessId;

    const row = this.db.prepare(`
      SELECT id FROM entries
      WHERE json_extract(metadata, '$.kind') = 'session'
        AND tombstoned_at IS NULL
        AND EXISTS (
          SELECT 1 FROM json_each(json_extract(metadata, '$.resumed_by'))
          WHERE json_each.value = ?
        )
      LIMIT 1
    `).get(harnessId) as { id: string } | undefined;
    return row?.id ?? harnessId;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/tim-store && npx vitest run src/__tests__/session-resume.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add packages/tim-store/src/store.ts packages/tim-store/src/__tests__/session-resume.test.ts
git commit -m "feat(tim-store): resolveSessionAlias — harness id → canonical session"
```

---

### Task 2: `SessionManager.resumeSession` + `ResumePayload`

**Files:**
- Modify: `packages/tim-store/src/session.ts` (new interfaces + method on `SessionManager`)
- Modify: `packages/tim-store/src/index.ts` (export new types if types are exported there — follow the existing export pattern for `UnsummarizedBatch`)
- Test: `packages/tim-store/src/__tests__/session-resume.test.ts` (extend)

**Interfaces:**
- Consumes: `TimStore.resolveSessionAlias` (Task 1), `findChildByKind`, `deriveCounters`, session-tree constants
- Produces:

```ts
export interface ResumeBatchSummary {
  batchIndex: number;
  seqFrom: number;
  seqTo: number;
  text: string;
}
export interface ResumeExchange {
  seq: number;
  userContent: string;
  agentContent: string | null;
}
export interface ResumePayload {
  sessionId: string;              // canonical id
  sessionMeta: {
    project?: string;
    date?: string;
    tool?: string;
    toolHistory: string[];
    exchangeCount: number;
    taskSummary?: string;
  };
  sessionSummary: string;
  batchSummaries: ResumeBatchSummary[];
  recentExchanges: ResumeExchange[];
  warnings: string[];
}
export interface ResumeSessionOpts {
  newHarnessId?: string;
  tool?: string;
  model?: string;
  rawCount?: number;              // default 10
}
// on SessionManager:
async resumeSession(oldSessionId: string, opts?: ResumeSessionOpts): Promise<ResumePayload>
```

- [ ] **Step 1: Write the failing tests**

Append to `session-resume.test.ts` (inside the top-level describe, reusing `startSession`; also import `deriveCounters` from `../index.js`):

```ts
  describe('resumeSession', () => {
    async function seedSession(id: string, exchangeCount: number) {
      await startSession(id);
      for (let i = 1; i <= exchangeCount; i++) {
        await sessions.logExchange(id, [
          { role: 'user', content: `user msg ${i}` },
          { role: 'agent', content: `agent msg ${i}` },
        ]);
      }
    }

    it('returns summary, batch summaries in order, and last N raw exchanges ascending', async () => {
      await seedSession('sess-R', 12);
      await sessions.writeBatchSummary('sess-R', 1, 'summary of batch 1', { seqFrom: 1, seqTo: 5 });
      await sessions.writeBatchSummary('sess-R', 2, 'summary of batch 2', { seqFrom: 6, seqTo: 10 });
      await sessions.updateSessionSummary('sess-R', 'overall session summary');

      const p = await sessions.resumeSession('sess-R', { newHarnessId: 'harness-2', rawCount: 10 });

      expect(p.sessionId).toBe('sess-R');
      expect(p.sessionSummary).toBe('overall session summary');
      expect(p.batchSummaries.map(b => b.batchIndex)).toEqual([1, 2]);
      expect(p.batchSummaries[0]!.text).toBe('summary of batch 1');
      expect(p.recentExchanges).toHaveLength(10);
      expect(p.recentExchanges[0]!.seq).toBe(3);
      expect(p.recentExchanges[9]!.seq).toBe(12);
      expect(p.recentExchanges[9]!.userContent).toBe('user msg 12');
      expect(p.recentExchanges[9]!.agentContent).toBe('agent msg 12');
    });

    it('returns all exchanges when fewer than rawCount', async () => {
      await seedSession('sess-S', 3);
      const p = await sessions.resumeSession('sess-S', { newHarnessId: 'h-x' });
      expect(p.recentExchanges).toHaveLength(3);
    });

    it('records alias idempotently and accumulates tool_history', async () => {
      await seedSession('sess-T', 1);
      await sessions.resumeSession('sess-T', { newHarnessId: 'h-1', tool: 'cursor' });
      await sessions.resumeSession('sess-T', { newHarnessId: 'h-1', tool: 'cursor' });
      await sessions.resumeSession('sess-T', { newHarnessId: 'h-2', tool: 'codex' });

      const s = (await store.read('sess-T'))!;
      expect(s.metadata.resumed_by).toEqual(['h-1', 'h-2']);
      expect(s.metadata.tool).toBe('codex');
      expect(s.metadata.tool_history).toEqual(['cursor', 'codex']);
      expect(typeof s.metadata.resumed_at).toBe('string');
    });

    it('warns when no batch summaries exist', async () => {
      await seedSession('sess-U', 2);
      const p = await sessions.resumeSession('sess-U', { newHarnessId: 'h-u' });
      expect(p.warnings.some(w => w.includes('batch summaries'))).toBe(true);
    });

    it('warns when no harness id is provided and records no alias', async () => {
      await seedSession('sess-V', 1);
      const p = await sessions.resumeSession('sess-V', {});
      expect(p.warnings.some(w => w.includes('harness'))).toBe(true);
      const s = (await store.read('sess-V'))!;
      expect(s.metadata.resumed_by).toBeUndefined();
    });

    it('rejects when newHarnessId is a session with exchanges', async () => {
      await seedSession('sess-W', 1);
      await seedSession('sess-X', 2);
      await expect(
        sessions.resumeSession('sess-W', { newHarnessId: 'sess-X' }),
      ).rejects.toThrow(/already has/);
    });

    it('allows self-resume (old id == new harness id) without alias', async () => {
      await seedSession('sess-Y', 2);
      const p = await sessions.resumeSession('sess-Y', { newHarnessId: 'sess-Y' });
      expect(p.sessionId).toBe('sess-Y');
      const s = (await store.read('sess-Y'))!;
      expect(s.metadata.resumed_by).toBeUndefined();
    });

    it('tolerates an empty auto-created session node as newHarnessId', async () => {
      await seedSession('sess-Z', 1);
      await startSession('sess-EMPTY'); // session node, zero exchanges
      const p = await sessions.resumeSession('sess-Z', { newHarnessId: 'sess-EMPTY' });
      expect(p.sessionId).toBe('sess-Z');
      const s = (await store.read('sess-Z'))!;
      expect(s.metadata.resumed_by).toEqual(['sess-EMPTY']);
    });

    it('rejects legacy flat sessions (no exchanges-root)', async () => {
      await sessions.sessionStart({
        sessionId: 'sess-flat', agentName: 'a', cwd: '/tmp', harness: 'h',
      });
      await expect(sessions.resumeSession('sess-flat', {})).rejects.toThrow(/legacy/);
    });

    it('rejects unknown session ids', async () => {
      await expect(sessions.resumeSession('nope', {})).rejects.toThrow(/not found/i);
    });
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/tim-store && npx vitest run src/__tests__/session-resume.test.ts`
Expected: FAIL — `resumeSession is not a function`

- [ ] **Step 3: Implement**

In `packages/tim-store/src/session.ts`, add the four interfaces from the Interfaces block above (exported, near `UnsummarizedBatch`), then add to `SessionManager`:

```ts
  async resumeSession(
    oldSessionId: string,
    opts: ResumeSessionOpts = {},
  ): Promise<ResumePayload> {
    const canonical = this.store.resolveSessionAlias(oldSessionId);
    const session = await this.store.read(canonical);
    if (!session || session.metadata.kind !== KIND_SESSION) {
      throw new Error(`Session not found: ${oldSessionId}`);
    }
    const exNode = await findChildByKind(this.store, canonical, KIND_EXCHANGES_ROOT);
    if (!exNode) {
      throw new Error(`Session uses legacy format and cannot be resumed: ${oldSessionId}`);
    }
    const summaryNode = await findChildByKind(this.store, canonical, KIND_SUMMARY_ROOT);

    const warnings: string[] = [];
    const newHarnessId = opts.newHarnessId?.trim() || undefined;

    if (newHarnessId && newHarnessId !== canonical) {
      const existing = await this.store.read(newHarnessId);
      if (existing?.metadata.kind === KIND_SESSION) {
        const { exchangeCount } = await deriveCounters(this.store, newHarnessId);
        if (exchangeCount > 0) {
          throw new Error(
            `Harness session ${newHarnessId} already has ${exchangeCount} exchanges — ` +
            `start fresh or resume from that session instead`,
          );
        }
      }
      const fresh = (await this.store.read(canonical))!;
      const resumedBy = Array.isArray(fresh.metadata.resumed_by)
        ? [...(fresh.metadata.resumed_by as string[])]
        : [];
      if (!resumedBy.includes(newHarnessId)) resumedBy.push(newHarnessId);
      const toolHistory = Array.isArray(fresh.metadata.tool_history)
        ? [...(fresh.metadata.tool_history as string[])]
        : typeof fresh.metadata.tool === 'string' ? [fresh.metadata.tool] : [];
      if (opts.tool && toolHistory[toolHistory.length - 1] !== opts.tool) {
        toolHistory.push(opts.tool);
      }
      await this.store.update(canonical, {
        metadata: {
          ...fresh.metadata,
          resumed_by: resumedBy,
          resumed_at: new Date().toISOString(),
          tool_history: toolHistory,
          ...(opts.tool && { tool: opts.tool }),
          ...(opts.model && { model: opts.model }),
        },
      });
    } else if (!newHarnessId) {
      warnings.push(
        'No harness session id available — alias not recorded; ' +
        'new exchanges may open a new session.',
      );
    }

    const batchSummaries: ResumeBatchSummary[] = summaryNode
      ? (await this.store.getChildByKind(summaryNode.id, KIND_BATCH))
          .sort((a, b) => Number(a.metadata.batch_index) - Number(b.metadata.batch_index))
          .map(b => ({
            batchIndex: Number(b.metadata.batch_index),
            seqFrom: Number(b.metadata.seq_from),
            seqTo: Number(b.metadata.seq_to),
            text: b.content ?? '',
          }))
      : [];
    if (batchSummaries.length === 0) {
      warnings.push('No batch summaries yet — summarizer may be behind.');
    }

    const rawCount = opts.rawCount ?? 10;
    const exBatches = (await this.store.getChildByKind(exNode.id, KIND_EXCHANGE_BATCH))
      .sort((a, b) => Number(a.metadata.batch_index) - Number(b.metadata.batch_index));
    const users: Entry[] = [];
    for (const b of exBatches) {
      users.push(
        ...(await this.store.getChildrenBySeq(b.id)).filter(u => u.metadata.role === 'user'),
      );
    }
    users.sort((a, b) => Number(a.metadata.seq) - Number(b.metadata.seq));
    const recentUsers = users.slice(-rawCount);
    const recentExchanges: ResumeExchange[] = [];
    for (const u of recentUsers) {
      const replies = await this.store.getChildren(u.id);
      const agent = replies.find(r => r.metadata.role === 'agent') ?? null;
      recentExchanges.push({
        seq: Number(u.metadata.seq),
        userContent: u.content || u.title,
        agentContent: agent ? (agent.content || agent.title) : null,
      });
    }

    const freshSession = (await this.store.read(canonical))!;
    return {
      sessionId: canonical,
      sessionMeta: {
        project: typeof freshSession.metadata.project_ref === 'string'
          ? freshSession.metadata.project_ref : undefined,
        date: typeof freshSession.metadata.date === 'string'
          ? freshSession.metadata.date : undefined,
        tool: typeof freshSession.metadata.tool === 'string'
          ? freshSession.metadata.tool : undefined,
        toolHistory: Array.isArray(freshSession.metadata.tool_history)
          ? (freshSession.metadata.tool_history as string[]) : [],
        exchangeCount: typeof freshSession.metadata.exchange_count === 'number'
          ? freshSession.metadata.exchange_count : 0,
        taskSummary: typeof freshSession.metadata.task_summary === 'string'
          ? freshSession.metadata.task_summary : undefined,
      },
      sessionSummary: summaryNode?.content ?? '',
      batchSummaries,
      recentExchanges,
      warnings,
    };
  }
```

If `packages/tim-store/src/index.ts` re-exports session types explicitly, add `ResumePayload`, `ResumeSessionOpts`, `ResumeBatchSummary`, `ResumeExchange`; if it uses `export * from './session.js'`, nothing to do.

- [ ] **Step 4: Run to verify pass**

Run: `cd packages/tim-store && npx vitest run src/__tests__/session-resume.test.ts`
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add packages/tim-store/src/session.ts packages/tim-store/src/index.ts packages/tim-store/src/__tests__/session-resume.test.ts
git commit -m "feat(tim-store): SessionManager.resumeSession — alias binding + resume payload"
```

---

### Task 3: `listResumableSessions`

**Files:**
- Modify: `packages/tim-store/src/store.ts` (add `listProjectSessionsByActivity`)
- Modify: `packages/tim-store/src/session.ts` (add `listResumableSessions` + `ResumableSession` interface)
- Test: `packages/tim-store/src/__tests__/session-resume.test.ts` (extend)

**Interfaces:**
- Produces:

```ts
// TimStore:
listProjectSessionsByActivity(projectId: string, limit?: number): Array<{ id: string; lastActivity: string }>
// SessionManager:
export interface ResumableSession {
  sessionId: string;
  title: string;
  date?: string;
  lastActivity: string;
  tool?: string;
  taskSummary?: string;
  exchangeCount: number;
  summaryFirstLine: string;
}
async listResumableSessions(projectRef: string, limit = 10): Promise<ResumableSession[]>
```

- [ ] **Step 1: Write the failing test**

Append to `session-resume.test.ts`:

```ts
  describe('listResumableSessions', () => {
    it('lists sessions of the project sorted by last activity, newest first', async () => {
      const a = await startSession('sess-old');
      await sessions.logExchange('sess-old', [
        { role: 'user', content: 'old work' },
        { role: 'agent', content: 'ok' },
      ]);
      await startSession('sess-new');
      await sessions.logExchange('sess-new', [
        { role: 'user', content: 'new work' },
        { role: 'agent', content: 'ok' },
      ]);
      // touch the OLD session again — it becomes most recently active
      await sessions.logExchange('sess-old', [
        { role: 'user', content: 'back to old' },
        { role: 'agent', content: 'ok' },
      ]);
      await sessions.updateSessionSummary('sess-old', 'first line of old summary\nmore text');

      const list = await sessions.listResumableSessions('P0099');
      expect(list.map(s => s.sessionId)).toEqual(['sess-old', 'sess-new']);
      expect(list[0]!.exchangeCount).toBe(2);
      expect(list[0]!.summaryFirstLine).toBe('first line of old summary');
      expect(a.id).toBe('sess-old');
    });

    it('respects the limit', async () => {
      for (let i = 0; i < 4; i++) await startSession(`sess-l${i}`);
      const list = await sessions.listResumableSessions('P0099', 2);
      expect(list).toHaveLength(2);
    });

    it('returns empty array for a project without sessions', async () => {
      await store.createProject('P0098', { content: 'empty' });
      expect(await sessions.listResumableSessions('P0098')).toEqual([]);
    });
  });
```

Note: SQLite `created_at` has second precision; if ordering is flaky in-test, the implementation must tiebreak deterministically (see Step 3 — `MAX(created_at) DESC, root DESC` is not enough; use `rowid` via `MAX(e.rowid)` as the activity tiebreaker, since rowids are monotonic per insert).

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/tim-store && npx vitest run src/__tests__/session-resume.test.ts`
Expected: FAIL — `listResumableSessions is not a function`

- [ ] **Step 3: Implement**

`packages/tim-store/src/store.ts` — add after `resolveSessionAlias`:

```ts
  /** Sessions under a project's sessions-root, newest activity first.
   *  Activity = latest insert (rowid) anywhere in the session subtree. */
  listProjectSessionsByActivity(
    projectId: string,
    limit = 10,
  ): Array<{ id: string; lastActivity: string }> {
    const sessionsRoot = this.db.prepare(`
      SELECT id FROM entries
      WHERE parent_id = ?
        AND json_extract(metadata, '$.kind') = 'sessions-root'
        AND tombstoned_at IS NULL
    `).get(projectId) as { id: string } | undefined;
    if (!sessionsRoot) return [];

    const rows = this.db.prepare(`
      WITH RECURSIVE sub AS (
        SELECT id, id AS root, created_at, rowid AS rid FROM entries
        WHERE parent_id = ?
          AND json_extract(metadata, '$.kind') = 'session'
          AND tombstoned_at IS NULL
          AND irrelevant = 0
        UNION ALL
        SELECT e.id, sub.root, e.created_at, e.rowid FROM entries e
        INNER JOIN sub ON e.parent_id = sub.id
        WHERE e.tombstoned_at IS NULL
      )
      SELECT root, MAX(created_at) AS last, MAX(rid) AS lastRid FROM sub
      GROUP BY root
      ORDER BY lastRid DESC
      LIMIT ?
    `).all(sessionsRoot.id, limit) as Array<{ root: string; last: string; lastRid: number }>;

    return rows.map(r => ({ id: r.root, lastActivity: r.last }));
  }
```

Note: if `entries` is declared `WITHOUT ROWID` (check `CREATE TABLE` in `schema.ts` — it is not, as of migration v12, but verify), fall back to `ORDER BY last DESC, root DESC`.

`packages/tim-store/src/session.ts` — add `ResumableSession` interface (from Interfaces block) and:

```ts
  async listResumableSessions(projectRef: string, limit = 10): Promise<ResumableSession[]> {
    const project = await this.store.requireProject(projectRef);
    const rows = this.store.listProjectSessionsByActivity(project.id, limit);
    const out: ResumableSession[] = [];
    for (const { id, lastActivity } of rows) {
      const session = await this.store.read(id);
      if (!session) continue;
      const summaryNode = await findChildByKind(this.store, id, KIND_SUMMARY_ROOT);
      const summaryFirstLine =
        (summaryNode?.content ?? '').split('\n').find(l => l.trim())?.trim() ?? '';
      out.push({
        sessionId: id,
        title: session.title,
        date: typeof session.metadata.date === 'string' ? session.metadata.date : undefined,
        lastActivity,
        tool: typeof session.metadata.tool === 'string' ? session.metadata.tool : undefined,
        taskSummary: typeof session.metadata.task_summary === 'string'
          ? session.metadata.task_summary : undefined,
        exchangeCount: typeof session.metadata.exchange_count === 'number'
          ? session.metadata.exchange_count : 0,
        summaryFirstLine,
      });
    }
    return out;
  }
```

- [ ] **Step 4: Run to verify pass**

Run: `cd packages/tim-store && npx vitest run src/__tests__/session-resume.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/tim-store/src/store.ts packages/tim-store/src/session.ts packages/tim-store/src/__tests__/session-resume.test.ts
git commit -m "feat(tim-store): listResumableSessions — project sessions by last activity"
```

---

### Task 4: Wire alias resolution into SessionManager entry points

**Files:**
- Modify: `packages/tim-store/src/session.ts`
- Test: `packages/tim-store/src/__tests__/session-resume.test.ts` (extend)

**Interfaces:**
- Consumes: `TimStore.resolveSessionAlias` (Task 1)
- Produces: no new API — `logExchange`, `showUnsummarized`, `checkpoint`, `sessionLog`, `getSessionExchanges`, `writeBatchSummary`, `rollUpSession`, `updateSessionSummary`, `aggregateSessionTags` transparently accept aliased ids.

- [ ] **Step 1: Write the failing test**

Append to `session-resume.test.ts`:

```ts
  describe('alias-transparent session APIs', () => {
    it('logExchange via alias appends to the canonical session with continuous seq', async () => {
      await startSession('sess-cont');
      await sessions.logExchange('sess-cont', [
        { role: 'user', content: 'u1' }, { role: 'agent', content: 'a1' },
        { role: 'user', content: 'u2' }, { role: 'agent', content: 'a2' },
      ]);
      await sessions.resumeSession('sess-cont', { newHarnessId: 'cursor-77', tool: 'cursor' });

      // Cursor's hooks log with THEIR harness id:
      await sessions.logExchange('cursor-77', [
        { role: 'user', content: 'u3 from cursor' }, { role: 'agent', content: 'a3' },
      ]);

      const p = await sessions.resumeSession('sess-cont', { newHarnessId: 'cursor-77' });
      expect(p.recentExchanges.map(e => e.seq)).toEqual([1, 2, 3]);
      expect(p.recentExchanges[2]!.userContent).toBe('u3 from cursor');
      expect(p.sessionMeta.exchangeCount).toBe(3);
    });

    it('showUnsummarized works via alias', async () => {
      await startSession('sess-su');
      await sessions.logExchange('sess-su', [
        { role: 'user', content: 'u1' }, { role: 'agent', content: 'a1' },
      ]);
      await sessions.resumeSession('sess-su', { newHarnessId: 'alias-su' });
      const batch = await sessions.showUnsummarized('alias-su');
      expect(batch.sessionId).toBe('sess-su');
      expect(batch.exchanges).toHaveLength(1);
    });

    it('parallel resume from two tools stays seq-consistent', async () => {
      await startSession('sess-par');
      await sessions.logExchange('sess-par', [
        { role: 'user', content: 'u1' }, { role: 'agent', content: 'a1' },
      ]);
      await sessions.resumeSession('sess-par', { newHarnessId: 'tool-A' });
      await sessions.resumeSession('sess-par', { newHarnessId: 'tool-B' });
      await sessions.logExchange('tool-A', [{ role: 'user', content: 'uA' }]);
      await sessions.logExchange('tool-B', [{ role: 'user', content: 'uB' }]);

      const p = await sessions.resumeSession('sess-par', {});
      expect(p.recentExchanges.map(e => e.seq)).toEqual([1, 2, 3]);
    });
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/tim-store && npx vitest run src/__tests__/session-resume.test.ts`
Expected: FAIL — `Project session not found: cursor-77` (and similar)

- [ ] **Step 3: Implement**

In `SessionManager`, at the very top of each of these methods, resolve the id before any use:

`logExchange`, `showUnsummarized`, `checkpoint`, `sessionLog`, `getSessionExchanges`, `writeBatchSummary`, `rollUpSession`, `updateSessionSummary`, `aggregateSessionTags`:

```ts
    sessionId = this.store.resolveSessionAlias(sessionId);
```

(For methods whose parameter is `const`-bound by signature style, introduce `const resolved = this.store.resolveSessionAlias(sessionId);` and use `resolved` throughout — pick whichever matches each method's body with the smallest diff. Note `writeBatchSummary` passes `sessionId` into `writeBatchSummarySync` and metadata — the resolved id must be what lands in `metadata.sessionId` of batch nodes.)

Do NOT touch `sessionStart` / `startProjectSession` (a brand-new harness session must still be able to create its own node — resume happens explicitly afterwards).

- [ ] **Step 4: Run full tim-store suite**

Run: `cd packages/tim-store && npx vitest run`
Expected: ALL PASS — the resolution is identity for non-aliased ids, so no existing test may break. If any existing test fails, fix the wiring, not the test.

- [ ] **Step 5: Commit**

```bash
git add packages/tim-store/src/session.ts packages/tim-store/src/__tests__/session-resume.test.ts
git commit -m "feat(tim-store): alias-transparent session APIs — resolve harness ids at entry points"
```

---

### Task 5: MCP tools `tim_resume_list` + `tim_session_resume`

**Files:**
- Create: `packages/tim-mcp/src/resume-output.ts`
- Modify: `packages/tim-mcp/src/server.ts` (schemas, tool defs, handlers, WRITE_TOOLS/READ_TOOLS)
- Test: `packages/tim-mcp/src/__tests__/resume-output.test.ts` (new)

**Interfaces:**
- Consumes: `SessionManager.listResumableSessions`, `SessionManager.resumeSession`, `ResumePayload`, `ResumableSession` (Tasks 2-3); `rotateMarkerSession`, `findMarker` from `tim-hooks`; existing server helpers `getSessions()`, `getActiveProjectLabel()`, `buildInboxFallbackGuidance`, `maybeSpawnSummarizer`, `isHttp`
- Produces: MCP tools `tim_resume_list { projectId?, limit? }` and `tim_session_resume { sessionId, rawCount? }`; `formatResumePayload(p: ResumePayload): string` and `formatResumeList(label: string, list: ResumableSession[]): string`

- [ ] **Step 1: Write the failing formatter tests**

Create `packages/tim-mcp/src/__tests__/resume-output.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { formatResumePayload, formatResumeList } from '../resume-output.js';
import type { ResumePayload, ResumableSession } from 'tim-store';

describe('formatResumeList', () => {
  it('renders numbered list with ACTION line', () => {
    const list: ResumableSession[] = [{
      sessionId: 'sess-1',
      title: '2026-07-12-0930',
      date: '2026-07-12T09:30:00Z',
      lastActivity: '2026-07-12T11:00:00Z',
      tool: 'claude',
      taskSummary: 'queue ordering',
      exchangeCount: 14,
      summaryFirstLine: 'Implemented insert-between gaps',
    }];
    const text = formatResumeList('P0063', list);
    expect(text).toContain('1. sess-1');
    expect(text).toContain('claude');
    expect(text).toContain('14 exchanges');
    expect(text).toContain('Implemented insert-between gaps');
    expect(text).toContain('ACTION:');
    expect(text).toContain('tim_session_resume');
  });

  it('handles empty list', () => {
    expect(formatResumeList('P0063', [])).toContain('No resumable sessions');
  });
});

describe('formatResumePayload', () => {
  const payload: ResumePayload = {
    sessionId: 'sess-1',
    sessionMeta: {
      project: 'P0063', date: '2026-07-12T09:30:00Z', tool: 'cursor',
      toolHistory: ['claude', 'cursor'], exchangeCount: 12, taskSummary: 'queue ordering',
    },
    sessionSummary: 'overall summary',
    batchSummaries: [{ batchIndex: 1, seqFrom: 1, seqTo: 5, text: 'batch one text' }],
    recentExchanges: [{ seq: 11, userContent: 'do X', agentContent: 'done X' }],
    warnings: ['No batch summaries yet — summarizer may be behind.'],
  };

  it('renders all sections and the ACTION footer', () => {
    const text = formatResumePayload(payload);
    expect(text).toContain('## Resumed Session');
    expect(text).toContain('## Session Summary');
    expect(text).toContain('overall summary');
    expect(text).toContain('### Batch 1 (seq 1–5)');
    expect(text).toContain('batch one text');
    expect(text).toContain('[seq 11] USER: do X');
    expect(text).toContain('[seq 11] AGENT: done X');
    expect(text).toContain('⚠');
    expect(text).toContain('ACTION: Context restored');
  });

  it('omits empty summary section gracefully', () => {
    const text = formatResumePayload({ ...payload, sessionSummary: '', batchSummaries: [] });
    expect(text).toContain('(no session summary yet)');
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd packages/tim-mcp && npx vitest run src/__tests__/resume-output.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the formatters**

Create `packages/tim-mcp/src/resume-output.ts`:

```ts
// Formatting for tim_resume_list / tim_session_resume tool responses.
import type { ResumePayload, ResumableSession } from 'tim-store';

export function formatResumeList(projectLabel: string, list: ResumableSession[]): string {
  if (list.length === 0) {
    return `No resumable sessions found for ${projectLabel}.`;
  }
  const lines = list.map((s, i) => {
    const date = (s.date ?? s.lastActivity).slice(0, 16).replace('T', ' ');
    const parts = [
      `${i + 1}. ${s.sessionId} — ${date}`,
      s.tool ?? 'unknown tool',
      `${s.exchangeCount} exchanges`,
      ...(s.taskSummary ? [s.taskSummary] : []),
    ].join(' · ');
    return s.summaryFirstLine ? `${parts}\n   ${s.summaryFirstLine}` : parts;
  });
  return [
    `Resumable sessions for ${projectLabel} (most recent activity first):`,
    ...lines,
    '',
    'ACTION: Present this list to the user and ask which session to resume. ' +
    'On choice, call tim_session_resume with the chosen sessionId.',
  ].join('\n');
}

export function formatResumePayload(p: ResumePayload): string {
  const m = p.sessionMeta;
  const header = [
    `## Resumed Session ${p.sessionId}`,
    [
      m.project && `Project: ${m.project}`,
      m.date && `Started: ${m.date.slice(0, 16).replace('T', ' ')}`,
      m.toolHistory.length ? `Tools: ${m.toolHistory.join(' → ')}` : m.tool && `Tool: ${m.tool}`,
      `${m.exchangeCount} exchanges`,
      m.taskSummary && `Task: ${m.taskSummary}`,
    ].filter(Boolean).join(' · '),
  ].join('\n');

  const summarySection = [
    '## Session Summary',
    p.sessionSummary.trim() || '(no session summary yet)',
  ].join('\n');

  const batchSection = p.batchSummaries.length
    ? [
        `## Batch Summaries (${p.batchSummaries.length})`,
        ...p.batchSummaries.map(b =>
          `### Batch ${b.batchIndex} (seq ${b.seqFrom}–${b.seqTo})\n${b.text.trim()}`),
      ].join('\n\n')
    : '## Batch Summaries\n(none)';

  const exchangeSection = [
    `## Last ${p.recentExchanges.length} Exchanges (raw)`,
    ...p.recentExchanges.map(e => {
      const user = `[seq ${e.seq}] USER: ${e.userContent}`;
      return e.agentContent != null
        ? `${user}\n[seq ${e.seq}] AGENT: ${e.agentContent}`
        : user;
    }),
  ].join('\n\n');

  const warningLines = p.warnings.map(w => `⚠ ${w}`);

  return [
    header,
    summarySection,
    batchSection,
    exchangeSection,
    ...(warningLines.length ? [warningLines.join('\n')] : []),
    'ACTION: Context restored. Continue the conversation from here; ' +
    'all further exchanges append to this session automatically.',
  ].join('\n\n');
}
```

- [ ] **Step 4: Run formatter tests**

Run: `cd packages/tim-mcp && npx vitest run src/__tests__/resume-output.test.ts`
Expected: PASS

- [ ] **Step 5: Register schemas, tool defs, handlers in server.ts**

a) Near `TimSessionStartSchema` (~line 305) add:

```ts
const TimResumeListSchema = z.object({
  projectId: z.string().optional().describe('Project label, e.g. P0063; defaults to the bound project'),
  limit: z.number().int().min(1).max(25).optional().default(10),
});

const TimSessionResumeSchema = z.object({
  sessionId: z.string().describe('Canonical session id to resume (pick from tim_resume_list)'),
  rawCount: z.number().int().min(1).max(50).optional().default(10),
});
```

b) In the tool-definition array, directly after the `tim_session_start` entry (~line 611), add:

```ts
  {
    name: 'tim_resume_list',
    description:
      'List resumable sessions of the bound project (most recent activity first) with date, tool, ' +
      'task summary, and exchange count. Follow the ACTION line: present to the user, then call tim_session_resume.',
    schema: TimResumeListSchema,
  },
  {
    name: 'tim_session_resume',
    description:
      'Resume a previous session from any tool: injects session summary + all batch summaries + last N raw ' +
      'exchanges, and aliases the current harness session to the old session node so exchanges keep appending there.',
    schema: TimSessionResumeSchema,
  },
```

c) Add `'tim_session_resume'` to the `WRITE_TOOLS` set (~line 1448) and `'tim_resume_list'` to the `READ_TOOLS` set.

d) In the handler switch, after `case 'tim_session_start'` (~line 2637), add:

```ts
        case 'tim_resume_list': {
          const { projectId, limit } = TimResumeListSchema.parse(args);
          const label = projectId ?? getActiveProjectLabel();
          if (!label) {
            const guidance = await buildInboxFallbackGuidance(s);
            return {
              content: [{
                type: 'text',
                text: guidance ?? 'No bound project — pass projectId (e.g. P0063).',
              }],
            };
          }
          const list = await getSessions().listResumableSessions(label, limit);
          return { content: [{ type: 'text', text: formatResumeList(label, list) }] };
        }

        case 'tim_session_resume': {
          const { sessionId, rawCount } = TimSessionResumeSchema.parse(args);
          const cwd = isHttp ? undefined : process.cwd();
          const newHarnessId =
            process.env.TIM_SESSION_ID
            ?? (cwd ? findMarker(cwd, { walkUp: true })?.marker.session : undefined);
          const payload = await getSessions().resumeSession(sessionId, {
            newHarnessId,
            rawCount,
          });
          if (cwd) {
            try {
              rotateMarkerSession(cwd, payload.sessionId);
            } catch {
              // marker rotation is best-effort; resume payload is already durable
            }
          }
          // Best-effort summarizer sweep when the session has no batch summaries yet.
          if (payload.batchSummaries.length === 0 && cwd) {
            void maybeSpawnSummarizer(getStore(), cwd, { batchFull: true }).catch(() => {});
          }
          return { content: [{ type: 'text', text: formatResumePayload(payload) }] };
        }
```

e) Imports at the top of server.ts: add `formatResumeList, formatResumePayload` from `'./resume-output.js'`; ensure `rotateMarkerSession` is imported from `'tim-hooks'` (check the existing `findMarker` import block at ~line 36 and extend it). Verify `maybeSpawnSummarizer` is already imported (it is used at ~line 1440); if its signature differs from the call above, match the existing call site exactly.

Note on `isHttp` scoping: check how existing handlers access `isHttp` (see `case 'tim_session_start'`, ~line 2607) and mirror that exactly.

- [ ] **Step 6: Build + full tim-mcp tests**

Run: `cd /home/bbbee/projects/tim && npm run build && cd packages/tim-mcp && npx vitest run`
Expected: build clean, ALL PASS. If there's an existing server tool-listing test asserting tool counts/names, update it to include the two new tools.

- [ ] **Step 7: Commit**

```bash
git add packages/tim-mcp/src/resume-output.ts packages/tim-mcp/src/server.ts packages/tim-mcp/src/__tests__/resume-output.test.ts
git commit -m "feat(tim-mcp): tim_resume_list + tim_session_resume tools"
```

---

### Task 6: Skill `tim-resume`

**Files:**
- Create: `packages/tim-skills/skills/tim-resume/SKILL.md`

**Interfaces:**
- Consumes: MCP tools `tim_resume_list`, `tim_session_resume` (Task 5)
- Produces: harness-agnostic slash command / skill; distributed via the existing tim-skills install path (check `packages/tim-skills` for an install/copy script and register the new skill there if skills are enumerated explicitly — if the installer globs the `skills/` directory, nothing extra is needed).

- [ ] **Step 1: Write the skill**

Create `packages/tim-skills/skills/tim-resume/SKILL.md`:

```markdown
---
name: tim-resume
description: Resume a previous TIM session in this tool — list recent sessions of the bound project, let the user pick one, then load its context (summary + batch summaries + last raw exchanges) and continue appending to it. Use when the user says /tim-resume, "resume session", "Session fortsetzen", "weitermachen wo wir waren", or after hitting a session limit in another tool.
---

# TIM Resume

Continue a previous session — possibly started in a different tool — as if it never stopped.

## Steps

1. **List:** Call `tim_resume_list` (no args — uses the bound project).
   - If it responds with project-binding guidance, follow that first, then retry.
2. **Present:** Show the numbered list to the user (date, tool, task, summary line).
   Ask which session to resume. Do NOT auto-pick — unless the user already named
   a specific session or said "the last one" (then pick entry 1).
3. **Resume:** Call `tim_session_resume` with the chosen `sessionId`.
4. **Continue:** Treat the returned block as restored conversation context:
   - Do NOT paraphrase the whole payload back to the user.
   - Confirm in one line: "Resumed session from <date> — last state: <one-line gist>".
   - If the payload contains ⚠ warnings, mention them in one line.
   - Then continue the work from where the last exchanges left off.

## Rules

- All further exchanges append to the resumed session automatically (alias binding) —
  do not call `tim_session_start` afterwards.
- Resuming the current session after /clear is fine — same flow.
- If `tim_session_resume` errors with "legacy format", tell the user this session
  predates the resume feature and cannot be continued; offer to read its summary
  via `tim_read` instead.
```

- [ ] **Step 2: Check skill distribution**

Run: `grep -rn "skills/" packages/tim-skills/package.json packages/tim-skills/*.{ts,js,json} 2>/dev/null | head -20` and inspect how existing skills (e.g. `tim-handoff`) are installed. If skills are listed explicitly anywhere (installer manifest, index), add `tim-resume` there. If the installer globs the directory, no change.

- [ ] **Step 3: Commit**

```bash
git add packages/tim-skills
git commit -m "feat(tim-skills): tim-resume skill — cross-tool session resumption protocol"
```

---

### Task 7: Full regression, changelog, wrap-up

**Files:**
- Modify: `CHANGELOG.md` (new entry at top, follow existing format)

- [ ] **Step 1: Full workspace test run**

Run: `cd /home/bbbee/projects/tim && npm run build && npm test`
Expected: ALL packages green. Fix any failure caused by this feature (never by weakening existing tests).

- [ ] **Step 2: Changelog**

Add an entry at the top of `CHANGELOG.md` mirroring the existing entry style:

- `tim-store`: `resolveSessionAlias`, `SessionManager.resumeSession`, `listResumableSessions`, alias-transparent session APIs
- `tim-mcp`: new tools `tim_resume_list`, `tim_session_resume`
- `tim-skills`: new skill `tim-resume`

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: changelog for /tim-resume cross-tool session resumption"
```

- [ ] **Step 4: Write RESULT.md-style summary**

Summarize in the final message: commits, test counts, any deviations from this plan and why. Do NOT merge to master — leave `feature/tim-resume` for review.
