# Plan 7: Package Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the empty `tim-search` package, dissolve `tim-sync` (its only externally-used export `resolveLWW` moves to `tim-core`), and move `project-output.ts` presentation code from `tim-store` to `tim-mcp` — fixing the wrong task-badge field on the way.

**Architecture:** Pure deletion and relocation, no new behavior except the one-line badge fix. **Important deviation from the rough plan:** `tim-sync` is NOT merged into `tim-sync-client` — `tim-store` imports `resolveLWW` from `tim-sync`, and `tim-sync-client` depends on `tim-store`, so merging that direction creates a dependency cycle. `resolveLWW` goes to `tim-core` (leaf package, already a dependency of everything), then `tim-sync` is deleted.

**Tech Stack:** TypeScript monorepo (npm workspaces, tsc project references), Vitest.

## Global Constraints

- Prerequisite: plan 6 Task 2 (Merkle deletion) has landed — `tim-sync` then contains only `resolveLWW`, `ConflictResolution`, and the protocol interfaces.
- After each deletion: `npm install` (refresh the lockfile), `npm run build`, `npm test` — all green before commit.
- Update the architecture/package list in `docs/tim-capabilities.md` §7 and README in the same commits.
- Commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Move resolveLWW to tim-core, delete the tim-sync package

**Files:**
- Create: `packages/tim-core/src/lww.ts`
- Modify: `packages/tim-core/src/index.ts` (re-export)
- Modify importers: `packages/tim-store/src/store.ts:15`, `packages/tim-store/src/sync-methods.ts:2`, `packages/tim-sync-client/src/sync.ts:8` — change `from 'tim-sync'` to `from 'tim-core'`
- Move tests: `resolveLWW` unit tests from `packages/tim-sync/src/__tests__/` to `packages/tim-core/src/__tests__/lww.test.ts`
- Relocate interfaces: `SyncPushRequest`/`SyncPushResponse`/`SyncPullRequest`/`SyncPullResponse` — grep who uses them (`grep -rn "SyncPushRequest\|SyncPullRequest\|SyncPushResponse\|SyncPullResponse" packages --include="*.ts" | grep -v dist`); if only `tim-sync-client`, move them into `packages/tim-sync-client/src/` (e.g. `protocol.ts`); if unused, delete
- Delete: `packages/tim-sync/` (entire directory)
- Modify: `packages/tim-store/package.json`, `packages/tim-sync-client/package.json` (remove `"tim-sync": "*"` deps), root `tsconfig` project references if `tim-sync` is listed

- [ ] **Step 1: Create tim-core/src/lww.ts**

Move the code verbatim from `packages/tim-sync/src/sync.ts` (post-plan-6 state):

```typescript
// Deterministic last-writer-wins conflict resolution.
// Strategy: higher lwwTimestamp wins; on tie, lexicographically higher
// lwwDevice wins. Purely deterministic — no wall-clock decay, no
// confidence weighting. Lives in tim-core because both tim-store (apply
// path) and tim-sync-client (transport) need it.

import type { StagingRecord } from './index.js';

export interface ConflictResolution {
  winner: StagingRecord;
  loser: StagingRecord | null;
  reason: 'newer_timestamp' | 'device_tiebreak' | 'only_one';
}

export function resolveLWW(a: StagingRecord, b: StagingRecord): ConflictResolution {
  if (a.lwwTimestamp > b.lwwTimestamp) {
    return { winner: a, loser: b, reason: 'newer_timestamp' };
  }
  if (b.lwwTimestamp > a.lwwTimestamp) {
    return { winner: b, loser: a, reason: 'newer_timestamp' };
  }
  if (a.lwwDevice > b.lwwDevice) {
    return { winner: a, loser: b, reason: 'device_tiebreak' };
  }
  if (b.lwwDevice > a.lwwDevice) {
    return { winner: b, loser: a, reason: 'device_tiebreak' };
  }
  return { winner: a, loser: b, reason: 'only_one' };
}
```

Adjust the `StagingRecord` import to wherever the type actually lives in tim-core (grep `interface StagingRecord` in `packages/tim-core/src/`) — avoid importing from `./index.js` if that creates a cycle with the re-export; import from the defining module directly.

Add to `packages/tim-core/src/index.ts`:

```typescript
export { resolveLWW } from './lww.js';
export type { ConflictResolution } from './lww.js';
```

- [ ] **Step 2: Repoint the three importers, move tests**

Change the three import lines to `from 'tim-core'`. Move the resolveLWW test cases into `packages/tim-core/src/__tests__/lww.test.ts` (adjust import path only).

- [ ] **Step 3: Delete the package**

```bash
git rm -r packages/tim-sync
```

Remove `"tim-sync": "*"` from `packages/tim-store/package.json` and `packages/tim-sync-client/package.json`. Check root `tsconfig.json` / per-package `tsconfig.json` `references` arrays for `tim-sync` entries and remove them. Then:

