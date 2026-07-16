# Task Status History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace overwriteable task status + `reviewed` boolean with append-only `metadata.task.history`, hard coding `done` gates (`reviewed` always; `pushed`+commits when `vcs=git`), and rewrite `needs_review` off history — on branch `feature/idea-promote-coding-task`.

**Architecture:** Pure helpers in new `packages/tim-store/src/task-status-history.ts` own append, transition checks, migration, and derived timestamps. `updateSync` deep-merges task fields but **never replaces `history`**; a status change in the patch becomes an append. VCS is detected once via worktree check (not “git installed”) and stored on `task.vcs`. Idea promote seeds `history: [{ status:'todo', at }]`.

**Tech Stack:** TypeScript ESM, Vitest, TimStore `updateSync`, existing `idea-promote.ts` / MCP `applyWith`. Spec: `docs/superpowers/specs/2026-07-16-task-status-history-design.md`.

**Work from:** `/home/bbbee/projects/tim/.worktrees/idea-promote-coding-task` on `feature/idea-promote-coding-task`.

---

## File responsibility map

| File | Responsibility |
|---|---|
| `packages/tim-core/src/types.ts` | `TaskStatusEvent`, extend `TaskMetadata` (`history`, `vcs`, status union incl. `pushed`/`reviewed`); remove `reviewed?: boolean` |
| `packages/tim-core/src/index.ts` | Export `TaskStatusEvent` |
| `packages/tim-store/src/task-status-history.ts` | **New** — append, validate transitions, migrate, derive times, `isCodingNeedsReview` (move/rewrite from idea-promote) |
| `packages/tim-store/src/vcs.ts` | **New** — `detectProjectVcs(projectPath): 'git' \| 'none'` via `git rev-parse --is-inside-work-tree` |
| `packages/tim-store/src/idea-promote.ts` | Seed `history` on promote; stop setting only bare `status` |
| `packages/tim-store/src/store.ts` | Wire append + lazy migrate + optional vcs set in `updateSync` / write paths |
| `packages/tim-store/src/validate.ts` | History-aware warnings; deprecate boolean `reviewed` |
| `packages/tim-mcp/src/server.ts` / tests | `needs_review` still uses shared helper (behavior change only) |
| `docs/project-schema.json`, `CHANGELOG.md`, `~/.hermes/skills/tim-new-task/SKILL.md` | Agent contract |
| Tests under `packages/tim-store/src/__tests__/` | TDD per task |

---

### Task 1: Types — TaskStatusEvent + TaskMetadata history/vcs

**Files:**
- Modify: `packages/tim-core/src/types.ts`
- Modify: `packages/tim-core/src/index.ts`

- [ ] **Step 1: Replace TaskMetadata block**

```ts
export type TaskStatusValue =
  | 'todo'
  | 'in_progress'
  | 'changes_pending'
  | 'pushed'
  | 'reviewed'
  | 'done'
  | 'cancelled';

export interface TaskStatusEvent {
  status: TaskStatusValue;
  at: string; // ISO 8601
  by?: string;
  note?: string;
}

export interface TaskMetadata {
  /** Cache of last history entry status */
  status?: TaskStatusValue;
  /** Append-only status log */
  history?: TaskStatusEvent[];
  priority?: 'low' | 'medium' | 'high' | 'critical';
  due_date?: string;
  completion_evidence?: string | null;
  subtype?: 'coding';
  commits?: string[];
  /** Set once: git worktree vs not. Not "git installed". */
  vcs?: 'git' | 'none';
}
```

Remove `reviewed?: boolean`.

- [ ] **Step 2: Export** `TaskStatusEvent`, `TaskStatusValue` from `packages/tim-core/src/index.ts`.

- [ ] **Step 3: Commit**

```bash
git add packages/tim-core/src/types.ts packages/tim-core/src/index.ts
git commit -m "$(cat <<'EOF'
feat(tim-core): task status history and vcs fields

EOF
)"
```

---

### Task 2: Pure helpers — task-status-history.ts

**Files:**
- Create: `packages/tim-store/src/task-status-history.ts`
- Create: `packages/tim-store/src/__tests__/task-status-history.test.ts`
- Modify: `packages/tim-store/src/index.ts` (re-export)
- Modify: `packages/tim-store/src/idea-promote.ts` — remove old `isCodingNeedsReview`; re-export from history module OR update imports

