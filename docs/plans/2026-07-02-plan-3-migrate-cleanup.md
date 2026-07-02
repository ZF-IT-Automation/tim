# Plan 3: Migration / hmem-Import Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the untested legacy migration engine, and make `tim_import` produce entries that have titles, appear in sync staging, and actually receive changed content on deduplicating re-import.

**Architecture:** `tim-migrate/src/import.ts` keeps its direct-SQL transaction structure (rewriting to the async store API would break the all-or-nothing import transaction), but its two low-level insert helpers gain title-splitting and staging writes, sharing `splitTitleBody` exported from tim-store. `migrate.ts` (legacy engine) is deleted outright — zero callers outside its own package export, zero tests.

**Tech Stack:** TypeScript, better-sqlite3, Vitest.

## Global Constraints

- The import transaction boundary must not change: dry-run does no writes; real run is one `db.transaction`.
- Staging payloads must be full `RowEntry`-shaped JSON (snake_case keys incl. `updated_at`) — that is what `applyStaging`/`applyRemoteEntry` parse on the receiving device.
- Never touch `~/.tim/tim.db`.
- Commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Delete the legacy migrate.ts engine

**Files:**
- Delete: `packages/tim-migrate/src/migrate.ts`
- Modify: `packages/tim-migrate/src/index.ts:3-4` (remove the two export lines)

**Why:** `migrateHmemToTim` has zero tests, drops `metadata.label`, fabricates `extends` edges between merely-consecutive entries, and never closes the target store. The v2/old importers in `import.ts` cover the same formats correctly.

- [ ] **Step 1: Verify zero external callers**

Run: `grep -rn "migrateHmemToTim\|verifyHmemFile" packages --include="*.ts" | grep -v dist | grep -v "tim-migrate/src/migrate.ts" | grep -v "tim-migrate/src/index.ts"`
Expected: no output. If anything appears (e.g. a CLI command), STOP and list the callers in your task report instead of deleting.

- [ ] **Step 2: Delete file and exports**

```bash
git rm packages/tim-migrate/src/migrate.ts
```

In `packages/tim-migrate/src/index.ts` remove:

```typescript
export { migrateHmemToTim, verifyHmemFile } from './migrate.js';
export type { MigrationReport } from './migrate.js';
```

Note: `MigrationReport` is ALSO exported from `./tags-to-types.js` under the alias `TagsToTypesReport` — that line stays.

- [ ] **Step 3: Build + full test suite**

Run: `npm run build && cd packages/tim-migrate && npx vitest run`
Expected: clean build (a compile error here means Step 1 missed a caller), tests green.

- [ ] **Step 4: Commit**

```bash
git add -A packages/tim-migrate
git commit -m "chore(tim-migrate): delete untested legacy migrate.ts engine"
```

---

### Task 2: Imported entries get titles and staging records (sync-ready)

**Files:**
- Modify: `packages/tim-store/src/store.ts` (export `splitTitleBody`) and `packages/tim-store/src/index.ts` (re-export)
- Modify: `packages/tim-migrate/src/import.ts:121-167` (`insertEntryDirect`, `insertEdgeDirect`)
- Test: `packages/tim-migrate/src/__tests__/import-sync.test.ts` (new)

**Interfaces:**
- Consumes: `splitTitleBody(content: string, explicitTitle?: string): { title: string; body: string }` — currently a module-private function at the bottom of `packages/tim-store/src/store.ts`; make it `export function` and add `export { splitTitleBody } from './store.js';` alongside the existing store exports in `packages/tim-store/src/index.ts`.
- Produces: every imported entry row has `title` set, `updated_at` set, and one `staging` upsert row; every imported edge has one `staging` upsert row keyed `source|target|type`.

- [ ] **Step 1: Write the failing test**

Create `packages/tim-migrate/src/__tests__/import-sync.test.ts`. Use the existing import tests in this directory as the template for building a v2 source file (`createV2HmemDatabase` from `../hmem-format.js` builds one):

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import { TimStore } from 'tim-store';
import { tim_import } from '../import.js';
import { createV2HmemDatabase } from '../hmem-format.js';

