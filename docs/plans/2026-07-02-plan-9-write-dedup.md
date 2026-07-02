# Plan 9: Write-Time Dedup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `tim_write` detects near-duplicate titles in the same project before inserting and refuses with the candidate list — curation becomes inline hygiene instead of a periodic cleanup chore.

**Architecture:** A store-level `findSimilar()` reuses the existing FTS index (search title tokens, then score candidates with Jaccard token overlap ≥ 0.6). The policy lives at the MCP layer: `tim_write` runs the check for knowledge entries only (schema kinds exempt — sessions/exchanges/summaries are pipeline writes and must never be blocked), and a `force: true` flag bypasses it. Same layering as suppress enforcement.

**Tech Stack:** TypeScript monorepo, better-sqlite3 FTS5, zod, Vitest.

## Global Constraints

- **Never touch `~/.tim/tim.db`.** All tests use temp DB paths (`fs.mkdtempSync(path.join(os.tmpdir(), 'tim-test-'))`).
- Prerequisite: **Plan 8 Task 2** (SCHEMA_KINDS exported from tim-core). If it hasn't landed, import `SCHEMA_KINDS` from `'./write-validate.js'` instead — it is exported there today.
- Ordering: execute **before Plan 4** (which rewrites tool registration). If Plan 4 landed first, add the `force` property via the zod `.describe()` on `TimWriteSchema` only — ListTools is then generated.
- Env kill-switch: `TIM_DEDUP_CHECK=0` disables the gate entirely.
- Commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: `titleSimilarity` + `TimStore.findSimilar`

**Files:**
- Modify: `packages/tim-store/src/store.ts` (exported helper near `sanitizeFtsQuery` at line 35; new method after `searchFts` ~line 1338)
- Modify: `packages/tim-store/src/index.ts` (export `titleSimilarity` alongside the existing store exports)
- Test: `packages/tim-store/src/__tests__/find-similar.test.ts`

**Interfaces:**
- Produces: `titleSimilarity(a: string, b: string): number` — Jaccard overlap of lowercase word-token sets, 0..1.
- Produces: `TimStore.findSimilar(title: string, opts?: { projectLabel?: string; threshold?: number; limit?: number }): Promise<Array<{ id: string; title: string; similarity: number }>>` — consumed by Task 2's MCP gate.

- [ ] **Step 1: Write the failing tests**

Create `packages/tim-store/src/__tests__/find-similar.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TimStore, titleSimilarity } from '../store.js';

describe('titleSimilarity', () => {
  it('is 1.0 for identical titles up to case and punctuation', () => {
    expect(titleSimilarity('FTS Sanitizer quotes tokens', 'fts sanitizer quotes tokens!')).toBe(1);
  });

  it('scores high overlap above the 0.6 threshold', () => {
    expect(
      titleSimilarity('Reminder-System via Cron-Checker', 'Reminder System Cron Checker Design'),
    ).toBeGreaterThanOrEqual(0.6);
  });

  it('scores unrelated titles low', () => {
    expect(titleSimilarity('SQLite WAL checkpoint', 'Telegram bot pairing')).toBe(0);
  });

  it('handles empty titles', () => {
    expect(titleSimilarity('', 'anything')).toBe(0);
  });
});

describe('TimStore.findSimilar', () => {
  let dir: string;
  let store: TimStore;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-test-'));
    store = new TimStore(path.join(dir, 'test.db'));
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('finds a near-duplicate title and scores it', async () => {
    const existing = await store.write('Reminder System via Cron Checker\nDesign notes.', {
      tags: ['#reminder', '#design'],
    });
    await store.write('Telegram bot pairing\nUnrelated.', { tags: ['#telegram', '#bot'] });

    const hits = await store.findSimilar('Reminder System Cron Checker v2');
    expect(hits.length).toBe(1);
    expect(hits[0].id).toBe(existing.id);
    expect(hits[0].similarity).toBeGreaterThanOrEqual(0.6);
  });

  it('scopes to a project label when given', async () => {
    const projA = await store.write('Project A', { metadata: { kind: 'project', label: 'P0001' } });
    const projB = await store.write('Project B', { metadata: { kind: 'project', label: 'P0002' } });
    await store.write('Shared idea title here\nIn A.', {
      parentId: projA.id, tags: ['#idea', '#x'],
    });

    const inB = await store.findSimilar('Shared idea title here', { projectLabel: 'P0002' });
    expect(inB).toEqual([]);
    const inA = await store.findSimilar('Shared idea title here', { projectLabel: 'P0001' });
    expect(inA.length).toBe(1);
    expect(projB.id).toBeTruthy();
  });

  it('returns nothing below the threshold', async () => {
    await store.write('Completely different words\nBody.', { tags: ['#a', '#b'] });
    expect(await store.findSimilar('quantum flux capacitor')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/tim-store/src/__tests__/find-similar.test.ts`
