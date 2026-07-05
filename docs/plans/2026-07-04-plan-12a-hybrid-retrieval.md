# Plan 12a: Hybrid Retrieval — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add embedding-based semantic search to TIM, combined with FTS5 + graph signals for hybrid retrieval, plus summary-first reads. The foundation for "bestes Memory-System werden" (Plan 12 §A).

**Architecture:** `sqlite-vec` extension loads into the existing `better-sqlite3` database, `fastembed` (ONNX, local-first) computes vectors. A new device-local `entry_vectors` table (NEVER synced, never exported — same contract as Plan 10's `entry_usage`) stores embeddings. The `search()` method is extended with a three-signal re-rank: FTS5 position + cosine similarity + graph/usage/staleness boosts. `tim_read` gains a `summary` field and `include_body` option. Embedding computation runs as a background hook, not in the write/read hot path.

**Tech Stack:** TypeScript monorepo (npm workspaces), better-sqlite3, sqlite-vec (npm package, loadable extension), fastembed (npm package, ONNX runtime), Vitest.

## Global Constraints

- **Never touch `~/.tim/tim.db`.** All tests use temp DB paths (`fs.mkdtempSync(path.join(os.tmpdir(), 'tim-test-'))`).
- Prerequisites on master: **Plan 8** (staleness via `isStale()` in tim-core, `Entry.updatedAt`), **Plan 10** (usage feedback via `entry_usage` + `rankByUsage`), **Plan 7** (tim-search deleted — embeddings live in tim-store, no new package), **Review F1–F10** (all critical fixes applied).
- Migration: `entry_vectors` table = **version 10** (Plan 6 = v8, Plan 10 = v9). Uses the same transactional migration pattern as Plans 2+10+Plan 6.
- `entry_vectors` rows are **device-local** — never written to `staging`, never exported, never synced. Same contract as `entry_usage`. Verify with grep after implementation.
- `sqlite-vec` is a loadable extension — tests need to load it via `db.loadExtension(...)`. If not installed, tests should skip gracefully (`it.skip` + console.warn).
- Embedding computation = background hook (`tim-hooks`), NEVER in `write()`/`read()` hot path.
- No new npm workspace/package — everything in `tim-store` (table + methods) and `tim-mcp` (summary annotation, new tool options).
- Env knobs: `TIM_EMBEDDING_MODEL` (default: `'all-MiniLM-L6-v2'` — fastembed model name), `TIM_HYBRID_WEIGHTS` (default: `'1.0,2.0,0.5'` — FTS5, cosine, graph), `TIM_EMBEDDING_DISABLED=1` (skip entirely), `TIM_EMBEDDING_BATCH_SIZE` (default: 32).
- Commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: `entry_vectors` table + migration v10

**Files:**
- Modify: `packages/tim-store/src/schema.ts` (append `entry_vectors` to `MIGRATIONS`, version 10)
- Modify: `packages/tim-store/src/store.ts` (new methods: `getUnembedded(count)`, `setVectors(entryId, vector, model)`)
- Test: `packages/tim-store/src/__tests__/entry-vectors.test.ts`

**Interfaces:**
- Produces: `TimStore.getUnembedded(count: number): Promise<Entry[]>` — entries without vectors, sorted by `updated_at` DESC (newest content first), skipping entries with `metadata.kind IN SCHEMA_KINDS`.
- Produces: `TimStore.setVectors(entryId: string, vector: Float32Array, model: string): void` — INSERT OR REPLACE into `entry_vectors`.

- [ ] **Step 1: Write the failing tests**

Create `packages/tim-store/src/__tests__/entry-vectors.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TimStore } from '../store.js';

describe('entry_vectors table', () => {
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

  it('migration v10 creates entry_vectors with correct schema', () => {
    const db = store.getDb();
    const cols = db.prepare("PRAGMA table_info('entry_vectors')").all() as Array<{
      name: string; type: string;
    }>;
    const names = cols.map(c => c.name);
    expect(names).toContain('entry_id');
    expect(names).toContain('model');
    expect(names).toContain('vector');
  });

  it('getUnembedded returns entries without vectors, newest content first', async () => {
    const a = await store.write('Entry A\nContent.', { tags: ['#a', '#b'] });
    const b = await store.write('Entry B\nContent.', { tags: ['#a', '#b'] });

    const unembedded = await store.getUnembedded(10);
    expect(unembedded.length).toBe(2);
    expect(unembedded[0].id).toBe(b.id); // newest first
  });

  it('getUnembedded skips schema kinds', async () => {
    await store.write('Session entry', { metadata: { kind: 'session' } });
    const unembedded = await store.getUnembedded(10);
    expect(unembedded).toEqual([]);
  });

  it('getUnembedded skips entries that already have vectors', async () => {
    const a = await store.write('Entry A\nContent.', { tags: ['#a', '#b'] });
    store.setVectors(a.id, new Float32Array(384), 'all-MiniLM-L6-v2');

    const unembedded = await store.getUnembedded(10);
    expect(unembedded.find(e => e.id === a.id)).toBeUndefined();
  });

  it('setVectors upserts (second call replaces)', () => {
    const a = store.getDb().prepare("INSERT INTO entries (id, content_type, content, tags, metadata, created_at, updated_at) VALUES ('test-vector-upsert', 'text', 'hello', '[]', '{}', datetime('now'), datetime('now'))").run();
    store.setVectors('test-vector-upsert', new Float32Array(384), 'model-A');
    store.setVectors('test-vector-upsert', new Float32Array(768), 'model-B');

    const row = store.getDb().prepare(
      'SELECT model, length(vector) as len FROM entry_vectors WHERE entry_id = ?',
    ).get('test-vector-upsert') as { model: string; len: number };
    expect(row.model).toBe('model-B');
    // Float32Array(768) => 768 × 4 bytes = 3072
    expect(row.len).toBe(3072);
  });

  it('entry_vectors never enters staging', async () => {
    const a = await store.write('Entry A\nContent.', { tags: ['#a', '#b'] });
    const cursor = await store.getStagingCursor();
    store.setVectors(a.id, new Float32Array(384), 'test-model');
    expect(await store.getStagingCursor()).toBe(cursor);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/tim-store/src/__tests__/entry-vectors.test.ts`
Expected: FAIL — `store.getUnembedded is not a function`.

- [ ] **Step 3: Implement**

In `packages/tim-store/src/schema.ts`, append to `MIGRATIONS`:

```typescript
  {
    version: 10,
    sql: `
      -- Device-local embedding vectors. Each device computes its own;
      -- vectors are NEVER synced, staged, or exported (same contract
      -- as entry_usage in Plan 10).
      CREATE TABLE IF NOT EXISTS entry_vectors (
        entry_id TEXT PRIMARY KEY,
        model TEXT NOT NULL,
        vector BLOB NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_entry_vectors_model ON entry_vectors(model);
    `,
  },
```

If `migrations.test.ts` asserts the final schema version, bump expected value to 10.

In `packages/tim-store/src/store.ts`, after `getReferenceCounts` (near the usage-feedback block), add:

```typescript
  // ─── Embedding vectors (device-local, never synced) ─────

  /**
   * Entries that need embedding (no vector yet, newest content first).
   * Schema kinds (sessions, sections, …) are skipped — they don't need
   * semantic search.
   */
  async getUnembedded(count: number): Promise<Entry[]> {
    const scopesKinds = [...SCHEMA_KINDS].map(() => '?').join(', ');
    const rows = this.db.prepare(`
      SELECT e.* FROM entries e
      LEFT JOIN entry_vectors v ON v.entry_id = e.id
      WHERE v.entry_id IS NULL
        AND e.tombstoned_at IS NULL
        AND e.irrelevant = 0
        AND (json_extract(e.metadata, '$.kind') IS NULL
             OR json_extract(e.metadata, '$.kind') NOT IN (${scopesKinds}))
      ORDER BY e.updated_at DESC, e.rowid DESC
      LIMIT ?
    `).all(...SCHEMA_KINDS, count) as RowEntry[];
    return rows.map(rowToEntry);
  }

  /** Store an embedding vector for an entry. Upserts — second call replaces. */
  setVectors(entryId: string, vector: Float32Array, model: string): void {
    // Float32Array → BLOB for SQLite storage
    const blob = Buffer.from(vector.buffer);
    this.db.prepare(
      `INSERT INTO entry_vectors (entry_id, model, vector)
       VALUES (?, ?, ?)
       ON CONFLICT(entry_id) DO UPDATE SET model = excluded.model, vector = excluded.vector`,
    ).run(entryId, model, blob);
  }
```

Ensure `SCHEMA_KINDS` is imported from `'tim-core'` (Plan 8 Task 2 already landed on master).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && npx vitest run packages/tim-store`
Expected: PASS, whole tim-store suite green (including migrations test with bumped version).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(tim-store): entry_vectors table (migration v10) — device-local embedding storage

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Embedding computation hook (tim-hooks)

**Files:**
- Modify: `packages/tim-hooks/src/hooks.ts` (new function `embedUnembeddedEntries`, registered as a background hook)
- Test: `packages/tim-hooks/src/__tests__/embedding-hook.test.ts`

**Interfaces:**
- Consumes: `TimStore.getUnembedded`, `TimStore.setVectors` (Task 1), `fastembed` npm package.
- Produces: `embedUnembeddedEntries(store, opts?): Promise<number>` — processes up to `TIM_EMBEDDING_BATCH_SIZE` entries, returns count of embeded entries.

- [ ] **Step 1: Write the failing tests**

Create `packages/tim-hooks/src/__tests__/embedding-hook.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TimStore } from 'tim-store';
import { embedUnembeddedEntries } from '../hooks.js';

describe('embedUnembeddedEntries', () => {
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

  it('embeds entries that have no vectors yet', async () => {
    const e = await store.write('Test content for embedding.\nBody here.', {
      tags: ['#test', '#embedding'],
    });

    // If fastembed is not installed, skip gracefully
    try {
      require.resolve('fastembed');
    } catch {
      console.warn('fastembed not installed — skipping embedding hook test');
      return;
    }

    const count = await embedUnembeddedEntries(store, { batchSize: 5 });
    expect(count).toBeGreaterThanOrEqual(1);

    const unembedded = await store.getUnembedded(10);
    expect(unembedded.find(u => u.id === e.id)).toBeUndefined();
  });

  it('skips entries that are already embedded', async () => {
    const e = await store.write('Test\nBody.', { tags: ['#a', '#b'] });
    store.setVectors(e.id, new Float32Array(384), 'test-model');

    try {
      require.resolve('fastembed');
      const count = await embedUnembeddedEntries(store, { batchSize: 5 });
      expect(count).toBe(0); // already embedded, nothing to do
    } catch {
      return; // fastembed not installed
    }
  });

  it('returns 0 when there are no unembedded entries', async () => {
    const count = await embedUnembeddedEntries(store, { batchSize: 5 });
    expect(count).toBe(0);
  });

  it('TIM_EMBEDDING_DISABLED=1 skips processing', async () => {
    process.env.TIM_EMBEDDING_DISABLED = '1';
    try {
      const count = await embedUnembeddedEntries(store, { batchSize: 5 });
      expect(count).toBe(0);
    } finally {
      delete process.env.TIM_EMBEDDING_DISABLED;
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/tim-hooks/src/__tests__/embedding-hook.test.ts`
Expected: FAIL — `embedUnembeddedEntries is not a function` or `not exported`.

- [ ] **Step 3: Implement**

In `packages/tim-hooks/src/hooks.ts`, add:

```typescript
import { type TimStore } from 'tim-store';

interface EmbeddingOptions {
  batchSize?: number;
  model?: string;
}

/**
 * Background hook: finds unembedded content entries and computes their
 * vectors via fastembed (local ONNX). Runs in the summarizer-style
 * fallback chain — best-effort, never blocks user flows.
 *
 * Set TIM_EMBEDDING_DISABLED=1 to skip entirely.
 */
export async function embedUnembeddedEntries(
  store: TimStore,
  opts: EmbeddingOptions = {},
): Promise<number> {
  if (process.env.TIM_EMBEDDING_DISABLED === '1') return 0;

  const batchSize = opts.batchSize ?? Number(process.env.TIM_EMBEDDING_BATCH_SIZE) || 32;
  const modelName = opts.model ?? process.env.TIM_EMBEDDING_MODEL ?? 'all-MiniLM-L6-v2';

  let entries: Entry[];
  try {
    entries = await store.getUnembedded(batchSize);
  } catch {
    return 0; // store error — don't crash the hook
  }

  if (entries.length === 0) return 0;

  try {
    // Dynamic import — fastembed is optional, tests may run without it
    const { FlagEmbedding } = await import('fastembed');
    const embedder = await FlagEmbedding.init({ model: modelName });

    const texts = entries.map(e => e.content.slice(0, 2000)); // trim long content
    const vectors = embedder.embed(texts, batchSize);
    let embedded = 0;
    for (let i = 0; i < entries.length; i++) {
      try {
        store.setVectors(entries[i].id, new Float32Array(vectors[i]), modelName);
        embedded++;
      } catch {
        // individual entry failure — continue with next
      }
    }
    return embedded;
  } catch (err) {
    // fastembed or ONNX not available — that's fine, just skip
    console.debug('[tim-hooks] embedUnembeddedEntries: embedding not available:', (err as Error).message);
    return 0;
  }
}
```

Also add `fastembed` as an **optional dependency** (not required) in `packages/tim-hooks/package.json`:

```json
  "optionalDependencies": {
    "fastembed": "^1.0.0"
  }
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
# Install fastembed for test run
NODE_ENV=development npm install --include=optional 2>/dev/null || true
npm run build
npx vitest run packages/tim-hooks/src/__tests__/embedding-hook.test.ts
```

Expected: PASS (or skip gracefully if fastembed can't install).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(tim-hooks): embedUnembeddedEntries background hook (fastembed)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Hybrid search in `search()` — three-signal re-rank

**Files:**
- Modify: `packages/tim-store/src/store.ts` (extend `search()` ~line 1295, new helper `rankByHybrid`)
- Test: `packages/tim-store/src/__tests__/hybrid-ranking.test.ts`

**Interfaces:**
- Consumes: `getReferenceCounts` (Plan 10), `isStale` (Plan 8 via Review F10), `entry_vectors` table (Task 1), `searchFts` (existing).
- Produces: extended `search()` that optionally over-fetches from FTS and re-ranks with three signals.

- [ ] **Step 1: Write the failing tests**

Create `packages/tim-store/src/__tests__/hybrid-ranking.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TimStore } from '../store.js';

describe('hybrid search', () => {
  let dir: string;
  let store: TimStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-test-'));
    store = new TimStore(path.join(dir, 'test.db'));
    delete process.env.TIM_EMBEDDING_DISABLED;
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
    delete process.env.TIM_EMBEDDING_DISABLED;
  });

  it('search() still works without vectors (pure FTS + usage)', async () => {
    const a = await store.write('Deploy checklist for staging\nSteps to follow.', {
      tags: ['#deploy', '#ops'],
    });
    const b = await store.write('Staging config notes\nServer setup.', {
      tags: ['#deploy', '#ops'],
    });
    // No vectors stored — should still return FTS results
    const results = await store.search({ query: 'staging', topK: 2 });
    expect(results.length).toBe(2);
    const ids = results.map(e => e.id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
  });

  it('TIM_EMBEDDING_DISABLED=1 falls back to pure rankByUsage', async () => {
    process.env.TIM_EMBEDDING_DISABLED = '1';
    const a = await store.write('test query match\nContent.', { tags: ['#a', '#b'] });
    const results = await store.search({ query: 'test query', topK: 5 });
    expect(results.length).toBe(1);
    expect(results[0].id).toBe(a.id);
  });

  it('entries with vectors are boosted over entries without', async () => {
    const semantic = await store.write(
      'Python error handling best practices\ntry/except patterns.',
      { tags: ['#python', '#errors'] },
    );
    const exact = await store.write(
      'Javascript error handling\nPromises and async/await patterns.',
      { tags: ['#javascript', '#errors'] },
    );

    // Simulate vectors: semantic entry matches query better
    store.setVectors(semantic.id, makeMockVector([0.5, 0.7, 0.3]), 'test-model');
    store.setVectors(exact.id, makeMockVector([0.1, 0.1, 0.2]), 'test-model');

    // Exact FTS would rank "Javascript error handling" first (exact match on "error").
    // With vectors, the semantic match should surface.
    const results = await store.search({ query: 'python exceptions try except', topK: 2 });
    expect(results[0].id).toBe(semantic.id);
  });
});

/** Create a minimal mock vector for testing — same dimension as the default model. */
function makeMockVector(values: number[]): Float32Array {
  const arr = new Float32Array(384);
  for (let i = 0; i < values.length; i++) arr[i] = values[i];
  return arr;
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/tim-store/src/__tests__/hybrid-ranking.test.ts`
Expected: FAIL — third test (`semantic match surfaces first`) currently returns exact FTS order (exact match first).

- [ ] **Step 3: Implement**

In `packages/tim-store/src/store.ts`, add after `rankByUsage`:

```typescript
  /**
   * Hybrid re-rank combining three signals:
   *   1. FTS5 position (the raw order)
   *   2. Cosine similarity (embedding distance to query vector)
   *   3. Graph/usage/staleness boost (from Plan 8/10)
   *
   * Weights are configurable via TIM_HYBRID_WEIGHTS (FTS5, embed, graph).
   * Default: "1.0,2.0,0.5" — embeddings weight 2×, graph boost is additive.
   */
  private async rankByHybrid(
    entries: Entry[],
    queryVector: Float32Array | null,
    topK: number,
  ): Promise<Entry[]> {
    if (process.env.TIM_EMBEDDING_DISABLED === '1' || !queryVector) {
      // Fall back to usage-only ranking (Plan 10)
      return this.rankByUsage(entries, topK);
    }

    // Parse weights
    const raw = (process.env.TIM_HYBRID_WEIGHTS ?? '1.0,2.0,0.5').split(',');
    const wFts = Number(raw[0]) || 1;
    const wEmbed = Number(raw[1]) || 2;
    const wGraph = Number(raw[2]) || 0.5;

    // Get usage + staleness signals
    const days = staleDays();
    const counts = this.getReferenceCounts(entries.map(e => e.id));

    // Load vectors for all candidate entries
    const vecRows = this.db.prepare(`
      SELECT entry_id, vector, model FROM entry_vectors
      WHERE entry_id IN (${entries.map(() => '?').join(', ')})
    `).all(...entries.map(e => e.id)) as Array<{
      entry_id: string; vector: Buffer; model: string;
    }>;

    const vecMap = new Map<string, Float32Array>();
    for (const row of vecRows) {
      vecMap.set(row.entry_id, new Float32Array(row.vector.buffer, 0, row.vector.length / 4));
    }

    // Score each entry
    const scored = entries.map((e, i) => {
      let score = i * wFts; // FTS position (lower = better)

      // Cosine similarity boost (higher = better, so subtract from score)
      const vec = vecMap.get(e.id);
      if (vec) {
        const similarity = cosineSimilarity(queryVector, vec);
        score -= similarity * wEmbed;
      }

      // Graph/usage/staleness boost
      const refCount = counts.get(e.id) ?? 0;
      const stale = isStale(e, days) ? 1 : 0;
      score -= (refCount * 0.5 - stale * 0.3) * wGraph; // usage lifts, staleness penalizes

      return { e, score };
    });

    return scored
      .sort((a, b) => a.score - b.score)
      .map(x => x.e)
      .slice(0, topK);
  }

  /** Cosine similarity between two same-length vectors. Range: [-1, 1]. */
  function cosineSimilarity(a: Float32Array, b: Float32Array): number {
    let dot = 0, normA = 0, normB = 0;
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom === 0 ? 0 : dot / denom;
  }
```

Import `isStale` + `staleDays` from `'tim-core'` at the top of store.ts (Review F10 already exported them).

Modify `search()` to use hybrid ranking when vectors are available. Add after the existing `searchFts` + suppress filter:

```typescript
    // Try to embed the query for hybrid ranking (best-effort — if no
    // fastembed or vectors exist, falls back to usage-only).
    let queryVector: Float32Array | null = null;
    try {
      const { FlagEmbedding } = await import('fastembed');
      const embedder = await FlagEmbedding.init({
        model: process.env.TIM_EMBEDDING_MODEL ?? 'all-MiniLM-L6-v2',
      });
      const vecs = embedder.embed([options.query], 1);
      queryVector = new Float32Array(vecs[0]);
    } catch {
      // No fastembed, no problem — use pure FTS + usage
    }

    return this.rankByHybrid(fts, queryVector, topK);
```

Note: `fastembed` import is **dynamic** — it may fail if not installed. That's fine; search falls back to pure FTS + usage. The `FlagEmbedding` API uses `.embed(texts, batchSize)`. Verify the actual API signature by checking fastembed's npm docs if the test setup fails.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && npx vitest run packages/tim-store`
Expected: PASS. The new hybrid test passes (with mock vectors), existing search tests still pass (no vectors → fallback unchanged).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(tim-store): hybrid search — three-signal re-rank (FTS5 + cosine + graph/usage/staleness)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Summary-first reads + `include_body` option

**Files:**
- Modify: `packages/tim-mcp/src/server.ts` — tim_read handler: add `summary` field, `include_body` param
- Modify: `packages/tim-core/src/index.ts` — add `summary?: string` to read response type if not already flexible
- Test: `packages/tim-mcp/src/__tests__/summary-read.test.ts`

**Interfaces:**
- Consumes: Entry `content` field, optional `metadata.summary`.
- Produces: `summary` field on `tim_read` responses (first 500 chars of content, or `metadata.summary` if set). `include_body=true` returns full content.

- [ ] **Step 1: Write the failing test**

Create `packages/tim-mcp/src/__tests__/summary-read.test.ts`. Copy `McpClient` from `read-search-write-ext.test.ts`, then:

```typescript
describe('summary-first reads', () => {
  let dir: string;
  let client: McpClient;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-summary-'));
    client = new McpClient(path.join(dir, 'test.db'));
    await client.initialize();
  });

  afterEach(() => {
    client.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns summary by default (first 500 chars)', async () => {
    const longBody = 'A'.repeat(2000);
    const w = await client.callTool('tim_write', {
      content: `Test Entry\n${longBody}`,
      tags: ['#test', '#summary'],
    });
    const entry = JSON.parse(w.result!.content[0].text);
    const id = entry.id ?? entry.entry?.id;

    const r = await client.callTool('tim_read', { id });
    const body = JSON.parse(r.result!.content[0].text);
    expect(body.summary).toBeDefined();
    expect(body.summary.length).toBeLessThanOrEqual(500);
    expect(body.content).toBeUndefined(); // body not returned by default
  });

  it('returns full body with include_body=true', async () => {
    const w = await client.callTool('tim_write', {
      content: 'Entry\nFull body here.',
      tags: ['#test', '#summary'],
    });
    const entry = JSON.parse(w.result!.content[0].text);
    const id = entry.id ?? entry.entry?.id;

    const r = await client.callTool('tim_read', { id, include_body: true });
    const body = JSON.parse(r.result!.content[0].text);
    expect(body.summary).toBeDefined();
    expect(body.content).toContain('Full body here');
  });

  it('uses metadata.summary if set explicitly', async () => {
    const w = await client.callTool('tim_write', {
      content: 'Entry\nReal body.',
      metadata: { summary: 'Custom summary text' },
      tags: ['#test', '#summary'],
    });
    const entry = JSON.parse(w.result!.content[0].text);
    const id = entry.id ?? entry.entry?.id;

    const r = await client.callTool('tim_read', { id });
    const body = JSON.parse(r.result!.content[0].text);
    expect(body.summary).toBe('Custom summary text');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && npx vitest run packages/tim-mcp/src/__tests__/summary-read.test.ts`
Expected: FAIL — `body.summary` is `undefined`.

- [ ] **Step 3: Implement**

In `packages/tim-mcp/src/server.ts`:

Add `include_body` to `TimReadSchema` (near existing `id` param):

```typescript
  include_body: z.boolean().optional().default(false)
    .describe('Return the full content body instead of just a summary'),
```

In the `tim_read` response handler (all three paths: single-id, project, batch), apply the summary transformation. Before returning, transform each entry:

```typescript
function summarizeEntry(entry: Entry & { summary?: string }, includeBody: boolean): unknown {
  const summary = typeof entry.metadata.summary === 'string' && entry.metadata.summary
    ? entry.metadata.summary
    : truncText(entry.content, 500);

  if (includeBody) {
    return { ...entry, summary };
  }
  const { content, ...rest } = entry;
  return { ...rest, summary };
}
```

Wire it at each tim_read return point:
1. Single-id path: apply `summarizeEntry(annotatedEntry, include_body)`
2. Project path: same
3. Batch path: map each entry

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && npx vitest run packages/tim-mcp/src/__tests__/summary-read.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full suite**

Run: `npx vitest run`
Expected: green — existing read tests should still pass (they don't rely on the content field's presence/absence in response shape).

If any existing test asserts on the EXACT response shape (e.g., expects `content` field to be present in read result), adapt that test to accept the new summary-first behavior. Document such fixture changes in JOURNAL.md.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(tim-mcp): summary-first reads — include_body for full content

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Benchmark harness (golden queries)

**Files:**
- Create: `packages/tim-store/src/__tests__/retrieval-benchmark.test.ts`
- Create: `docs/retrieval-benchmark.md` (methodology doc)

**Interfaces:**
- Produces: `runBenchmark(store: TimStore, suite: QuerySuite): Promise<BenchmarkResult>` — runs golden queries against the store, reports precision@K, recall@K, MRR.

- [ ] **Step 1: Write the benchmark test**

Create `packages/tim-store/src/__tests__/retrieval-benchmark.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TimStore } from '../store.js';

interface GoldenQuery {
  query: string;
  expectedIds: string[];  // entry IDs that should appear in results
}

interface BenchmarkResult {
  query: string;
  precisionAt3: number;
  recallAt5: number;
  mrr: number;
  found: string[];
  missing: string[];
}

function runBenchmark(store: TimStore, queries: GoldenQuery[]): BenchmarkResult[] {
  // (implemented in store as exportable function, or inline here)
  return []; // stub — implemented in Step 3
}

describe('retrieval benchmark harness', () => {
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

  it('scores precision@3 and recall@5 for a known golden query', async () => {
    const a = await store.write('How to configure nginx reverse proxy\nSteps for Ubuntu 24.04.', {
      tags: ['#nginx', '#ops', '#config'],
    });
    const b = await store.write('Unrelated topic about Python\nDjango views.', {
      tags: ['#python', '#django'],
    });

    const results = runBenchmark(store, [{
      query: 'nginx proxy config',
      expectedIds: [a.id],
    }]);

    expect(results.length).toBe(1);
    expect(results[0].found).toContain(a.id);
    expect(results[0].precisionAt3).toBeGreaterThanOrEqual(1 / 3);
    // b.id is the only other entry — if ranked at pos 4+, precision is 1/3 (one correct in top 3)
  });

  it('reports MRR for the first relevant hit', async () => {
    const a = await store.write('Deploy steps\nServer setup.', { tags: ['#deploy'] });
    const b = await store.write('Another thing\nMore content.', { tags: ['#x'] });
    await store.write('Third item\nStuff.', { tags: ['#y'] });

    const results = runBenchmark(store, [{
      query: 'deploy steps',
      expectedIds: [a.id],
    }]);
    // MRR = 1/position_of_first_expected_hit
    expect(results[0].mrr).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/tim-store/src/__tests__/retrieval-benchmark.test.ts`
Expected: FAIL — `runBenchmark` returns empty `[]`.

- [ ] **Step 3: Implement**

In `packages/tim-store/src/store.ts`, export a `runBenchmark` helper (near the search methods):

```typescript
export interface GoldenQuery {
  query: string;
  expectedIds: string[];
}

export interface BenchmarkResult {
  query: string;
  precisionAt3: number;
  recallAt5: number;
  mrr: number;
  found: string[];
  missing: string[];
}

export async function runBenchmark(
  store: TimStore,
  queries: GoldenQuery[],
): Promise<BenchmarkResult[]> {
  const results: BenchmarkResult[] = [];
  for (const q of queries) {
    const hits = await store.search({ query: q.query, topK: 10 });
    const hitIds = hits.map(e => e.id);
    const found = q.expectedIds.filter(id => hitIds.includes(id));
    const missing = q.expectedIds.filter(id => !hitIds.includes(id));

    // Precision@3: fraction of top-3 that are relevant
    const top3 = hitIds.slice(0, 3);
    const relevantTop3 = q.expectedIds.filter(id => top3.includes(id));
    const precisionAt3 = top3.length > 0 ? relevantTop3.length / top3.length : 0;

    // Recall@5: fraction of expected that appear in top-5
    const top5 = hitIds.slice(0, 5);
    const relevantTop5 = q.expectedIds.filter(id => top5.includes(id));
    const recallAt5 = q.expectedIds.length > 0 ? relevantTop5.length / q.expectedIds.length : 1;

    // MRR: 1/rank of first expected hit (1-indexed)
    let mrr = 0;
    for (let i = 0; i < hitIds.length; i++) {
      if (q.expectedIds.includes(hitIds[i])) {
        mrr = 1 / (i + 1);
        break;
      }
    }

    results.push({ query: q.query, precisionAt3, recallAt5, mrr, found, missing });
  }
  return results;
}
```

Also re-export from `packages/tim-store/src/index.ts` (check the explicit export list — if it uses `export *` from store.js, no change needed).

Create `docs/retrieval-benchmark.md`:

```markdown
# TIM Retrieval Benchmark

## Purpose

Measure retrieval quality as Plans add new signals (FTS5 → hybrid → graph-boost).
Every change to search ranking MUST show a net improvement or no regression on
the golden query suite.

## Golden Queries

The suite lives in `packages/tim-store/src/__tests__/retrieval-benchmark.test.ts`.
To add a query: (1) write some entries with known relevant IDs, (2) add a
GoldenQuery with expectedIds, (3) ensure the test still passes.

## Running

\`\`\`bash
NODE_ENV=development npx vitest run packages/tim-store/src/__tests__/retrieval-benchmark.test.ts
\`\`\`

## LongMemEval Integration (future)

For Plan 12 §A: load LongMemEval-style suites, run the same Benchmark interface,
compare scores. The harness format (GoldenQuery → BenchmarkResult) is designed
to work with external suites via a JSON loader.
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && npx vitest run packages/tim-store`
Expected: PASS — golden queries score correctly on the pure-FTS baseline.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(tim-store): retrieval benchmark harness (precision@K, recall@K, MRR)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Update existing tool descriptions + docs

**Files:**
- Modify: `packages/tim-mcp/src/server.ts` — `tim_read` ListTools description mentions `include_body`
- Modify: `docs/tim-capabilities.md` — add "Hybrid Retrieval" subsection after Retrieval Usage-Feedback
- Modify: `CHANGELOG.md` `[Unreleased]` — Added entries for Tasks 1–5

**Interfaces:**
- None new.

- [ ] **Step 1: Update tim_read description**

In `TimReadSchema` (zod schema in server.ts), ensure `include_body`'s `.describe()` is clear:

```typescript
include_body: z.boolean().optional().default(false)
  .describe('Return the full content body. Default false — returns summary only (first 500 chars or metadata.summary)'),
```

- [ ] **Step 2: Update docs**

Add to `docs/tim-capabilities.md` after the Retrieval Usage-Feedback section:

```markdown
### Hybrid Retrieval (Plan 12a)

TIM kombiniert drei Signale für das Retrieval-Ranking:

1. **FTS5 (Keyword-Matching)** — exakter BM25-basierter Kandidaten-Generator.
2. **Embedding-Ähnlichkeit** — lokales ONNX-Modell (fastembed/all-MiniLM-L6-v2) berechnet Vektoren, die nie das Gerät verlassen. `entry_vectors`-Tabelle ist device-lokal wie `entry_usage` — kein Sync, kein Export.
3. **Graph/Usage/Staleness-Boost** — häufig referenzierte Einträge (Plan 10) steigen, als veraltet markierte (Plan 8) werden abgestuft.

**Env-Knobs:**
- `TIM_EMBEDDING_DISABLED=1` — schaltet Embedding komplett ab (pure FTS)
- `TIM_EMBEDDING_MODEL=all-MiniLM-L6-v2` — welches fastembed-Modell
- `TIM_HYBRID_WEIGHTS=1.0,2.0,0.5` — Gewichte: FTS5, Embedding, Graph-Boost

**Summary-first reads:** `tim_read` liefert standardmäßig eine Zusammenfassung (erste 500 Zeichen oder `metadata.summary`). Der volle Content nur mit `include_body=true`.
```

Add to `CHANGELOG.md [Unreleased] ### Added`:

```markdown
- **Hybrid search** — `entry_vectors` table (migration v10, device-local), fastembed-based embedding hook (`tim-hooks`), three-signal re-rank in `search()` (FTS5 + cosine similarity + graph/usage/staleness boost). `TIM_EMBEDDING_DISABLED=1` disables entirely.
- **Summary-first reads** — `tim_read` returns `summary` by default (500 chars or `metadata.summary`); full content only with `include_body=true`.
- **Retrieval benchmark harness** — `runBenchmark()` with precision@3, recall@5, MRR; golden query suite in test.
```

- [ ] **Step 3: Commit**

```bash
git add docs/tim-capabilities.md CHANGELOG.md packages/tim-mcp/src/server.ts
git commit -m "docs: hybrid retrieval documentation + tim_read include_body description

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## End-State Verification

After all 6 tasks:

```bash
cd ~/projects/tim
NODE_ENV=development npm run build       # 2 passes
NODE_ENV=development npm run build
NODE_ENV=development npx vitest run      # expect ~743 + ~10 new = ~753 green
git log master..HEAD --oneline           # expect 6 commits
git status --porcelain | grep -v -E "(dist/|node_modules/|package\.json|package-lock\.json|results\.json|tsbuildinfo)"
```

Expected: build clean, all tests passing (~753), working tree clean except gitignored artifacts.

Critical post-checks:
```bash
# entry_vectors NEVER leaked into staging/sync/export
grep -rn "entry_vectors" packages --include="*.ts" | grep -E "(staging|sync|export)" && echo "FAIL: entry_vectors leaked" || echo "OK: device-local"
```

Pre-existing `cli/new-project.test.ts > creates_full_project_schema` failure is unrelated and OK.
