# Plan 10: Retrieval Usage-Feedback Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** TIM learns which of its own entries are actually useful: reads are recorded per session, entries that get *used* afterwards (linked, updated, or cited in a new write within the same session) are marked as referenced, and search ranking boosts frequently-referenced entries.

**Architecture:** A new device-local `entry_usage` table (deliberately NOT synced — usage is a per-device relevance signal, not shared knowledge; it never enters staging). Recording happens at the MCP layer where session identity is known; scoring and ranking live in the store. Ranking is a deterministic re-rank of an over-fetched FTS result: `score = ftsPosition − 2·log2(1 + referencedCount)`, ascending — an entry referenced 3 times climbs 4 positions.

**Tech Stack:** TypeScript monorepo, better-sqlite3, Vitest.

## Global Constraints

- **Never touch `~/.tim/tim.db`.** All tests use temp DB paths (`fs.mkdtempSync(path.join(os.tmpdir(), 'tim-test-'))`).
- **Migration numbering:** this plan adds migration **version 9**, assuming Plan 6 (`lww_device`, version 8) has been merged first. If `MIGRATIONS` in `packages/tim-store/src/schema.ts` still ends at version 7 when you start, use version 8 here instead and adjust nothing else — the SQL is independent of Plan 6.
- `entry_usage` rows are never written to `staging` and never exported — verify no export/sync code path picks up the new table.
- Env kill-switch: `TIM_USAGE_RANKING=0` disables the re-rank (recording still happens).
- Commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: `entry_usage` table + store recording methods

**Files:**
- Modify: `packages/tim-store/src/schema.ts` (append to `MIGRATIONS`)
- Modify: `packages/tim-store/src/store.ts` (new methods after `gcStaging`, ~line 1616)
- Test: `packages/tim-store/src/__tests__/entry-usage.test.ts`

**Interfaces:**
- Produces (all consumed by Tasks 2–3):
  - `TimStore.recordRead(entryIds: string[], sessionId: string | null): void`
  - `TimStore.markReferenced(entryIds: string[], sessionId: string | null): number` (rows flipped)
  - `TimStore.getSessionReadIds(sessionId: string): string[]`
  - `TimStore.getReferenceCounts(entryIds: string[]): Map<string, number>`

- [ ] **Step 1: Write the failing tests**

Create `packages/tim-store/src/__tests__/entry-usage.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TimStore } from '../store.js';

describe('entry_usage recording', () => {
  let dir: string;
  let store: TimStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-test-'));
    store = new TimStore(path.join(dir, 'test.db'));
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('records reads and marks them referenced within the same session', async () => {
    const a = await store.write('Entry A\nBody.', { tags: ['#x', '#y'] });
    const b = await store.write('Entry B\nBody.', { tags: ['#x', '#y'] });

    store.recordRead([a.id, b.id], 'session-1');
    expect(new Set(store.getSessionReadIds('session-1'))).toEqual(new Set([a.id, b.id]));

    // Only A gets used afterwards.
    const flipped = store.markReferenced([a.id], 'session-1');
    expect(flipped).toBe(1);

    const counts = store.getReferenceCounts([a.id, b.id]);
    expect(counts.get(a.id)).toBe(1);
    expect(counts.get(b.id)).toBeUndefined();
  });

  it('markReferenced is scoped to the session that read the entry', async () => {
    const a = await store.write('Entry A\nBody.', { tags: ['#x', '#y'] });
    store.recordRead([a.id], 'session-1');
    // A different session referencing without having read: no-op.
    expect(store.markReferenced([a.id], 'session-2')).toBe(0);
    expect(store.markReferenced([a.id], null)).toBe(0);
  });

  it('accumulates reference counts across sessions', async () => {
    const a = await store.write('Entry A\nBody.', { tags: ['#x', '#y'] });
    for (const sid of ['s1', 's2', 's3']) {
      store.recordRead([a.id], sid);
      store.markReferenced([a.id], sid);
    }
    expect(store.getReferenceCounts([a.id]).get(a.id)).toBe(3);
  });

  it('never stages usage rows for sync', async () => {
    const a = await store.write('Entry A\nBody.', { tags: ['#x', '#y'] });
    const cursor = await store.getStagingCursor();
    store.recordRead([a.id], 's1');
    store.markReferenced([a.id], 's1');
    expect(await store.getStagingCursor()).toBe(cursor);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/tim-store/src/__tests__/entry-usage.test.ts`