Expected: FAIL — `titleSimilarity` is not exported.

- [ ] **Step 3: Implement**

In `packages/tim-store/src/store.ts`, directly after `sanitizeFtsQuery` (ends ~line 68), add:

```typescript
/**
 * Jaccard overlap of lowercase word-token sets. 1.0 = same word set.
 * Single-char tokens are dropped — they are almost always punctuation
 * noise ("v2", "a") and inflate similarity between unrelated titles.
 */
export function titleSimilarity(a: string, b: string): number {
  const tokens = (s: string): Set<string> =>
    new Set(
      s.toLowerCase().split(/[^0-9a-zà-öø-ÿ]+/).filter(w => w.length > 1),
    );
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let intersection = 0;
  for (const w of ta) if (tb.has(w)) intersection++;
  return intersection / (ta.size + tb.size - intersection);
}
```

In the `TimStore` class, after `searchFts` (~line 1338), add:

```typescript
  /**
   * Near-duplicate candidates for a title, for the tim_write dedup gate.
   * FTS narrows to plausible candidates; Jaccard token overlap on the
   * title decides. Suppressed/irrelevant/tombstoned entries are already
   * excluded by searchFts.
   */
  async findSimilar(
    title: string,
    opts: { projectLabel?: string; threshold?: number; limit?: number } = {},
  ): Promise<Array<{ id: string; title: string; similarity: number }>> {
    const threshold = opts.threshold ?? 0.6;
    const candidates = await this.searchFts(title, 25);
    const hits: Array<{ id: string; title: string; similarity: number }> = [];
    for (const c of candidates) {
      if (opts.projectLabel && this.getProjectLabel(c.id) !== opts.projectLabel) continue;
      const similarity = titleSimilarity(title, c.title);
      if (similarity >= threshold) {
        hits.push({ id: c.id, title: c.title, similarity: Number(similarity.toFixed(2)) });
      }
    }
    return hits.sort((x, y) => y.similarity - x.similarity).slice(0, opts.limit ?? 5);
  }
```

Check `packages/tim-store/src/index.ts`: if it re-exports named symbols from `./store.js` explicitly, add `titleSimilarity`; if it uses `export *`, nothing to do.

