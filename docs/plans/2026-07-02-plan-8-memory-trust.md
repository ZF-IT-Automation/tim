# Plan 8: Memory Trust (Staleness + Commit Provenance) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Memory entries carry a verification timestamp and git-commit provenance, and reads annotate entries that have gone stale or whose underlying code has moved on — so agents stop trusting outdated facts silently.

**Architecture:** No schema migration. `verified_at` and `provenance` live in the existing `metadata` JSON (syncs for free via the staging payload). Staleness is defined as `now - (metadata.verified_at ?? updated_at)` exceeding a threshold — an edit counts as implicit re-verification, so `write()`/`update()` need no changes. A new `tim_verify` tool re-confirms entries without editing them. Provenance is captured at the MCP layer (it needs the agent's cwd + git); the store stays git-free.

**Tech Stack:** TypeScript monorepo (npm workspaces), better-sqlite3, zod, Vitest, `node:child_process` execFileSync for git.

## Global Constraints

- **Never touch `~/.tim/tim.db`.** All tests use temp DB paths (`fs.mkdtempSync(path.join(os.tmpdir(), 'tim-test-'))`).
- MCP integration tests spawn `packages/tim-mcp/dist/server.js` — run `npm run build` before running them.
- Ordering: execute this plan **before Plan 4** (MCP-Surface). Plan 4 rewrites tool registration (`TOOL_DEFS` + zod-to-json-schema); if Plan 4 has already landed, register the new tool via `TOOL_DEFS` instead of the hand-written ListTools JSON shown here — the zod schema and the CallTool case stay identical.
- When Plan 5 (HTTP multi-client) lands: provenance capture must be skipped in HTTP mode (daemon cwd is meaningless). Until then, stdio is the only caller of `process.cwd()`-based capture — that is correct today.
- Commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Env knobs introduced here: `TIM_STALE_DAYS` (default 90), `TIM_PROVENANCE=0` (disable capture).

---

### Task 1: Add `updatedAt` to the Entry domain type

Entries already have an `updated_at` column (migration v7), but the `Entry` interface never exposes it. Staleness math (and Plan 11's `tim_delta`) needs it.

**Files:**
- Modify: `packages/tim-core/src/index.ts:35-52` (Entry interface)
- Modify: `packages/tim-store/src/store.ts:1975-1994` (rowToEntry)
- Modify: `packages/tim-store/src/curate.ts:37` (its own rowToEntry copy)
- Test: `packages/tim-store/src/__tests__/entry-updated-at.test.ts`

**Interfaces:**
- Produces: `Entry.updatedAt: string` (ISO 8601) — consumed by Task 4 and by Plan 11.

- [ ] **Step 1: Write the failing test**

Create `packages/tim-store/src/__tests__/entry-updated-at.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TimStore } from '../store.js';

describe('Entry.updatedAt', () => {
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

  it('exposes updated_at on read and bumps it on update', async () => {
    const written = await store.write('Fact\nThe API uses port 3100.', {
      tags: ['#api', '#infra'],
    });
    expect(written.updatedAt).toBe(written.createdAt);

    await new Promise(r => setTimeout(r, 5));
    await store.update(written.id, { content: 'The API uses port 3200.' });

    const read = await store.read(written.id);
    expect(read!.updatedAt > read!.createdAt).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/tim-store/src/__tests__/entry-updated-at.test.ts`
Expected: FAIL — `written.updatedAt` is `undefined` (property does not exist).

- [ ] **Step 3: Implement**

In `packages/tim-core/src/index.ts`, inside `export interface Entry`, after `accessedAt: string;` add:

```typescript
  updatedAt: string;             // ISO 8601 — last content/metadata change
```

In `packages/tim-store/src/store.ts` `rowToEntry` (line ~1975), after `accessedAt: row.accessed_at,` add:

```typescript
    updatedAt: row.updated_at,
```

In `packages/tim-store/src/curate.ts` `rowToEntry` (line ~37), make the same addition — its local `RowEntry` interface (line 10) must gain `updated_at: string;` if it doesn't have it yet.

Then run `npm run build` — TypeScript will flag every other place that constructs an `Entry` object literal without `updatedAt` (e.g. session tooling or test fixtures). Fix each by supplying the row's `updated_at`, or `created_at` where no row exists.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && npx vitest run packages/tim-store`
Expected: PASS, whole tim-store suite green.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(tim-core, tim-store): expose updated_at as Entry.updatedAt"
```

---

### Task 2: Move SCHEMA_KINDS to tim-core

Staleness must skip structural entries (sessions, sections, exchanges — they don't "go stale"). The authoritative kind list `SCHEMA_KINDS` lives in `packages/tim-mcp/src/write-validate.ts:15`, but Task 3's store-level health metric needs it too, and tim-store cannot import tim-mcp (dependency direction). Move the set to tim-core; re-export from write-validate for compatibility.

**Files:**
- Create: `packages/tim-core/src/schema-kinds.ts`
- Modify: `packages/tim-core/src/index.ts` (re-export)
- Modify: `packages/tim-mcp/src/write-validate.ts:15-…` (delete local declaration, import + re-export)

**Interfaces:**
- Produces: `SCHEMA_KINDS: Set<string>` exported from `tim-core` — consumed by Tasks 3, 4 and Plan 9.

- [ ] **Step 1: Move the declaration**

Create `packages/tim-core/src/schema-kinds.ts` and move the entire `export const SCHEMA_KINDS = new Set<string>([...])` declaration **verbatim** (including its comment block) from `packages/tim-mcp/src/write-validate.ts` into it. Do not add or remove kinds.

In `packages/tim-core/src/index.ts` add:

```typescript
export { SCHEMA_KINDS } from './schema-kinds.js';
```

In `packages/tim-mcp/src/write-validate.ts`, replace the deleted declaration with:

```typescript
import { SCHEMA_KINDS } from 'tim-core';
export { SCHEMA_KINDS };
```

(Keep the `export` so existing imports of `SCHEMA_KINDS` from write-validate keep compiling.)

- [ ] **Step 2: Verify + commit**

Run: `npm run build && npm test`
Expected: green — pure relocation, existing write-validate tests still pass.

```bash
git add -A
git commit -m "refactor(tim-core): move SCHEMA_KINDS to tim-core for store-level reuse"
```

---

### Task 3: `touchVerified` store method + stale-entries health metric

**Files:**
- Modify: `packages/tim-store/src/store.ts` (new method near `suppress()` ~line 1836; extend `health()` ~line 1626)
- Modify: `packages/tim-core/src/index.ts:177-184` (`HealthReport` gains `staleEntries: number`)
- Test: `packages/tim-store/src/__tests__/verify-staleness.test.ts`

**Interfaces:**
- Produces: `TimStore.touchVerified(ids: string[]): Promise<{ verified: string[]; missing: string[] }>` — sets `metadata.verified_at`, bumps `updated_at`, writes a staging upsert (so verification syncs). Consumed by Task 4's MCP handler.
- Produces: `HealthReport.staleEntries: number` — non-schema entries whose `verified_at ?? updated_at ?? created_at` is older than `TIM_STALE_DAYS` (default 90).

- [ ] **Step 1: Write the failing tests**

Create `packages/tim-store/src/__tests__/verify-staleness.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TimStore } from '../store.js';

describe('touchVerified + stale health metric', () => {
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

  it('touchVerified stamps metadata.verified_at and stages an upsert', async () => {
    const entry = await store.write('Fact\nPort is 3100.', { tags: ['#api', '#infra'] });
    const before = await store.getStagingCursor();

    const result = await store.touchVerified([entry.id, 'nonexistent-id']);
    expect(result.verified).toEqual([entry.id]);
    expect(result.missing).toEqual(['nonexistent-id']);

    const read = await store.read(entry.id);
    expect(typeof read!.metadata.verified_at).toBe('string');
    // Content untouched, verification synced via staging.
    expect(read!.content).toBe('Port is 3100.');
    expect(await store.getStagingCursor()).toBeGreaterThan(before);
  });

  it('health counts stale knowledge entries but never schema entries', async () => {
    const old = new Date(Date.now() - 200 * 86400_000).toISOString();
    const fresh = await store.write('Fresh fact\nStill true.', { tags: ['#a', '#b'] });

    const staleKnowledge = await store.write('Old fact\nMaybe rotten.', { tags: ['#a', '#b'] });
    const staleSession = await store.write('Session x', { metadata: { kind: 'session' } });
    // Backdate directly — tests own their fixtures; production never does this.
    const db = store.getDb();
    db.prepare('UPDATE entries SET created_at = ?, updated_at = ? WHERE id IN (?, ?)')
      .run(old, old, staleKnowledge.id, staleSession.id);

    const health = await store.health();
    expect(health.staleEntries).toBe(1); // only the knowledge entry

    // Verifying clears staleness.
    await store.touchVerified([staleKnowledge.id]);
    expect((await store.health()).staleEntries).toBe(0);
    expect((await store.read(fresh.id))).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/tim-store/src/__tests__/verify-staleness.test.ts`
Expected: FAIL — `store.touchVerified is not a function`.

- [ ] **Step 3: Implement**

In `packages/tim-store/src/store.ts`, add near `suppress()` (~line 1836):

```typescript
  /**
   * Re-confirm entries as still valid without editing them. Stamps
   * metadata.verified_at and bumps updated_at (a verification is a
   * meaningful, syncable change — the staging upsert carries it to
   * other devices). Staleness elsewhere is verified_at ?? updated_at.
   */
  async touchVerified(ids: string[]): Promise<{ verified: string[]; missing: string[] }> {
    const now = new Date().toISOString();
    const timestamp = Date.now();
    const verified: string[] = [];
    const missing: string[] = [];

    this.db.transaction(() => {
      for (const id of [...new Set(ids)]) {
        const existing = this.db.prepare('SELECT * FROM entries WHERE id = ?').get(id) as
          RowEntry | undefined;
        if (!existing || existing.tombstoned_at) {
          missing.push(id);
          continue;
        }
        const metadata = JSON.stringify({
          ...JSON.parse(existing.metadata || '{}'),
          verified_at: now,
        });
        const updated = { ...existing, metadata, accessed_at: now, updated_at: now };
        this.db.prepare(
          'UPDATE entries SET metadata = ?, accessed_at = ?, updated_at = ? WHERE id = ?',
        ).run(metadata, now, now, id);
        this.db.prepare(`INSERT INTO staging (key, entity_type, operation, payload,
          lww_timestamp, lww_device, lww_confidence)
          VALUES (?, 'entry', 'upsert', ?, ?, 'local', ?)`).run(
          id, JSON.stringify(updated), timestamp, existing.confidence,
        );
        verified.push(id);
      }
    })();

    return { verified, missing };
  }
```

Note: if Plan 6 has landed, the staging insert must use the store's device id instead of the literal `'local'` — match whatever `insertStagingSync` (line ~1104) does at that point.

In `health()` (~line 1626), before the final `return`, add:

```typescript
    // Stale knowledge: non-schema entries not verified/edited within the
    // threshold. Schema entries (sessions, sections, …) are structure and
    // don't go stale. Cutoff computed in JS — ISO strings compare correctly
    // only against ISO strings, not against SQLite's datetime() format.
    const staleDaysRaw = Number(process.env.TIM_STALE_DAYS);
    const staleDays = Number.isFinite(staleDaysRaw) && staleDaysRaw > 0 ? staleDaysRaw : 90;
    const cutoff = new Date(Date.now() - staleDays * 86400_000).toISOString();
    const kindList = [...SCHEMA_KINDS].map(() => '?').join(', ');
    const stale = this.db.prepare(`
      SELECT COUNT(*) as count FROM entries
      WHERE irrelevant = 0 AND tombstoned_at IS NULL
        AND (json_extract(metadata, '$.kind') IS NULL
             OR json_extract(metadata, '$.kind') NOT IN (${kindList}))
        AND COALESCE(json_extract(metadata, '$.verified_at'),
                     NULLIF(updated_at, ''), created_at) < ?
    `).get(...SCHEMA_KINDS, cutoff) as { count: number };
    if (stale.count > 0) {
      issues.push(`${stale.count} stale entries (older than ${staleDays}d, unverified)`);
    }
```

Add `staleEntries: stale.count,` to the returned object, and import `SCHEMA_KINDS` from `'tim-core'` at the top of store.ts (extend the existing tim-core import on line ~15).

In `packages/tim-core/src/index.ts`, `HealthReport` (line 177) gains:

```typescript
  staleEntries: number;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && npx vitest run packages/tim-store`
Expected: PASS. If `health-metrics.test.ts` asserts on the exact `HealthReport` shape, extend its expectations with `staleEntries`.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(tim-store): touchVerified re-confirmation + stale-entries health metric"
```

---

### Task 4: `tim_verify` tool + staleness annotation on tim_read

**Files:**
- Create: `packages/tim-mcp/src/trust.ts`
- Modify: `packages/tim-mcp/src/server.ts` — zod schema (near TimReadSchema, ~line 87), ListTools registration (after `tim_update` entry, ~line 1100), CallTool case (after `case 'tim_update'`), and the two tim_read success paths (~lines 1759 and 1802)
- Test: `packages/tim-mcp/src/__tests__/trust-annotation.test.ts` (unit, no server spawn)

**Interfaces:**
- Consumes: `TimStore.touchVerified` (Task 3), `Entry.updatedAt` (Task 1), `SCHEMA_KINDS` from tim-core (Task 2).
- Produces: `annotateTrust(entry: Entry, cwd: string): Entry & { stale?: { lastVerified: string; daysSince: number } }` in trust.ts — Task 5 extends the same function with provenance drift.

- [ ] **Step 1: Write the failing unit test**

Create `packages/tim-mcp/src/__tests__/trust-annotation.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { annotateTrust } from '../trust.js';
import type { Entry } from 'tim-core';

function entryFixture(overrides: Partial<Entry>): Entry {
  const now = new Date().toISOString();
  return {
    id: 'x'.repeat(26),
    parentId: null,
    title: 'Fact',
    content: 'body',
    contentType: 'text',
    depth: 1,
    confidence: 1,
    createdAt: now,
    accessedAt: now,
    updatedAt: now,
    decayRate: 0,
    visibility: 1,
    tags: [],
    irrelevant: false,
    favorite: false,
    tombstonedAt: null,
    metadata: {},
    ...overrides,
  };
}

describe('annotateTrust — staleness', () => {
  const old = new Date(Date.now() - 200 * 86400_000).toISOString();

  it('marks unverified old knowledge entries stale', () => {
    const out = annotateTrust(entryFixture({ createdAt: old, updatedAt: old }), process.cwd());
    expect(out.stale).toBeDefined();
    expect(out.stale!.daysSince).toBeGreaterThan(90);
    expect(out.stale!.lastVerified).toBe(old);
  });

  it('respects a recent metadata.verified_at', () => {
    const out = annotateTrust(
      entryFixture({
        createdAt: old,
        updatedAt: old,
        metadata: { verified_at: new Date().toISOString() },
      }),
      process.cwd(),
    );
    expect(out.stale).toBeUndefined();
  });

  it('never marks schema entries stale', () => {
    const out = annotateTrust(
      entryFixture({ createdAt: old, updatedAt: old, metadata: { kind: 'session' } }),
      process.cwd(),
    );
    expect(out.stale).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/tim-mcp/src/__tests__/trust-annotation.test.ts`
Expected: FAIL — module `../trust.js` not found.

- [ ] **Step 3: Implement trust.ts**

Create `packages/tim-mcp/src/trust.ts`:

```typescript
// Read-time trust annotations: staleness (this task) and provenance
// drift (Task 5). Annotations are additive fields on the returned entry —
// the stored row is never modified by reading it.

import { SCHEMA_KINDS, type Entry } from 'tim-core';

const DAY_MS = 86_400_000;

function staleDays(): number {
  const raw = Number(process.env.TIM_STALE_DAYS);
  return Number.isFinite(raw) && raw > 0 ? raw : 90;
}

export interface StaleInfo {
  lastVerified: string;   // ISO — verified_at, else updated_at, else created_at
  daysSince: number;
}

export type TrustAnnotated = Entry & { stale?: StaleInfo };

export function annotateTrust(entry: Entry, _cwd: string): TrustAnnotated {
  const kind = typeof entry.metadata.kind === 'string' ? entry.metadata.kind : undefined;
  if (kind && SCHEMA_KINDS.has(kind)) return entry;

  const verifiedAt =
    typeof entry.metadata.verified_at === 'string' ? entry.metadata.verified_at : undefined;
  const lastVerified = verifiedAt ?? entry.updatedAt ?? entry.createdAt;
  const daysSince = Math.floor((Date.now() - Date.parse(lastVerified)) / DAY_MS);

  if (!Number.isFinite(daysSince) || daysSince <= staleDays()) return entry;
  return { ...entry, stale: { lastVerified, daysSince } };
}
```

(`_cwd` is unused until Task 5 adds drift — keep the parameter so call sites don't change twice.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run build && npx vitest run packages/tim-mcp/src/__tests__/trust-annotation.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire tim_verify and the tim_read annotation**

In `packages/tim-mcp/src/server.ts`:

Import at top (extend existing imports): `import { annotateTrust } from './trust.js';`

Add the zod schema near `TimUpdateSchema` (~line 159):

```typescript
const TimVerifySchema = z.object({
  id: z.union([z.string(), z.array(z.string()).min(1).max(50)])
    .describe('Entry ID (or label like L0042), or array of up to 50 IDs'),
});
```

Add the ListTools registration after the `tim_update` entry (~line 1100):

```typescript
      {
        name: 'tim_verify',
        description: 'Re-confirm entries as still valid without editing them. ' +
          'Stamps metadata.verified_at — clears the "stale" annotation on reads ' +
          'and the stale count in tim_health.',
        inputSchema: {
          type: 'object',
          properties: {
            id: {
              oneOf: [
                { type: 'string', description: 'Entry ID or label' },
                { type: 'array', items: { type: 'string' }, description: 'Batch (max 50)' },
              ],
            },
          },
          required: ['id'],
        },
      },
```

Add the CallTool case after `case 'tim_update'`:

```typescript
        case 'tim_verify': {
          const { id } = TimVerifySchema.parse(args);
          const rawIds = Array.isArray(id) ? id : [id];
          const resolved: string[] = [];
          const unresolved: string[] = [];
          for (const raw of rawIds) {
            const entry = await s.read(raw, { showIrrelevant: true, includeChildren: false });
            if (entry) resolved.push(entry.id);
            else unresolved.push(raw);
          }
          const result = await s.touchVerified(resolved);
          return {
            content: [{
              type: 'text',
              text: formatToolResponse({
                verified: result.verified,
                missing: [...unresolved, ...result.missing],
              }),
            }],
          };
        }
```

Annotate the two single-entry tim_read success paths:

At ~line 1759 (project path), change

```typescript
              content: [{ type: 'text', text: formatToolResponse({ entry, edges }) }],
```

to

```typescript
              content: [{ type: 'text', text: formatToolResponse({ entry: annotateTrust(entry, process.cwd()), edges }) }],
```

At ~line 1802 (id path), make the identical change. In the batch path (~line 1668), change `formatToolResponse({ entries, missing })` to `formatToolResponse({ entries: entries.map(e => annotateTrust(e, process.cwd())), missing })`.

- [ ] **Step 6: Verify the wiring end-to-end**

Add an integration test: copy the `McpClient` class verbatim from `packages/tim-mcp/src/__tests__/read-search-write-ext.test.ts` into a new `packages/tim-mcp/src/__tests__/verify-tool.test.ts` (temp DB dir via `fs.mkdtempSync`, same beforeEach/afterEach shape as the source file). Test body: write an entry via `tim_write` (with 2 tags), call `tim_verify` with its id and assert the response JSON's `verified` array contains the id, then `tim_read` the id and assert the returned entry's `metadata.verified_at` is a string.

Run: `npm run build && npm test`
Expected: green, including the new integration test.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(tim-mcp): tim_verify tool + staleness annotation on tim_read"
```

---

### Task 5: Commit provenance — capture on write, drift on read

**Files:**
- Create: `packages/tim-mcp/src/provenance.ts`
- Modify: `packages/tim-mcp/src/trust.ts` (drift annotation in `annotateTrust`)
- Modify: `packages/tim-mcp/src/server.ts` tim_write case (~line 1925, just before `s.write`)
- Test: `packages/tim-mcp/src/__tests__/provenance.test.ts`

**Interfaces:**
- Produces: `captureProvenance(cwd: string): { commit: string; branch?: string } | null` and `commitsSince(cwd: string, commit: string): number | null`.
- Extends: `annotateTrust` return type with `provenance_drift?: { commitsSince: number }`.

- [ ] **Step 1: Write the failing tests**

Create `packages/tim-mcp/src/__tests__/provenance.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { captureProvenance, commitsSince } from '../provenance.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    .toString().trim();
}

describe('provenance', () => {
  let repo: string;
  let firstCommit: string;

  beforeAll(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-prov-'));
    git(repo, 'init', '-b', 'main');
    git(repo, 'config', 'user.email', 'test@test');
    git(repo, 'config', 'user.name', 'test');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'first');
    firstCommit = git(repo, 'rev-parse', '--short', 'HEAD');
  });

  afterAll(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('captures commit and branch in a git repo', () => {
    const prov = captureProvenance(repo);
    expect(prov).toEqual({ commit: firstCommit, branch: 'main' });
  });

  it('returns null outside a git repo', () => {
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-plain-'));
    try {
      expect(captureProvenance(plain)).toBeNull();
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });

  it('counts commits since a stored commit', () => {
    expect(commitsSince(repo, firstCommit)).toBe(0);
    fs.writeFileSync(path.join(repo, 'b.txt'), 'two');
    git(repo, 'add', '.');
    git(repo, 'commit', '-m', 'second');
    expect(commitsSince(repo, firstCommit)).toBe(1);
  });

  it('returns null for an unknown commit', () => {
    expect(commitsSince(repo, 'ffffffff')).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/tim-mcp/src/__tests__/provenance.test.ts`
Expected: FAIL — module `../provenance.js` not found.

- [ ] **Step 3: Implement provenance.ts**

```typescript
// Git provenance for memory entries. Captured at the MCP layer because
// only the MCP process knows the agent's cwd; the store stays git-free.
// Every call shells out once — ~5ms, acceptable at tool-call frequency.

import { execFileSync } from 'node:child_process';

const GIT_OPTS = { timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] as const };

export interface Provenance {
  commit: string;      // short hash at write time
  branch?: string;
}

export function captureProvenance(cwd: string): Provenance | null {
  try {
    const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd, ...GIT_OPTS })
      .toString().trim();
    if (!commit) return null;
    let branch: string | undefined;
    try {
      const b = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, ...GIT_OPTS })
        .toString().trim();
      branch = b && b !== 'HEAD' ? b : undefined; // 'HEAD' = detached
    } catch {
      branch = undefined;
    }
    return branch ? { commit, branch } : { commit };
  } catch {
    return null; // not a repo, no git binary, or timeout — provenance is best-effort
  }
}

export function commitsSince(cwd: string, commit: string): number | null {
  try {
    const out = execFileSync('git', ['rev-list', '--count', `${commit}..HEAD`], { cwd, ...GIT_OPTS })
      .toString().trim();
    const n = Number(out);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null; // unknown commit (different repo) or not a repo
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build && npx vitest run packages/tim-mcp/src/__tests__/provenance.test.ts`
Expected: PASS.

- [ ] **Step 5: Capture on tim_write**

In `packages/tim-mcp/src/server.ts`, import `captureProvenance` from `'./provenance.js'`. In the tim_write case, directly before `const entry = await s.write(opts.content, writeOpts);` (~line 1925), add:

```typescript
          // Best-effort git provenance: which commit was HEAD when this
          // knowledge was written. Skipped for schema entries, explicit
          // provenance, and when disabled via env.
          const provKind = typeof (writeOpts.metadata as Record<string, unknown>)?.kind === 'string'
            ? (writeOpts.metadata as Record<string, unknown>).kind as string
            : undefined;
          if (
            process.env.TIM_PROVENANCE !== '0' &&
            (writeOpts.metadata as Record<string, unknown>).provenance === undefined &&
            (!provKind || !SCHEMA_KINDS.has(provKind))
          ) {
            const prov = captureProvenance(process.cwd());
            if (prov) {
              (writeOpts.metadata as Record<string, unknown>).provenance = {
                ...prov,
                captured_at: new Date().toISOString(),
              };
            }
          }
```

(`SCHEMA_KINDS` is already imported in server.ts via write-validate or tim-core — check the imports at the top and add if missing.)

- [ ] **Step 6: Drift annotation in annotateTrust**

In `packages/tim-mcp/src/trust.ts`, import `commitsSince` from `'./provenance.js'`, extend the type and function:

```typescript
export type TrustAnnotated = Entry & {
  stale?: StaleInfo;
  provenance_drift?: { commitsSince: number };
};
```

At the end of `annotateTrust`, replace the current return logic with:

```typescript
  const annotated: TrustAnnotated = { ...entry };
  if (Number.isFinite(daysSince) && daysSince > staleDays()) {
    annotated.stale = { lastVerified, daysSince };
  }

  const prov = entry.metadata.provenance as { commit?: unknown } | undefined;
  if (prov && typeof prov.commit === 'string') {
    const drift = commitsSince(_cwd, prov.commit);
    if (drift !== null && drift > 0) {
      annotated.provenance_drift = { commitsSince: drift };
    }
  }

  return annotated.stale || annotated.provenance_drift ? annotated : entry;
```

(Rename `_cwd` to `cwd` now that it is used.) Add a drift test to `trust-annotation.test.ts` reusing the temp-repo pattern from provenance.test.ts: create a repo with two commits, build a fixture entry with `metadata.provenance = { commit: firstCommit }`, and assert `annotateTrust(entry, repo).provenance_drift` equals `{ commitsSince: 1 }`.

- [ ] **Step 7: Run the full suite + commit**

Run: `npm run build && npm test`
Expected: green. Watch for existing metadata-roundtrip tests in tim-mcp that assert exact metadata equality after tim_write — they now see an extra `provenance` key when the test process runs inside a git repo. Fix those tests by setting `TIM_PROVENANCE=0` in their spawn env (one line in the McpClient env object), not by weakening the feature.

```bash
git add -A
git commit -m "feat(tim-mcp): git commit provenance on write, drift annotation on read"
```

---

### Task 6: Documentation

**Files:**
- Modify: `docs/tim-capabilities.md` (trust section), `CHANGELOG.md` `[Unreleased]`

- [ ] **Step 1: Document the trust model**

Add a "Memory Trust" subsection to `docs/tim-capabilities.md` covering: staleness definition (`verified_at ?? updated_at`, threshold `TIM_STALE_DAYS` default 90), `tim_verify` semantics (bumps `updated_at`, syncs), provenance capture (`TIM_PROVENANCE=0` to disable, best-effort, stdio-only until Plan 5), and what the `stale` / `provenance_drift` read annotations mean for an agent ("verify or re-check the fact before relying on it").

- [ ] **Step 2: Commit**

```bash
git add docs/tim-capabilities.md CHANGELOG.md
git commit -m "docs: memory trust model (staleness, verification, provenance)"
```