- [ ] **Step 1: Write failing tests** covering:

1. `migrateTaskHistory` — bare `{ status:'todo' }` → history one event; `reviewed:true` → adds reviewed event; strips boolean  
2. `appendTaskStatus` — two appends → length 2; cache status = last  
3. Reject coding `done` without reviewed in history  
4. Reject coding `done` when `changes_pending` is after latest `reviewed`  
5. Reject coding+`vcs:git` `done` without `pushed` or empty commits  
6. Allow coding+`vcs:none` `reviewed` then `done` without commits  
7. Allow non-coding `in_progress` → `done` without reviewed  
8. `deriveStartedAt` / `deriveFinishedAt`  
9. `isCodingNeedsReview` — history-based (commits OR vcs none; no reviewed after latest changes_pending; not done/cancelled)

- [ ] **Step 2: Implement** (minimal API):

```ts
export function getTaskHistory(task: Record<string, unknown>): TaskStatusEvent[];
export function migrateTaskHistory(task: Record<string, unknown>, nowIso?: string): Record<string, unknown>;
export function appendTaskStatus(
  task: Record<string, unknown>,
  status: TaskStatusValue,
  opts?: { at?: string; by?: string; note?: string },
): { task: Record<string, unknown>; error?: string };
export function deriveStartedAt(task: Record<string, unknown>): string | null;
export function deriveFinishedAt(task: Record<string, unknown>): string | null;
export function isCodingNeedsReview(metadata: Record<string, unknown>): boolean;
```

**done-gate (coding) inside `appendTaskStatus` when status==='done':**
- Latest `reviewed` exists and no `changes_pending` after it  
- If `vcs === 'git'`: also require `has_pushed` and `commits.length ≥ 1`  
- If `vcs` unset: apply **lenient** mode — only enforce `reviewed` gate (warn path is validate.ts); still reject missing reviewed  

**`isCodingNeedsReview` v1:**
```ts
subtype === 'coding'
&& current ∉ {'done','cancelled'}
&& (commits.length ≥ 1 || vcs === 'none')
&& (no reviewed after latest changes_pending)
// equivalent: !hasFreshReview where fresh = reviewed exists and index(reviewed) > index(last changes_pending)
```

For `vcs` unset and no commits: return false (nothing to queue) unless you treat unset like none — **v1: unset + no commits → false**.

- [ ] **Step 3: Point `idea-promote.ts`** — delete local `isCodingNeedsReview`; export it only from `task-status-history.ts`. Update `index.ts` exports. Fix any imports that pointed at idea-promote for the helper.

- [ ] **Step 4: Run tests + commit**

```bash
npm test -w packages/tim-store -- src/__tests__/task-status-history.test.ts src/__tests__/idea-promote.test.ts
git add packages/tim-store/src/task-status-history.ts packages/tim-store/src/__tests__/task-status-history.test.ts packages/tim-store/src/idea-promote.ts packages/tim-store/src/index.ts
git commit -m "$(cat <<'EOF'
feat(tim-store): append-only task status history helpers

EOF
)"
```

---

### Task 3: VCS detection helper

**Files:**
- Create: `packages/tim-store/src/vcs.ts`
- Create: `packages/tim-store/src/__tests__/vcs.test.ts`
- Modify: `packages/tim-store/src/index.ts`

- [ ] **Step 1: Failing tests**

```ts
it('returns git inside a work tree', () => {
  expect(detectProjectVcs(repoRoot)).toBe('git');
});
it('returns none for a non-repo temp dir', () => {
  const dir = fs.mkdtempSync(...);
  expect(detectProjectVcs(dir)).toBe('none');
  fs.rmSync(dir, { recursive: true });
});
```

Use `execFileSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: projectPath, stdio: ['ignore','pipe','ignore'] })` — on failure → `'none'`. Do **not** check whether git binary exists separately beyond spawn failure → `'none'`.

- [ ] **Step 2: Implement + commit**