Note for the second test: `getProjectLabel` resolves via the parent chain to a `kind: 'project'` root. A project-root entry itself (the fixture's `projA`) resolves to its own label.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && npx vitest run packages/tim-store`
Expected: PASS, whole tim-store suite green.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(tim-store): findSimilar near-duplicate detection via FTS + Jaccard"
```

---

### Task 2: Dedup gate in tim_write with `force` bypass

**Files:**
- Modify: `packages/tim-mcp/src/server.ts` — `TimWriteSchema` (~line 101), tim_write ListTools registration (~line 1006), tim_write case (before `s.write`, ~line 1925)
- Test: `packages/tim-mcp/src/__tests__/write-dedup.test.ts` (integration via spawned server)

**Interfaces:**
- Consumes: `TimStore.findSimilar` (Task 1), `SCHEMA_KINDS` (from tim-core after Plan 8 Task 2, else from `./write-validate.js`).
- Produces: tim_write refusal contract — `isError: true` with JSON body `{ status: 'duplicate_suspected', candidates: [{ id, title, similarity }], hint: string }`.

- [ ] **Step 1: Write the failing integration test**

Create `packages/tim-mcp/src/__tests__/write-dedup.test.ts`. Copy the `McpClient` class **verbatim** from `packages/tim-mcp/src/__tests__/read-search-write-ext.test.ts` (the class from `class McpClient {` through its closing brace, including the `JsonRpcResp` interface), then add:

```typescript
describe('tim_write dedup gate', () => {
  let dir: string;
  let client: McpClient;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-dedup-'));
    client = new McpClient(path.join(dir, 'test.db'));
    await client.initialize();
  });

  afterEach(() => {
    client.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('refuses a near-duplicate title and lists candidates', async () => {
    const first = await client.callTool('tim_write', {
      content: 'Reminder System via Cron Checker\nDesign notes.',
      tags: ['#reminder', '#design'],
    });
    expect(first.result?.isError).toBeFalsy();

    const dup = await client.callTool('tim_write', {
      content: 'Reminder System Cron Checker\nSlightly different notes.',
      tags: ['#reminder', '#design'],
    });
    expect(dup.result?.isError).toBe(true);
    const body = JSON.parse(dup.result!.content[0].text);
    expect(body.status).toBe('duplicate_suspected');
    expect(body.candidates.length).toBeGreaterThanOrEqual(1);
    expect(body.candidates[0].title).toBe('Reminder System via Cron Checker');
  });

  it('force:true bypasses the gate', async () => {
    await client.callTool('tim_write', {
      content: 'Unique fact one\nBody.', tags: ['#a', '#b'],
    });
    const forced = await client.callTool('tim_write', {
      content: 'Unique fact one\nSecond body.', tags: ['#a', '#b'], force: true,
    });
    expect(forced.result?.isError).toBeFalsy();
  });

  it('never blocks schema-kind writes', async () => {
    const s1 = await client.callTool('tim_write', {
      content: 'Session summary batch', metadata: { kind: 'batch-summary' },
    });
    const s2 = await client.callTool('tim_write', {
      content: 'Session summary batch', metadata: { kind: 'batch-summary' },
    });
    expect(s1.result?.isError).toBeFalsy();
    expect(s2.result?.isError).toBeFalsy();
  });
});
```

(Reuse the same imports the source test file has: `vitest`, `node:child_process`, `node:path`, `node:fs` — plus `node:os`. Match the `McpClient` method names used there; if its call helper is named differently than `callTool`, adapt these tests to the actual helper, not the other way around.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && npx vitest run packages/tim-mcp/src/__tests__/write-dedup.test.ts`
Expected: The first test FAILS — the duplicate write currently succeeds (`isError` falsy).

- [ ] **Step 3: Implement the gate**

In `packages/tim-mcp/src/server.ts`:

Add to `TimWriteSchema` (~line 101):

```typescript
  force: z.boolean().optional().default(false)
    .describe('Bypass the near-duplicate title check and write anyway'),
```

Update the destructuring at the top of the tim_write case (~line 1814) so `force` does not leak into `WriteOptions`:

```typescript
          const { parentTitle, projectId, where, force, ...writeOpts } = opts;
```

Add the `force` property to the tim_write ListTools registration (~line 1006), inside `properties`:

```typescript
            force: { type: 'boolean', default: false, description: 'Bypass the near-duplicate title check and write anyway' },
```

Directly before `const entry = await s.write(opts.content, writeOpts);` (~line 1925 — after tag validation, and after Plan 8's provenance block if that landed), add:

```typescript
          // Dedup gate: refuse knowledge writes whose title is nearly
          // identical to an existing entry in the same project. Schema
          // kinds (sessions, exchanges, summaries, …) are pipeline writes
          // and are never blocked.
          const dedupKind = typeof (writeOpts.metadata as Record<string, unknown>)?.kind === 'string'
            ? (writeOpts.metadata as Record<string, unknown>).kind as string
            : undefined;
          if (
            !force &&
            process.env.TIM_DEDUP_CHECK !== '0' &&
            (!dedupKind || !SCHEMA_KINDS.has(dedupKind))
          ) {
            const candidateTitle = (writeOpts.title ?? opts.content.split('\n')[0]).trim();
            const dedupScope = writeOpts.parentId
              ? s.getProjectLabel(writeOpts.parentId) ?? undefined
              : undefined;
            const dupes = candidateTitle
              ? await s.findSimilar(candidateTitle, { projectLabel: dedupScope })
              : [];
            if (dupes.length > 0) {
              return {
                content: [{
                  type: 'text',
                  text: formatToolResponse({
                    status: 'duplicate_suspected',
                    candidates: dupes,
                    hint: 'A very similar entry already exists. Append to it with ' +
                      'tim_update, or pass force:true to write a new entry anyway.',
                  }),
                }],
                isError: true,
              };
            }
          }
```

Ensure `SCHEMA_KINDS` is imported at the top of server.ts (from `'tim-core'` post-Plan-8, else from `'./write-validate.js'`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && npx vitest run packages/tim-mcp/src/__tests__/write-dedup.test.ts`
Expected: PASS, all three tests.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: green. Existing tim-mcp tests that write two similarly-titled entries in sequence may now hit the gate — fix those fixtures by passing `force: true` or distinct titles, unless the test's purpose was exactly-duplicate writes (then the new behavior is the spec and the assertion should flip).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(tim-mcp): tim_write refuses near-duplicate titles (force:true bypasses)"
```

---

### Task 3: Documentation

**Files:**
- Modify: `docs/tim-capabilities.md`, `CHANGELOG.md` `[Unreleased]`

- [ ] **Step 1: Document the gate**

In `docs/tim-capabilities.md`, document: threshold 0.6 Jaccard on title tokens, project-scoped when the write has a parent, schema kinds exempt, `force:true` bypass, `TIM_DEDUP_CHECK=0` kill-switch, and the `duplicate_suspected` response contract (agents should `tim_update` the candidate or retry with `force`).

- [ ] **Step 2: Commit**

```bash
git add docs/tim-capabilities.md CHANGELOG.md
git commit -m "docs: write-time dedup gate"
```