describe('tim_import sync-readiness', () => {
  let store: TimStore;
  let dbPath: string;
  let sourcePath: string;

  beforeEach(() => {
    const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    dbPath = `/tmp/tim-impsync-${stamp}.db`;
    sourcePath = `/tmp/tim-impsync-src-${stamp}.hmem`;
    store = new TimStore(dbPath);

    const src = createV2HmemDatabase(sourcePath);
    src.prepare(`
      INSERT INTO entries (uid, label, prefix, seq, level_1, created_at, updated_at,
        access_count, obsolete, favorite, irrelevant, pinned)
      VALUES ('uid-root-1', 'L0001', 'L', 1,
        'Lesson title line' || char(10) || 'Lesson body text',
        '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z', 0, 0, 0, 0, 0)
    `).run();
    src.prepare(`
      INSERT INTO nodes (uid, root_uid, parent_uid, depth, seq, content,
        created_at, updated_at, irrelevant)
      VALUES ('uid-node-1', 'uid-root-1', NULL, 2, 1, 'Node line one' || char(10) || 'node body',
        '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z', 0)
    `).run();
    src.prepare(`
      INSERT INTO links (src_uid, dst_uid, kind) VALUES ('uid-root-1', 'uid-node-1', 'relates')
    `).run();
    src.close();
  });

  afterEach(() => {
    store.close();
    for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, sourcePath]) {
      try { fs.unlinkSync(p); } catch { /* ignore */ }
    }
  });

  it('imported entries have titles split from the first content line', async () => {
    tim_import(store, sourcePath);
    const root = store.getDb().prepare(
      "SELECT title, content FROM entries WHERE json_extract(metadata, '$.hmemUid') = 'uid-root-1'",
    ).get() as { title: string; content: string };
    expect(root.title).toBe('Lesson title line');
    expect(root.content).toBe('Lesson body text');
  });

  it('imported entries and edges appear in sync staging', async () => {
    tim_import(store, sourcePath);
    const entryStaging = store.getDb().prepare(
      "SELECT COUNT(*) AS c FROM staging WHERE entity_type = 'entry' AND acked = 0",
    ).get() as { c: number };
    const edgeStaging = store.getDb().prepare(
      "SELECT COUNT(*) AS c FROM staging WHERE entity_type = 'edge' AND acked = 0",
    ).get() as { c: number };
    expect(entryStaging.c).toBeGreaterThanOrEqual(2); // root + node
    expect(edgeStaging.c).toBeGreaterThanOrEqual(1);
  });

  it('staging payloads parse as full row objects with updated_at', async () => {
    tim_import(store, sourcePath);
    const row = store.getDb().prepare(
      "SELECT payload FROM staging WHERE entity_type = 'entry' LIMIT 1",
    ).get() as { payload: string };
    const parsed = JSON.parse(row.payload) as Record<string, unknown>;
    expect(parsed.id).toBeTruthy();
    expect(parsed.title).toBeDefined();
    expect(parsed.updated_at).toBeTruthy();
    expect(parsed.metadata).toBeTruthy();
  });

  it('dry-run writes neither entries nor staging', async () => {
    tim_import(store, sourcePath, { dryRun: true });
    const entries = store.getDb().prepare(
      "SELECT COUNT(*) AS c FROM entries WHERE json_extract(metadata, '$.hmemUid') IS NOT NULL",
    ).get() as { c: number };
    const staging = store.getDb().prepare('SELECT COUNT(*) AS c FROM staging').get() as { c: number };
    expect(entries.c).toBe(0);
    expect(staging.c).toBe(0);
  });
});
```

If `createV2HmemDatabase`'s column set differs from the INSERTs above, adapt the INSERTs to the actual schema it creates (read `packages/tim-migrate/src/hmem-format.ts` first) — do not change the assertions.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/tim-migrate && npx vitest run src/__tests__/import-sync.test.ts`
Expected: FAIL — titles empty, staging count 0.

