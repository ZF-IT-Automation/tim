# Plan 6: Sync Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the deterministic LWW actually converges with real convergence tests, fix the one remaining divergence hole (timestamp ties resolve against a hardcoded `'local'` device, so each replica keeps its own row), and delete the structurally-dead Merkle code.

**Architecture:** Status check: `resolveLWW` is ALREADY deterministic (write-timestamp + device-id tiebreak, commit 1e8654c) and `entryLocalLwwTimestamp` already uses `updated_at`. Two gaps remain. (1) **Tie divergence:** when comparing a remote record against an existing row, `applyStaging`/`applyRemoteEntry` build the local record with device `'local'` (`store.ts` recordFromPayload call sites, `sync-methods.ts:applyRemoteEntry`) — at equal timestamps, `'local'` vs the remote device compares differently on each replica, so both keep their own version. Fix: persist the winning writer's device on the row (`entries.lww_device`, migration v8) and use it in the comparison. (2) **Dead code:** `buildMerkleTree`/`getMerkleRoot`/`computeDelta`/`isInSync`/`syncCycle`/`mergeStaging` have zero callers outside `tim-sync` — cursor-based pull in `tim-sync-client` is the shipping transport.

**Tech Stack:** TypeScript, better-sqlite3, Vitest.

## Global Constraints

- **Prerequisite: Plan 2 Task 1 (transactional migrations + backup) must be merged** — Task 2 here adds schema migration v8.
- Do NOT move `resolveLWW` in this plan — relocation to tim-core + deleting the tim-sync package is plan 7 (execute plan 6 before plan 7).
- Convergence tests live in tim-store (they exercise `applyStaging`, the real apply path).
- Commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Convergence tests for the invariants that hold today

**Files:**
- Test: `packages/tim-store/src/__tests__/sync-convergence.test.ts` (new)

No production change expected in this task. If any of THESE tests fail, that is an unknown bug: stop, apply superpowers:systematic-debugging, report before touching the implementation. (The known tie-divergence case is deliberately NOT in this task — it is the TDD test of Task 2.)

- [ ] **Step 1: Write the tests**

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TimStore } from '../store.js';
import fs from 'node:fs';