Expected: FAIL — `store.recordRead is not a function`.

- [ ] **Step 3: Add the migration**

Append to `MIGRATIONS` in `packages/tim-store/src/schema.ts` (version 9, or 8 per Global Constraints):

```typescript
  {
    version: 9,
    sql: `
      -- Device-local retrieval feedback. Deliberately NOT synced: usage is
      -- a per-device relevance signal, so no staging rows are ever written
      -- for it and it is excluded from export.
      CREATE TABLE IF NOT EXISTS entry_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entry_id TEXT NOT NULL,
        session_id TEXT,
        read_at TEXT NOT NULL,
        referenced INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_usage_entry ON entry_usage(entry_id, referenced);
      CREATE INDEX IF NOT EXISTS idx_usage_session ON entry_usage(session_id);
      CREATE INDEX IF NOT EXISTS idx_usage_read_at ON entry_usage(read_at);
    `
  },
```

If `packages/tim-store/src/__tests__/migrations.test.ts` asserts the final schema version, bump its expected value.

- [ ] **Step 4: Implement the store methods**

In `packages/tim-store/src/store.ts`, after `gcStaging` (~line 1616), add:

```typescript
  // ─── Retrieval usage feedback (device-local, never synced) ─────

  private usageGcDone = false;

  /** Record that these entries were surfaced to the agent (read or search hit). */
  recordRead(entryIds: string[], sessionId: string | null): void {
    if (entryIds.length === 0) return;
    // Opportunistic GC, once per process: usage older than 180 days is noise.
    if (!this.usageGcDone) {
      this.usageGcDone = true;
      const cutoff = new Date(Date.now() - 180 * 86400_000).toISOString();
      this.db.prepare('DELETE FROM entry_usage WHERE read_at < ?').run(cutoff);
    }
    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      'INSERT INTO entry_usage (entry_id, session_id, read_at) VALUES (?, ?, ?)',
    );
    this.db.transaction(() => {
      for (const id of new Set(entryIds)) stmt.run(id, sessionId, now);
    })();
  }

  /**
   * Mark previously-read entries as actually used (linked, updated, or
   * cited in a later write). Only flips rows of the same session — a
   * reference without a prior read in that session is not a retrieval win.
   */
  markReferenced(entryIds: string[], sessionId: string | null): number {
    if (entryIds.length === 0 || !sessionId) return 0;
    const unique = [...new Set(entryIds)];
    const placeholders = unique.map(() => '?').join(', ');
    const info = this.db.prepare(`
      UPDATE entry_usage SET referenced = 1
      WHERE session_id = ? AND referenced = 0 AND entry_id IN (${placeholders})
    `).run(sessionId, ...unique);
    return info.changes;
  }

  getSessionReadIds(sessionId: string): string[] {
    const rows = this.db.prepare(
      'SELECT DISTINCT entry_id FROM entry_usage WHERE session_id = ?',
    ).all(sessionId) as Array<{ entry_id: string }>;
    return rows.map(r => r.entry_id);
  }

  getReferenceCounts(entryIds: string[]): Map<string, number> {
    if (entryIds.length === 0) return new Map();
    const unique = [...new Set(entryIds)];
    const placeholders = unique.map(() => '?').join(', ');
    const rows = this.db.prepare(`
      SELECT entry_id, COUNT(*) AS c FROM entry_usage
      WHERE referenced = 1 AND entry_id IN (${placeholders})
      GROUP BY entry_id
    `).all(...unique) as Array<{ entry_id: string; c: number }>;
    return new Map(rows.map(r => [r.entry_id, r.c]));
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run build && npx vitest run packages/tim-store`
Expected: PASS, whole tim-store suite green (including migrations tests).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(tim-store): device-local entry_usage table with read/reference recording"
```

---

### Task 2: Usage-weighted search ranking

**Files:**
- Modify: `packages/tim-store/src/store.ts` — `search()` (~line 1295), new private `rankByUsage`
- Test: `packages/tim-store/src/__tests__/usage-ranking.test.ts`

**Interfaces:**
- Consumes: `getReferenceCounts` (Task 1).
- Behavior contract: `search()` still returns at most `topK` entries; with `TIM_USAGE_RANKING=0` or no usage data, order is identical to today's FTS order.

- [ ] **Step 1: Write the failing test**

Create `packages/tim-store/src/__tests__/usage-ranking.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TimStore } from '../store.js';