- [ ] **Step 3: Export splitTitleBody from tim-store**

In `packages/tim-store/src/store.ts`, change the private helper (bottom of file) to `export function splitTitleBody(...)`. In `packages/tim-store/src/index.ts`, add `splitTitleBody` to the exports from `./store.js`. Rebuild: `npm run build`.

- [ ] **Step 4: Rewrite the insert helpers in import.ts**

In `packages/tim-migrate/src/import.ts`, add to the imports:

```typescript
import { splitTitleBody } from 'tim-store';
```

Add a staging helper and rewrite the two direct-insert helpers:

```typescript
/** Re-read the row and enqueue an upsert staging record so imports sync. */
function stageEntryRow(db: Database.Database, id: string): void {
  const row = db.prepare('SELECT * FROM entries WHERE id = ?').get(id) as
    Record<string, unknown> | undefined;
  if (!row) return;
  db.prepare(`INSERT INTO staging (key, entity_type, operation, payload,
    lww_timestamp, lww_device, lww_confidence)
    VALUES (?, 'entry', 'upsert', ?, ?, 'local', ?)`).run(
    id, JSON.stringify(row), Date.now(), Number(row.confidence ?? 1),
  );
}

function insertEntryDirect(
  db: Database.Database,
  params: {
    id: string;
    parentId: string | null;
    content: string;
    depth: number;
    confidence: number;
    createdAt: string;
    accessedAt: string;
    tags: string[];
    irrelevant: boolean;
    favorite: boolean;
    metadata: Record<string, unknown>;
  },
): void {
  const { title, body } = splitTitleBody(params.content);
  db.prepare(`
    INSERT INTO entries (
      id, parent_id, title, content, content_type, depth, confidence,
      created_at, accessed_at, updated_at,
      decay_rate, visibility, tags, irrelevant, favorite, tombstoned_at, metadata
    ) VALUES (?, ?, ?, ?, 'text', ?, ?, ?, ?, ?, 0.0, 1, ?, ?, ?, NULL, ?)
  `).run(
    params.id,
    params.parentId,
    title,
    body,
    params.depth,
    params.confidence,
    params.createdAt,
    params.accessedAt,
    params.accessedAt, // updated_at: best available signal from the source
    JSON.stringify(params.tags),
    params.irrelevant ? 1 : 0,
    params.favorite ? 1 : 0,
    JSON.stringify(params.metadata),
  );
  stageEntryRow(db, params.id);
}

function insertEdgeDirect(
  db: Database.Database,
  sourceId: string,
  targetId: string,
  type: string,
): void {
  const id = ulid();
  const ts = Date.now();
  const updatedAt = new Date(ts).toISOString();
  const result = db.prepare(`
    INSERT OR IGNORE INTO edges (id, source_id, target_id, type, weight, metadata, updated_at)
    VALUES (?, ?, ?, ?, 1.0, '{}', ?)
  `).run(id, sourceId, targetId, type, updatedAt);
  if (result.changes === 0) return; // duplicate — nothing new to sync

  const edgeRow = {
    id, source_id: sourceId, target_id: targetId,
    type, weight: 1.0, metadata: '{}', updated_at: updatedAt,
  };
  db.prepare(`INSERT INTO staging (key, entity_type, operation, payload,
    lww_timestamp, lww_device, lww_confidence)
    VALUES (?, 'edge', 'upsert', ?, ?, 'local', 1.0)`).run(
    `${sourceId}|${targetId}|${type}`, JSON.stringify(edgeRow), ts,
  );
}
```

- [ ] **Step 5: Run tests**

Run: `cd packages/tim-migrate && npx vitest run src/__tests__/import-sync.test.ts && npx vitest run`
Expected: PASS. Existing import tests asserting `content` equals the full original text will fail because content is now body-only — update those expectations to `title` + `content` split semantics (the split is the fix, not a regression).

- [ ] **Step 6: Commit**

```bash
git add packages/tim-store/src/store.ts packages/tim-store/src/index.ts packages/tim-migrate/src/import.ts packages/tim-migrate/src/__tests__/import-sync.test.ts
git commit -m "fix(tim-migrate): imports get titles and staging records (sync-ready)"
```