function tmp(name: string): string {
  return `/tmp/tim-conv-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
}

function cleanup(paths: string[]): void {
  for (const p of paths) {
    for (const s of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(p + s); } catch { /* ignore */ }
    }
  }
}

/** Comparable projection — excludes volatile columns (accessed_at etc.). */
function entryRow(store: TimStore, id: string): Record<string, unknown> | undefined {
  return store.getDb().prepare(
    'SELECT id, title, content, irrelevant, tombstoned_at, metadata FROM entries WHERE id = ?',
  ).get(id) as Record<string, unknown> | undefined;
}

describe('sync convergence', () => {
  let a: TimStore; let b: TimStore;
  let pa: string; let pb: string;

  beforeEach(() => {
    pa = tmp('a'); pb = tmp('b');
    a = new TimStore(pa); b = new TimStore(pb);
  });

  afterEach(() => {
    a.close(); b.close();
    cleanup([pa, pb]);
  });

  it('concurrent edits to the same entry converge to the newer write on both replicas', async () => {
    const shared = 'SHARED0000000000000000ENTRY';
    await a.write('From A\nolder', { id: shared });
    await new Promise(r => setTimeout(r, 5)); // strictly newer wall clock
    await b.write('From B\nnewer', { id: shared });

    const fromA = await a.getStaging();
    const fromB = await b.getStaging();
    await b.applyStaging(fromA);
    await a.applyStaging(fromB);

    const rowA = entryRow(a, shared);
    const rowB = entryRow(b, shared);
    expect(rowA).toEqual(rowB);
    expect(rowA!.title).toBe('From B');
  });

  it('apply order does not matter on fresh replicas', async () => {
    const shared = 'SHARED0000000000000000ORDER';
    await a.write('Alpha\nversion', { id: shared });
    await new Promise(r => setTimeout(r, 5));
    await b.write('Beta\nversion', { id: shared });

    const stagingA = await a.getStaging();
    const stagingB = await b.getStaging();

    const p1 = tmp('r1'); const p2 = tmp('r2');
    const r1 = new TimStore(p1); const r2 = new TimStore(p2);
    try {
      await r1.applyStaging(stagingA);
      await r1.applyStaging(stagingB);
      await r2.applyStaging(stagingB);
      await r2.applyStaging(stagingA);
      expect(entryRow(r1, shared)).toEqual(entryRow(r2, shared));
      expect(entryRow(r1, shared)!.title).toBe('Beta');
    } finally {
      r1.close(); r2.close();
      cleanup([p1, p2]);
    }
  });

  it('older remote delete loses against newer local update on both replicas', async () => {
    const shared = 'SHARED00000000000000DELUPD';
    await a.write('Victim\nbody', { id: shared });
    await b.applyStaging(await a.getStaging()); // both replicas have it

    await a.delete(shared, true);             // A tombstones (older write ts)
    await new Promise(r => setTimeout(r, 5));
    await b.update(shared, { content: 'Victim\nsurvives' }); // B updates (newer)

    const delRecords = (await a.getStaging()).filter(r => r.key === shared && r.operation === 'delete');
    const updRecords = (await b.getStaging()).filter(r => r.key === shared && r.operation === 'upsert');
    await b.applyStaging(delRecords);
    await a.applyStaging(updRecords);

    const rowA = entryRow(a, shared);
    const rowB = entryRow(b, shared);
    expect(rowB).toBeDefined();
    expect(rowA?.content ?? null).toEqual(rowB?.content ?? null);
    expect(rowB!.content).toBe('survives');
  });
});
```

Caveat on the delete-vs-update test: `delete(hard)` sets `tombstoned_at` without bumping `updated_at`, so the local comparison timestamp of the tombstoned row is its last content write — if the assertion behaves unexpectedly, inspect `entryLocalLwwTimestamp` semantics for tombstoned rows and report findings rather than force-fitting the assertion.

- [ ] **Step 2: Run**

Run: `cd packages/tim-store && npx vitest run src/__tests__/sync-convergence.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/tim-store/src/__tests__/sync-convergence.test.ts
git commit -m "test(tim-store): sync convergence tests — newer-write wins, order independence, delete-vs-update"
```

---

### Task 2: Fix tie divergence — persist the writer's device on the row

**Files:**
- Modify: `packages/tim-store/src/schema.ts` (append migration v8)
- Modify: `packages/tim-store/src/store.ts` — `RowEntry` interface, `TimStoreOptions`, constructor, `buildEntryRow`, `insertEntrySync`, `applyStaging` (upsert statement + both `recordFromPayload(..., 'local', ...)` call sites), `update()`/`delete()`/`deleteEntrySync()` (set own device on write)
- Modify: `packages/tim-store/src/sync-methods.ts` (`applyRemoteEntry` local record device)
- Test: extend `packages/tim-store/src/__tests__/sync-convergence.test.ts`

**Interfaces:**
- Produces: `entries.lww_device TEXT NOT NULL DEFAULT 'local'` column; `TimStoreOptions.deviceId?: string` (default `'local'`); every local write stamps `lww_device = this.deviceId`; every applied remote record stamps `lww_device = record.lwwDevice`; local comparison records use `existing.lww_device` instead of the `'local'` literal.
- Follow-up wiring (same task): `tim-sync-client` constructs/receives a TimStore — grep its construction sites (`new TimStore(`) across packages and pass the configured device id where one exists (sync config has it); where none exists, the `'local'` default keeps today's behavior.

- [ ] **Step 1: Write the failing test**

Append to `sync-convergence.test.ts`:

```typescript
  it('identical timestamps converge via device-id tiebreak on both replicas', async () => {
    const shared = 'SHARED000000000000000TIEBRK';
    const ts = Date.now();
    const iso = new Date(ts).toISOString();
    const mkRecord = (device: string, title: string) => ({
      key: shared,
      entityType: 'entry' as const,
      operation: 'upsert' as const,
      payload: JSON.stringify({
        id: shared, parent_id: null, title, content: '',
        content_type: 'text', depth: 1, confidence: 1,
        created_at: iso, accessed_at: iso, updated_at: iso,
        decay_rate: 0, visibility: 1, tags: '[]',
        irrelevant: 0, favorite: 0, tombstoned_at: null, metadata: '{}',
        lww_device: device,
      }),
      lwwTimestamp: ts,
      lwwDevice: device,
      lwwConfidence: 1,
      acked: false,
    });

    // Opposite arrival orders on the two replicas.
    await a.applyStaging([mkRecord('device-aaa', 'A version')]);
    await a.applyStaging([mkRecord('device-zzz', 'Z version')]);
    await b.applyStaging([mkRecord('device-zzz', 'Z version')]);
    await b.applyStaging([mkRecord('device-aaa', 'A version')]);

    const rowA = entryRow(a, shared);
    const rowB = entryRow(b, shared);
    expect(rowA!.title).toEqual(rowB!.title);
    expect(rowA!.title).toBe('Z version'); // device-zzz > device-aaa, deterministically
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd packages/tim-store && npx vitest run src/__tests__/sync-convergence.test.ts`
Expected: FAIL — A keeps 'A version' (its existing row compared as device `'local'`, and `'local' > 'device-zzz'` lexicographically), B keeps 'Z version'. This is the divergence bug.

- [ ] **Step 3: Add migration v8**

Append to `MIGRATIONS` in `packages/tim-store/src/schema.ts`:

```typescript
  {
    version: 8,
    sql: `
      ALTER TABLE entries ADD COLUMN lww_device TEXT NOT NULL DEFAULT 'local';
    `
  }
```

- [ ] **Step 4: Thread the device through tim-store**

In `packages/tim-store/src/store.ts`:

1. `RowEntry` interface: add `lww_device: string;`.
2. `TimStoreOptions`: add `/** Stable device id for LWW tiebreaks (sync config). Default 'local'. */ deviceId?: string;` — constructor: `this.deviceId = options.deviceId ?? 'local';` (new private field).
3. `buildEntryRow`: add `lww_device: this.deviceId,` to the entry literal.
4. `insertEntrySync`: add the column to the INSERT statement and value list.
5. `update()`, `delete()`, `deleteEntrySync()`: each UPDATE that stages a new local version also sets `lww_device = ?` with `this.deviceId` (add to the SET list), and the `updated`/payload objects include `lww_device: this.deviceId`.
6. `applyStaging`:
   - The `upsertEntry` prepared statement gains the `lww_device` column; the value is `record.lwwDevice` (NOT the payload's field — the record is authoritative).
   - Both local comparison records replace the `'local'` literal:

```typescript
              const local = recordFromPayload(
                entry.id,
                'entry',
                existing.tombstoned_at ? 'delete' : 'upsert',
                JSON.stringify(existing),
                entryLocalLwwTimestamp(existing),
                String(existing.lww_device ?? 'local'),
                Number(existing.confidence ?? 1),
              );
```

(Same change in the delete branch.)

In `packages/tim-store/src/sync-methods.ts`, `applyRemoteEntry`: same replacement of `'local'` with `String(existing.lww_device ?? 'local')`, and the final upsert must also write `lww_device = lwwDevice` (extend the column list of its INSERT/UPDATE — read the function tail past line 120 for the exact statement).

Edge conflicts keep today's behavior (edges have no stored device; their tie case is a known limitation — note it in the commit message, do not fix here).

- [ ] **Step 5: Wire deviceId at construction sites**

Run: `grep -rn "new TimStore(" packages --include="*.ts" | grep -v dist | grep -v __tests__`
For each site that has access to a sync/device config (tim-sync-client, possibly tim-mcp server bootstrap), pass `{ deviceId }` from that config. Sites without a device concept stay default. List the converted sites in the task report.

- [ ] **Step 6: Run tests — new test passes, suite green**

Run: `cd packages/tim-store && npx vitest run && cd ../.. && npm run build && npm test`
Expected: PASS, including the Task 1 invariants (unchanged semantics for distinct timestamps).

- [ ] **Step 7: Commit**

```bash
git add packages/tim-store packages/tim-sync-client
git commit -m "fix(tim-store): persist lww_device on entries — timestamp ties now converge"
```

---

### Task 3: Delete the dead Merkle/delta code from tim-sync

**Files:**
- Modify: `packages/tim-sync/src/sync.ts` — delete `MerkleNode`, `buildMerkleTree`, `getMerkleRoot`, `computeDelta`, `isInSync`, `syncCycle`, `mergeStaging`, `SyncResult`, and the `merkleRoot` fields of `SyncPushRequest`/`SyncPushResponse`/`SyncPullRequest`/`SyncPullResponse`
- Modify: `packages/tim-sync/src/index.ts` (drop the corresponding exports)
- Modify/Delete: tests under `packages/tim-sync/src/__tests__/` covering the deleted functions (keep the `resolveLWW` tests — they move to tim-core in plan 7)
- Check: `packages/tim-sync-client/src/` — if a `merkleRoot` field is serialized on the wire today, keep the FIELD as optional-deprecated but stop computing it (server compatibility); note in the commit message

- [ ] **Step 1: Confirm the dead-code inventory**

Run: `grep -rn "buildMerkleTree\|getMerkleRoot\|computeDelta\|isInSync\|syncCycle\|mergeStaging\|merkleRoot\|MerkleNode\|SyncResult" packages --include="*.ts" | grep -v dist | grep -v "tim-sync/src"`
Expected: hits only in `tim-sync-client` for request/response interface fields, if any. Record the list.

- [ ] **Step 2: Delete + fix compilation**

Delete the functions and exports; run `npm run build`. Fix `tim-sync-client` compile errors per the check above. Update/delete the affected tim-sync tests.

Bonus cleanup while in the file: `resolveLWW`'s device-tiebreak branches return `reason: 'only_one'` — change those two to a new reason value `'device_tiebreak'`, add it to the `ConflictResolution['reason']` union, and adjust any test asserting the old value. (Plan 7 moves this file to tim-core with the new union — keep them consistent.)

- [ ] **Step 3: Full suite + commit**

Run: `npm run build && npm test`
Expected: PASS.

```bash
git add -A packages/tim-sync packages/tim-sync-client
git commit -m "chore(tim-sync): delete dead Merkle/delta code — cursor pull is the shipping transport"
```