```bash
npm test -w packages/tim-store -- src/__tests__/vcs.test.ts
git add packages/tim-store/src/vcs.ts packages/tim-store/src/__tests__/vcs.test.ts packages/tim-store/src/index.ts
git commit -m "$(cat <<'EOF'
feat(tim-store): detect project vcs via git worktree check

EOF
)"
```

---

### Task 4: Wire append + migrate into updateSync

**Files:**
- Modify: `packages/tim-store/src/store.ts` (`updateSync` task deep-merge region)
- Create/extend: `packages/tim-store/src/__tests__/task-status-history-store.test.ts`

- [ ] **Step 1: Integration tests**

```ts
it('appending status twice grows history', async () => {
  // write task with task:{status:'todo'} or history seeded
  await store.update(id, { metadata: { task: { status: 'in_progress' } } });
  await store.update(id, { metadata: { task: { status: 'done' } } }); // non-coding
  const e = await store.read(id);
  expect(e.metadata.task.history).toHaveLength(3); // todo + in_progress + done (if create seeded) or 2
  expect(e.metadata.task.status).toBe('done');
});

it('coding done without reviewed throws', async () => {
  await expect(store.update(codingId, { metadata: { task: { status: 'done' } } }))
    .rejects.toThrow(/reviewed/i);
});

it('coding vcs none reviewed then done ok', async () => { /* … */ });

it('coding vcs git done without pushed throws', async () => { /* … */ });
```

Bootstrap like `idea-promote-store.test.ts`.

- [ ] **Step 2: In `updateSync` after task object deep-merge**

Logic sketch:

```ts
let taskObj = merged.task as Record<string, unknown>;
taskObj = migrateTaskHistory(taskObj, now);

// Preserve existing history array: if patch.task.history provided, IGNORE replace
// (or only allow append via status field). Spec: never replace history via patch.
if (patch had task.history) { /* drop patch history; keep migrated */ }

const prevStatus = /* cache or last history */;
const nextStatus = patchMeta.task?.status; // from raw patch before merge if status key present

if (typeof nextStatus === 'string' && nextStatus !== prevStatus) {
  const result = appendTaskStatus(taskObj, nextStatus as TaskStatusValue, { at: now });
  if (result.error) throw new Error(result.error);
  taskObj = result.task;
}

// Set vcs once if unset and subtype coding and we have a projectPath option
// TimStore may not have cwd — accept opts later or set only when patch.task.vcs provided in v1 wire
// Minimum v1: if patch.task.vcs set, keep; if unset and coding, leave unset (lenient)

merged.task = taskObj;
```

**Important:** Deep-merge today copies `status` from patch onto task, which **overwrites**. After merge, detect status change and rebuild via `appendTaskStatus` from **pre-merge** task history + new status (do not trust merged history length). Pattern:

1. Start from `migrateTaskHistory(existingTask)`  
2. Merge non-status fields from patch (priority, commits, subtype, vcs, …)  
3. If patch contains `status`, call `appendTaskStatus`  
4. Assign result to `merged.task`

- [ ] **Step 3: Optional writeSync** — new tasks with `task.status` seed `history: [{status, at}]`.

- [ ] **Step 4: Run store tests + commit**

```bash
npm test -w packages/tim-store -- src/__tests__/task-status-history-store.test.ts src/__tests__/idea-promote-store.test.ts
git add packages/tim-store/src/store.ts packages/tim-store/src/__tests__/task-status-history-store.test.ts
git commit -m "$(cat <<'EOF'
feat(tim-store): append task status on update instead of overwrite

EOF
)"
```

---

### Task 5: Idea promote seeds history

**Files:**
- Modify: `packages/tim-store/src/idea-promote.ts`
- Modify: `packages/tim-store/src/__tests__/idea-promote.test.ts`
- Modify: `packages/tim-store/src/__tests__/idea-promote-store.test.ts`

- [ ] **Step 1: Change promote task seed**

```ts
const task: Record<string, unknown> = {
  status: 'todo',
  history: [{ status: 'todo', at: nowIso }],
};
```

- [ ] **Step 2: Assert in unit + store tests** `metadata.task.history[0].status === 'todo'`.

- [ ] **Step 3: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(tim-store): seed task history on idea promote