Run: `npm install && npm run build && npm test`
Expected: green. Any remaining `from 'tim-sync'` import is a compile error — fix by repointing.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor!: move resolveLWW to tim-core, delete tim-sync package"
```

---

### Task 2: Delete the empty tim-search package

**Files:**
- Delete: `packages/tim-search/` (contains only `package.json` + `tsconfig.json`, no src)
- Modify: `packages/tim-cli/package.json:21`, `packages/tim-mcp/package.json:16` (remove `"tim-search": "*"`), root tsconfig references if present

- [ ] **Step 1: Confirm emptiness and delete**

Run: `ls -la packages/tim-search/` — expect only package.json, tsconfig.json. Then:

```bash
git rm -r packages/tim-search
```

Remove the two dependency lines; check tsconfig references.

- [ ] **Step 2: Verify + commit**

Run: `npm install && npm run build && npm test`
Expected: green.

```bash
git add -A
git commit -m "chore: delete empty tim-search package (FTS lives in tim-store; revisit at vector-search time)"
```

---

### Task 3: Move project-output.ts to tim-mcp, fix the task badge field

**Files:**
- Move: `packages/tim-store/src/project-output.ts` → `packages/tim-mcp/src/project-output.ts`
- Move tests: `packages/tim-store/src/__tests__/project-output.test.ts` and `packages/tim-store/src/__tests__/render-depth.test.ts` → `packages/tim-mcp/src/__tests__/` (adjust imports); `packages/tim-store/src/__tests__/store.test.ts` imports `formatProjectOutput` too — move only the affected test block(s), keep the rest
- Modify: `packages/tim-store/src/index.ts:18` (remove the project-output exports), `packages/tim-mcp/src/server.ts:19` (import from `./project-output.js` instead of `tim-store`)

**Badge fix (while the file is in hand):** `entryBadge` at project-output.ts:118-121 reads `metadata.status`; canonical task status is `metadata.task.status` (see `getTasks` in store.ts which COALESCEs `$.task.status` then `$.status`).

- [ ] **Step 1: Write the failing badge test (at the new location)**

In the moved `packages/tim-mcp/src/__tests__/project-output.test.ts`, add:

```typescript
it('task badge reads metadata.task.status, falling back to metadata.status', () => {
  // Build a LoadProjectResult fixture the way the existing tests in this
  // file do, with one child entry whose metadata is:
  //   { task: { status: 'in_progress' }, kind: 'task' }
  // and one with { task: true, status: 'done' }.
  const out = formatProjectOutput(fixture, 200, schemaFixture, 'load');
  expect(out).toContain('[in_progress]');
  expect(out).toContain('[done]');
  expect(out).not.toContain('[todo]'); // neither entry is todo
});
```

(Reuse the fixture-building helpers already present in the file; only the metadata shapes above are new.)

- [ ] **Step 2: Do the move**

```bash
git mv packages/tim-store/src/project-output.ts packages/tim-mcp/src/project-output.ts
git mv packages/tim-store/src/__tests__/project-output.test.ts packages/tim-mcp/src/__tests__/project-output.test.ts
git mv packages/tim-store/src/__tests__/render-depth.test.ts packages/tim-mcp/src/__tests__/render-depth.test.ts
```

Fix imports: the moved file imports types (`Entry`, `LoadProjectResult`, …) — repoint to `tim-store`/`tim-core` package imports instead of relative paths. Remove the `project-output.js` export block from `packages/tim-store/src/index.ts`. In `server.ts`, import `formatProjectOutput` (and whatever else line 19's block pulled from project-output) from `'./project-output.js'`.

Move any `formatProjectOutput` test block out of `packages/tim-store/src/__tests__/store.test.ts` into the moved test file.

- [ ] **Step 3: Fix the badge**

In the moved `project-output.ts`, replace the status read in `entryBadge` (~former line 118-121):

```typescript
  const task = entry.metadata.task;
  const taskStatus =
    typeof task === 'object' && task !== null && !Array.isArray(task)
      ? (task as Record<string, unknown>).status
      : undefined;
  const status = (taskStatus ?? entry.metadata.status) as string | undefined;
```

(Adapt variable names to the actual function body — the rule is: `metadata.task.status` first, `metadata.status` as legacy fallback.)

- [ ] **Step 4: Verify + commit**

Run: `npm install && npm run build && npm test`
Expected: green, including the new badge test.

```bash
git add -A
git commit -m "refactor(tim-mcp): move project-output presentation out of tim-store; fix task badge to read metadata.task.status"
```

---

### Task 4: Update architecture docs

**Files:**
- Modify: `docs/tim-capabilities.md` §7 (package list: 10 → 7 packages), `README.md` (if it lists packages), `CHANGELOG.md` `[Unreleased]`

- [ ] **Step 1: Rewrite the package table**

Remaining packages: tim-core, tim-store, tim-mcp, tim-cli, tim-hooks, tim-summarizer, tim-sync-client, tim-migrate. Note in the doc: FTS lives in tim-store (tim-search deleted until vector search is real); LWW lives in tim-core; presentation lives in tim-mcp.

- [ ] **Step 2: Commit**

```bash
git add docs/tim-capabilities.md README.md CHANGELOG.md
git commit -m "docs: architecture reflects package cleanup (tim-search/tim-sync removed)"
```