describe('usage-weighted search ranking', () => {
  let dir: string;
  let store: TimStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-test-'));
    store = new TimStore(path.join(dir, 'test.db'));
    delete process.env.TIM_USAGE_RANKING;
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.TIM_USAGE_RANKING;
  });

  /**
   * strongFts mentions the query term repeatedly (better bm25 rank);
   * weakFts mentions it once but is heavily referenced. The boost
   * (2·log2(1+3) = 4 positions) must lift weakFts above strongFts.
   */
  async function fixture() {
    const strongFts = await store.write(
      'Deployment checklist deployment steps\nDeployment deployment deployment.',
      { tags: ['#deploy', '#ops'] },
    );
    const weakFts = await store.write(
      'Server notes\nOne mention of deployment here.',
      { tags: ['#deploy', '#ops'] },
    );
    for (const sid of ['s1', 's2', 's3']) {
      store.recordRead([weakFts.id], sid);
      store.markReferenced([weakFts.id], sid);
    }
    return { strongFts, weakFts };
  }

  it('boosts frequently-referenced entries above better FTS matches', async () => {
    const { strongFts, weakFts } = await fixture();
    const results = await store.search({ query: 'deployment', topK: 5 });
    const ids = results.map(e => e.id);
    expect(ids.indexOf(weakFts.id)).toBeLessThan(ids.indexOf(strongFts.id));
  });

  it('TIM_USAGE_RANKING=0 restores pure FTS order', async () => {
    const { strongFts, weakFts } = await fixture();
    process.env.TIM_USAGE_RANKING = '0';
    const results = await store.search({ query: 'deployment', topK: 5 });
    const ids = results.map(e => e.id);
    expect(ids.indexOf(strongFts.id)).toBeLessThan(ids.indexOf(weakFts.id));
  });

  it('still honors topK', async () => {
    await fixture();
    const results = await store.search({ query: 'deployment', topK: 1 });
    expect(results.length).toBe(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/tim-store/src/__tests__/usage-ranking.test.ts`
Expected: The first test FAILS — pure FTS order puts strongFts first.

- [ ] **Step 3: Implement the re-rank**

In `packages/tim-store/src/store.ts`, add a private method next to `search()`:

```typescript
  /**
   * Deterministic usage boost on top of FTS order: an entry's score is its
   * FTS position minus 2·log2(1 + referencedCount); ascending. Referenced
   * 1× → +2 positions, 3× → +4, 7× → +6. No wall-clock, no randomness.
   */
  private rankByUsage(entries: Entry[], topK: number): Entry[] {
    if (process.env.TIM_USAGE_RANKING === '0' || entries.length <= 1) {
      return entries.slice(0, topK);
    }
    const counts = this.getReferenceCounts(entries.map(e => e.id));
    return entries
      .map((e, i) => ({ e, score: i - 2 * Math.log2(1 + (counts.get(e.id) ?? 0)) }))
      .sort((a, b) => a.score - b.score)
      .map(x => x.e)
      .slice(0, topK);
  }
```

In `search()` (~line 1295), over-fetch and re-rank. Change:

```typescript
    const fts = (await this.searchFts(options.query, topK))
      .filter(e => !TimStore.matchesSuppressed(patterns, e));
```

to:

```typescript
    // Over-fetch 3× so usage-boosted entries just below the cutoff can
    // climb into the topK window; rankByUsage slices back down.
    const fts = this.rankByUsage(
      (await this.searchFts(options.query, topK * 3))
        .filter(e => !TimStore.matchesSuppressed(patterns, e)),
      topK,
    );
```

The rest of `search()` (merged project hit, `[proj, ...fts].slice(0, topK)`) stays unchanged — `fts` is already capped at `topK`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && npx vitest run packages/tim-store`
Expected: PASS. If existing search tests assert an exact result order that changes only because of the 3× over-fetch (more candidates surviving the suppress filter), inspect before touching them: with zero usage data the order must be identical to before — a genuine order change is a bug in your re-rank, not a fixture problem.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(tim-store): usage-weighted search re-rank (TIM_USAGE_RANKING=0 disables)"
```

---

### Task 3: MCP wiring — record reads, detect references

**Files:**
- Modify: `packages/tim-mcp/src/server.ts` — helper near the top of the CallTool handler; tim_read case (~lines 1668, 1759, 1802), tim_search case (~line 1935), tim_update case, tim_link case, tim_write case
- Test: `packages/tim-mcp/src/__tests__/usage-wiring.test.ts` (integration via spawned server)

**Interfaces:**
- Consumes: `recordRead` / `markReferenced` / `getSessionReadIds` (Task 1); `resolveActiveSessionId` + `findMarker` from tim-core (already imported in server.ts, line 28).

- [ ] **Step 1: Write the failing integration test**

Create `packages/tim-mcp/src/__tests__/usage-wiring.test.ts`. Copy the `McpClient` class verbatim from `packages/tim-mcp/src/__tests__/read-search-write-ext.test.ts`, but extend its spawn env with a fixed session id so the server resolves one deterministically:

```typescript
    this.proc = spawn('node', [SERVER_PATH], {
      env: { ...process.env, TIM_DB_PATH: dbPath, TIM_SESSION_ID: 'usage-test-session' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
```

(`resolveActiveSessionId` in `packages/tim-core/src/session-cache.ts` reads the arg first, then the `TIM_SESSION_ID` env var — check the exact env var name in that file and use it; if the env fallback has a different name, adapt the test env, not the source.)

Then the tests — they observe usage through the DB file directly, which is legitimate here because the table is device-local by design:

```typescript
import Database from 'better-sqlite3';

describe('usage wiring through MCP handlers', () => {
  let dir: string;
  let dbPath: string;
  let client: McpClient;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-usage-'));
    dbPath = path.join(dir, 'test.db');
    client = new McpClient(dbPath);
    await client.initialize();
  });

  afterEach(() => {
    client.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function usageRows(): Array<{ entry_id: string; session_id: string; referenced: number }> {
    const db = new Database(dbPath, { readonly: true });
    try {
      return db.prepare('SELECT entry_id, session_id, referenced FROM entry_usage').all() as never;
    } finally {
      db.close();
    }
  }

  it('tim_read records a read; tim_update marks it referenced', async () => {
    const w = await client.callTool('tim_write', {
      content: 'Usage fact\nBody.', tags: ['#a', '#b'],
    });
    const entry = JSON.parse(w.result!.content[0].text);
    const entryId = entry.id ?? entry.entry?.id;

    await client.callTool('tim_read', { id: entryId });
    let rows = usageRows().filter(r => r.entry_id === entryId);
    expect(rows.length).toBe(1);
    expect(rows[0].referenced).toBe(0);

    await client.callTool('tim_update', { id: entryId, content: 'Usage fact\nEdited.' });
    rows = usageRows().filter(r => r.entry_id === entryId);
    expect(rows.some(r => r.referenced === 1)).toBe(true);
  });

  it('tim_search results are recorded as reads', async () => {
    const w = await client.callTool('tim_write', {
      content: 'Searchable usage fact\nBody.', tags: ['#a', '#b'],
    });
    const entry = JSON.parse(w.result!.content[0].text);
    const entryId = entry.id ?? entry.entry?.id;

    await client.callTool('tim_search', { query: 'searchable usage' });
    expect(usageRows().some(r => r.entry_id === entryId)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && npx vitest run packages/tim-mcp/src/__tests__/usage-wiring.test.ts`
Expected: FAIL — `entry_usage` has no rows (nothing records yet). If it fails earlier with "no such table", Task 1's migration isn't built — rebuild.

- [ ] **Step 3: Implement the wiring**

In `packages/tim-mcp/src/server.ts`, add one helper above the CallTool handler (module scope):

```typescript
/**
 * Session identity for usage recording — best-effort, null when the
 * process has no resolvable session (recording is then session-less and
 * can never be marked referenced, which is the correct neutral outcome).
 */
function usageSessionId(): string | null {
  try {
    return resolveActiveSessionId({
      markerSession: findMarker(process.cwd(), { walkUp: true })?.marker.session,
    }) ?? null;
  } catch {
    return null;
  }
}
```

Then wire the seven call sites — each is one or two lines, placed after the operation succeeds:

1. **tim_read, batch path** (~line 1667, before the return): `s.recordRead(entries.map(e => e.id), usageSessionId());`
2. **tim_read, project path** (~line 1757, after the entry is loaded and not null): `s.recordRead([entry.id], usageSessionId());`
3. **tim_read, id path** (~line 1800, after suppress/project checks pass): `s.recordRead([entry.id], usageSessionId());`
4. **tim_search** (after the final `results` list is assembled, before the return): `s.recordRead(results.map(e => e.id), usageSessionId());`
5. **tim_update** (after the successful `s.update(...)` call): `s.markReferenced([id], usageSessionId());`
6. **tim_link** (after the successful `s.link(...)` call): `s.markReferenced([sourceId, targetId], usageSessionId());`
7. **tim_write** (after `const entry = await s.write(...)` succeeds):

```typescript
          // Citing a previously-read entry's id in new content counts as
          // "used" — the strongest retrieval-win signal we can detect.
          const usageSid = usageSessionId();
          if (usageSid) {
            const readIds = s.getSessionReadIds(usageSid);
            const cited = readIds.filter(rid => opts.content.includes(rid));
            if (cited.length > 0) s.markReferenced(cited, usageSid);
          }
```

Variable names for `id` / `sourceId` / `targetId` must match what each case actually destructures from its parsed schema — read the case before editing it.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && npx vitest run packages/tim-mcp`
Expected: PASS, whole tim-mcp suite green.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(tim-mcp): record reads and reference signals for usage feedback"
```

---

### Task 4: Documentation

**Files:**
- Modify: `docs/tim-capabilities.md`, `CHANGELOG.md` `[Unreleased]`

- [ ] **Step 1: Document the feedback loop**

Document: what counts as a read (tim_read, tim_search hits), what counts as a reference (tim_update, tim_link, id cited in a later tim_write — same session only), the ranking formula (`position − 2·log2(1+referenced)`), the 180-day opportunistic GC, that `entry_usage` is device-local and never syncs, and the `TIM_USAGE_RANKING=0` kill-switch.

- [ ] **Step 2: Commit**

```bash
git add docs/tim-capabilities.md CHANGELOG.md
git commit -m "docs: retrieval usage-feedback loop"
```