EOF
)"
```

---

### Task 6: Set vcs on coding touch (when path known)

**Files:**
- Modify: `packages/tim-store/src/store.ts` and/or write/update options
- Test: `task-status-history-store.test.ts` or `vcs` integration

**v1 approach (pragmatic):**

- If `patch.metadata.task.vcs` is provided, store it (agent/MCP can pass).  
- Add optional `WriteOptions` / update context `projectPath?: string`. When present and `subtype==='coding'` and `vcs` unset → `detectProjectVcs(projectPath)`.  
- MCP `tim_update`: if session has cwd / project path from binding, pass it into store update when available; if not available in MCP today, document that agents should set `task.vcs` explicitly OR we only auto-detect in CLI later.

**Minimum acceptance for this task:**
- Unit: given `projectPath` pointing at repo, first coding update sets `vcs:'git'`.  
- Unit: temp dir → `vcs:'none'`.  
- If wiring MCP path is blocked, implement store option only and note MCP follow-up in commit message — still required that append gates honor stored `vcs`.

- [ ] **Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(tim-store): set task.vcs from project path when coding

EOF
)"
```

---

### Task 7: Validation + needs_review consumers

**Files:**
- Modify: `packages/tim-store/src/validate.ts` + tests  
- Modify: MCP tests if they set `reviewed: true` boolean — switch to history events  
- Grep branch for `reviewed:` and fix call sites/tests

- [ ] **Step 1: validateTaskMetadata**
  - Warn if `reviewed` boolean present (deprecated)  
  - Warn coding `done` cache without fresh reviewed in history (defense in depth; store should already throw)  
  - Remove old “reviewed=true recommended” boolean check  

- [ ] **Step 2: Update all tests** that used `reviewed: false/true` to use history statuses / append sequence.

- [ ] **Step 3: Run**

```bash
npm test -w packages/tim-store -w packages/tim-mcp
```

- [ ] **Step 4: Commit**

```bash
git commit -m "$(cat <<'EOF'
feat(tim-store): history-aware validation and needs_review migration

EOF
)"
```

---

### Task 8: Docs — schema, changelog, skill

**Files:**
- `docs/project-schema.json`  
- `CHANGELOG.md`  
- `/home/bbbee/.hermes/skills/tim-new-task/SKILL.md` (canonical; keep `.hermes` symlink)  
- Copy design into worktree if missing: `docs/superpowers/specs/2026-07-16-task-status-history-design.md`

- [ ] Update schema: `history` array, status enum includes `pushed`/`reviewed`, `vcs`, remove boolean reviewed.  
- [ ] CHANGELOG Unreleased: append-only history; done gates; git-conditional push/commits.  
- [ ] Skill sections: explain append; `done` only after `reviewed`; set `vcs` / auto-detect; push status when git repo.

- [ ] **Commit**

```bash
git commit -m "$(cat <<'EOF'
docs: task status history agent contract

EOF
)"
```

---

### Task 9: Dist rebuild + full gate

```bash
npm run build -w packages/tim-core -w packages/tim-store -w packages/tim-mcp
npm test -w packages/tim-core -w packages/tim-store -w packages/tim-mcp
git add -f packages/tim-core/dist packages/tim-store/dist packages/tim-mcp/dist
git commit -m "$(cat <<'EOF'
build: refresh dist for task status history

EOF
)"
```

---

## Spec coverage checklist

| Spec item | Task |
|---|---|
| `history` + status cache types | 1 |
| append / migrate / derive / needs_review helpers | 2 |
| VCS detect worktree | 3 |
| updateSync append + reject illegal done | 4 |
| Promote seeds history | 5 |
| Set `vcs` when path known | 6 |
| Validation + test migration off boolean | 7 |
| Docs / skill / changelog | 8 |
| Dist + CI gate | 9 |
| Idea promote unchanged aside from history seed | 5 |

## Self-review notes

- `history` in patch must not clobber — implementers must follow Task 4 merge order.  
- Boolean `reviewed` removed from types; grep-clean the branch.  
- Lenient when `vcs` unset: still require `reviewed` before coding `done`; do not require `pushed`.  
- Do not restore vendored `.hermes/skills/tim-new-task` — edit global skill via symlink.