---

### Task 3: Deduplicating re-import actually writes changed content

**Files:**
- Modify: `packages/tim-migrate/src/import.ts:221-231` (the `deduplicate` branch in `planRoots` of `importV2`)
- Test: extend `packages/tim-migrate/src/__tests__/import-sync.test.ts`

**Background:** On re-import with `deduplicate:true`, `changedCount` is incremented when the source root's content differs from the existing TIM entry — but the new content is never written. Silent data loss on every hmem re-sync.

**Interfaces:**
- Produces: when deduplicating onto an existing label and content changed, the existing entry's `title`/`content`/`updated_at` are updated and a staging record enqueued. `changedCount` reporting unchanged.

- [ ] **Step 1: Write the failing test**

Append to `import-sync.test.ts`:

```typescript
  it('re-import with deduplicate writes changed root content', async () => {
    tim_import(store, sourcePath);

    // Change the source content, then re-import with force+deduplicate.
    const src = new Database(sourcePath);
    src.prepare("UPDATE entries SET level_1 = 'Lesson title line' || char(10) || 'REVISED body' WHERE uid = 'uid-root-1'").run();
    src.close();

    const report = tim_import(store, sourcePath, { deduplicate: true, force: true });
    expect(report.changedCount).toBeGreaterThanOrEqual(1);

    const row = store.getDb().prepare(
      "SELECT content FROM entries WHERE json_extract(metadata, '$.label') = 'L0001' AND tombstoned_at IS NULL",
    ).get() as { content: string };
    expect(row.content).toBe('REVISED body');
  });
```

Note: `force: true` is needed because the hmemUid idempotency guard otherwise short-circuits before the deduplicate branch.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/tim-migrate && npx vitest run src/__tests__/import-sync.test.ts`
Expected: FAIL — content still the original body.

- [ ] **Step 3: Write the changed content in the deduplicate branch**

In `importV2`'s `planRoots`, the current branch reads:

```typescript
      if (existingLabel && options.deduplicate) {
        idMap.set(e.uid, existingLabel);
        mergedRoots.add(e.uid);
        if (contentChanged(store, existingLabel, e.level_1)) {
          changedCount++;
        } else {
          skipped++;
        }
        conflicts.push({ label: e.label, action: 'merged', detail: existingLabel });
        continue;
      }
```

`contentChanged` compares against the stored `content` column, which after Task 2 holds body-only text. First fix the comparison, then write. Replace the branch with:

```typescript
      if (existingLabel && options.deduplicate) {
        idMap.set(e.uid, existingLabel);
        mergedRoots.add(e.uid);
        const { title, body } = splitTitleBody(e.level_1);
        if (contentChanged(store, existingLabel, body)) {
          changedCount++;
          if (!options.dryRun) {
            store.getDb().prepare(
              'UPDATE entries SET title = ?, content = ?, updated_at = ? WHERE id = ?',
            ).run(title, body, new Date().toISOString(), existingLabel);
            stageEntryRow(store.getDb(), existingLabel);
          }
        } else {
          skipped++;
        }
        conflicts.push({ label: e.label, action: 'merged', detail: existingLabel });
        continue;
      }
```

Also delete the now-confirmed-dead `mergedRoots` set if nothing else reads it (grep `mergedRoots` in the file; if only these two lines exist, remove both).

- [ ] **Step 4: Run tests**

Run: `cd packages/tim-migrate && npx vitest run && cd ../.. && npm test`
Expected: PASS across the monorepo.

- [ ] **Step 5: Update docs and commit**

In `docs/tim-capabilities.md` §8, update the "migrate unvollständig" entry: import now writes titles, stages for sync, and merges changed content on re-import; legacy engine deleted.

```bash
git add packages/tim-migrate/src/import.ts packages/tim-migrate/src/__tests__/import-sync.test.ts docs/tim-capabilities.md
git commit -m "fix(tim-migrate): deduplicating re-import writes changed content"
```
