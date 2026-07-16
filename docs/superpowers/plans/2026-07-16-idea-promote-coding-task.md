# Idea Promote + Coding Task Subtype Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ideas get `metadata.idea.status`; setting it to `planned` promotes the same entry in-place into a Task under `Tasks`; coding tasks gain `subtype`/`commits`/`reviewed` plus `changes_pending` and a `needs_review` query filter.

**Architecture:** Pure helpers in `tim-store` (`isIdeaMarker`, `applyIdeaPromote`, `isCodingNeedsReview`) own the rules. `TimStore.updateSync` deep-merges `idea` like `task`, runs promote after merge, and moves the row to the project’s Tasks section in the same transaction. `getTasks` / `tim_show` expose the new filters. Validation stays warning-only.

**Tech Stack:** TypeScript (ESM), Vitest, better-sqlite3 via `TimStore`, MCP `tim_show` in `tim-mcp`. Spec: `docs/superpowers/specs/2026-07-16-idea-promote-coding-task-design.md`.

---

## File responsibility map

| File | Responsibility |
|---|---|
| `packages/tim-core/src/types.ts` | Extend `TaskMetadata`; add `IdeaMetadata`; export via `index.ts` |
| `packages/tim-store/src/metadata-coerce.ts` | Add `isIdeaMarker` |
| `packages/tim-store/src/idea-promote.ts` | **New** — pure `applyIdeaPromote` + `isCodingNeedsReview` |
| `packages/tim-store/src/validate.ts` | Idea + coding warnings |
| `packages/tim-store/src/store.ts` | idea deep-merge; promote+move in `updateSync`; extend `GetTasksOptions` / `getTasks` |
| `packages/tim-store/src/index.ts` | Re-export new helpers |
| `packages/tim-mcp/src/server.ts` | `applyWith`: `needs_review`, `coding` |
| `packages/tim-mcp/src/task-status.ts` | Confirm `changes_pending` stays “open” |
| `docs/project-schema.json` | Document idea + coding task fields |
| `.hermes/skills/tim-new-task/SKILL.md` | Promote + coding agent contract |
| Tests under each package’s `src/__tests__/` | TDD for each slice |
| `packages/*/dist/**` | Rebuild and commit if tracked (this repo commits dist) |

---

### Task 1: Types — IdeaMetadata + TaskMetadata extensions

**Files:**
- Modify: `packages/tim-core/src/types.ts`
- Modify: `packages/tim-core/src/index.ts` (export `IdeaMetadata`)

- [ ] **Step 1: Extend TaskMetadata and add IdeaMetadata**

In `packages/tim-core/src/types.ts`, replace the `TaskMetadata` block and insert `IdeaMetadata` after `BugMetadata`:

```ts
/** Nested task sub-section (Schema v3 Phase 2a). */
export interface TaskMetadata {
  status?: 'todo' | 'in_progress' | 'done' | 'cancelled' | 'changes_pending';
  priority?: 'low' | 'medium' | 'high' | 'critical';
  due_date?: string; // ISO 8601 date
  completion_evidence?: string | null;
  subtype?: 'coding';
  commits?: string[];
  reviewed?: boolean;
}

/** Nested idea sub-section — lifecycle until promote-to-task. */
export interface IdeaMetadata {
  status?: 'new' | 'planned' | 'parked' | 'rejected';
}
```

- [ ] **Step 2: Export IdeaMetadata from tim-core**

In `packages/tim-core/src/index.ts`, add `type IdeaMetadata` to the existing `./types.js` export list next to `TaskMetadata`.

- [ ] **Step 3: Commit**

```bash
git add packages/tim-core/src/types.ts packages/tim-core/src/index.ts
git commit -m "$(cat <<'EOF'
feat(tim-core): add IdeaMetadata and coding task fields

EOF
)"
```

---

### Task 2: isIdeaMarker + isCodingNeedsReview helpers

**Files:**
- Modify: `packages/tim-store/src/metadata-coerce.ts`
- Create: `packages/tim-store/src/idea-promote.ts`
- Modify: `packages/tim-store/src/index.ts`
- Test: `packages/tim-store/src/__tests__/metadata-coerce.test.ts`
- Test: `packages/tim-store/src/__tests__/idea-promote.test.ts` (create)

- [ ] **Step 1: Write failing tests for isIdeaMarker**

Append to `metadata-coerce.test.ts`:

```ts
import { isIdeaMarker } from '../metadata-coerce.js';

describe('isIdeaMarker', () => {
  it('is true for idea objects', () => {
    expect(isIdeaMarker({ status: 'new' })).toBe(true);
  });
  it('is false for true/false/null/arrays/strings', () => {
    expect(isIdeaMarker(true)).toBe(false);
    expect(isIdeaMarker(false)).toBe(false);
    expect(isIdeaMarker(null)).toBe(false);
    expect(isIdeaMarker([])).toBe(false);
    expect(isIdeaMarker('new')).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests — expect fail**

```bash
npm test -w packages/tim-store -- src/__tests__/metadata-coerce.test.ts
```

Expected: FAIL — `isIdeaMarker` not exported.

- [ ] **Step 3: Implement isIdeaMarker**

In `metadata-coerce.ts` (do **not** add `idea` to `BOOLEAN_METADATA_KEYS`):

```ts
/** Idea marker is a nested object only (no boolean shorthand). */
export function isIdeaMarker(value: unknown): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
```

Re-export from `packages/tim-store/src/index.ts`.

- [ ] **Step 4: Write failing tests for isCodingNeedsReview**

Create `packages/tim-store/src/__tests__/idea-promote.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { isCodingNeedsReview } from '../idea-promote.js';

describe('isCodingNeedsReview', () => {
  it('true when coding + commits + not reviewed', () => {
    expect(isCodingNeedsReview({
      task: { subtype: 'coding', commits: ['abc'], reviewed: false },
    })).toBe(true);
  });
  it('false when reviewed true', () => {
    expect(isCodingNeedsReview({
      task: { subtype: 'coding', commits: ['abc'], reviewed: true },
    })).toBe(false);
  });
  it('false when no commits', () => {
    expect(isCodingNeedsReview({
      task: { subtype: 'coding', commits: [], reviewed: false },
    })).toBe(false);
  });
  it('false when not coding subtype', () => {
    expect(isCodingNeedsReview({
      task: { commits: ['abc'], reviewed: false },
    })).toBe(false);
  });
});
```

- [ ] **Step 5: Implement isCodingNeedsReview in idea-promote.ts**

```ts
export function isCodingNeedsReview(metadata: Record<string, unknown>): boolean {
  const task = metadata.task;
  if (typeof task !== 'object' || task === null || Array.isArray(task)) return false;
  const t = task as Record<string, unknown>;
  if (t.subtype !== 'coding') return false;
  if (t.reviewed === true) return false;
  const commits = t.commits;
  return Array.isArray(commits) && commits.length >= 1;
}
```

Export from `index.ts`.

- [ ] **Step 6: Run tests — expect pass**

```bash
npm test -w packages/tim-store -- src/__tests__/metadata-coerce.test.ts src/__tests__/idea-promote.test.ts
```

- [ ] **Step 7: Commit**

```bash
git add packages/tim-store/src/metadata-coerce.ts packages/tim-store/src/idea-promote.ts packages/tim-store/src/index.ts packages/tim-store/src/__tests__/metadata-coerce.test.ts packages/tim-store/src/__tests__/idea-promote.test.ts
git commit -m "$(cat <<'EOF'
feat(tim-store): add isIdeaMarker and needs_review predicate

EOF
)"
```

---

### Task 3: applyIdeaPromote pure function

**Files:**
- Modify: `packages/tim-store/src/idea-promote.ts`
- Test: `packages/tim-store/src/__tests__/idea-promote.test.ts`

- [ ] **Step 1: Write failing promote tests**

Append to `idea-promote.test.ts`:

```ts
import { applyIdeaPromote } from '../idea-promote.js';

describe('applyIdeaPromote', () => {
  it('promotes when idea.status is planned and no task yet', () => {
    const r = applyIdeaPromote({
      type: 'idea',
      idea: { status: 'planned' },
      priority: 'P2',
    });
    expect(r.didPromote).toBe(true);
    expect(r.error).toBeUndefined();
    expect(r.metadata.idea).toBeUndefined();
    expect(r.metadata.type).toBe('task');
    expect(r.metadata.task).toMatchObject({ status: 'todo' });
    expect((r.metadata.provenance as { promoted_from_idea_at?: string }).promoted_from_idea_at)
      .toEqual(expect.any(String));
  });

  it('no-ops when idea.status is not planned', () => {
    const input = { type: 'idea', idea: { status: 'new' } };
    const r = applyIdeaPromote(input);
    expect(r.didPromote).toBe(false);
    expect(r.metadata).toEqual(input);
  });

  it('errors when already a task and idea.status planned', () => {
    const r = applyIdeaPromote({
      type: 'task',
      task: { status: 'todo' },
      idea: { status: 'planned' },
    });
    expect(r.didPromote).toBe(false);
    expect(r.error).toMatch(/already a task/i);
  });

  it('errors when status planned but idea value is not an object marker', () => {
    const r = applyIdeaPromote({
      idea: 'planned',
    } as unknown as Record<string, unknown>);
    expect(r.didPromote).toBe(false);
    expect(r.error).toMatch(/idea/i);
  });

  it('copies nested priority from idea.priority if present', () => {
    const r = applyIdeaPromote({
      idea: { status: 'planned', priority: 'high' },
    });
    expect(r.metadata.task).toMatchObject({ status: 'todo', priority: 'high' });
  });
});
```

- [ ] **Step 2: Run — expect fail**

```bash
npm test -w packages/tim-store -- src/__tests__/idea-promote.test.ts
```

- [ ] **Step 3: Implement applyIdeaPromote**

```ts
import { isIdeaMarker, isTaskMarker } from './metadata-coerce.js';

export interface PromoteResult {
  metadata: Record<string, unknown>;
  didPromote: boolean;
  error?: string;
}

export function applyIdeaPromote(
  metadata: Record<string, unknown>,
  nowIso: string = new Date().toISOString(),
): PromoteResult {
  const idea = metadata.idea;

  if (idea !== undefined && !isIdeaMarker(idea)) {
    if (idea === 'planned' || idea === true) {
      return { metadata, didPromote: false, error: 'Invalid idea marker for promote' };
    }
    return { metadata, didPromote: false };
  }

  if (!isIdeaMarker(idea)) {
    return { metadata, didPromote: false };
  }

  const ideaObj = idea as Record<string, unknown>;
  if (ideaObj.status !== 'planned') {
    return { metadata, didPromote: false };
  }

  if (isTaskMarker(metadata.task)) {
    return { metadata, didPromote: false, error: 'Cannot promote: entry is already a task' };
  }

  const next: Record<string, unknown> = { ...metadata };
  delete next.idea;

  const priorityFromIdea =
    typeof ideaObj.priority === 'string' ? ideaObj.priority : undefined;
  const priorityFromMeta =
    typeof metadata.priority === 'string' ? metadata.priority : undefined;

  const task: Record<string, unknown> = { status: 'todo' };
  if (priorityFromIdea) task.priority = priorityFromIdea;
  else if (priorityFromMeta) task.priority = priorityFromMeta;

  next.task = task;
  next.type = 'task';

  const prevProv =
    typeof metadata.provenance === 'object' && metadata.provenance !== null && !Array.isArray(metadata.provenance)
      ? (metadata.provenance as Record<string, unknown>)
      : {};
  next.provenance = { ...prevProv, promoted_from_idea_at: nowIso };

  return { metadata: next, didPromote: true };
}
```

Keep `isCodingNeedsReview` from Task 2 in the same file.

- [ ] **Step 4: Run — expect pass**

```bash
npm test -w packages/tim-store -- src/__tests__/idea-promote.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add packages/tim-store/src/idea-promote.ts packages/tim-store/src/__tests__/idea-promote.test.ts
git commit -m "$(cat <<'EOF'
feat(tim-store): pure applyIdeaPromote for planned → task

EOF
)"
```

---

### Task 4: Validation warnings for idea + coding

**Files:**
- Modify: `packages/tim-store/src/validate.ts`
- Test: `packages/tim-store/src/__tests__/validate.test.ts`

- [ ] **Step 1: Write failing validation tests**

```ts
import { validateIdeaMetadata, validateTaskMetadata } from '../validate.js';

describe('validateIdeaMetadata', () => {
  it('warns when type=idea but idea sub-section missing', () => {
    expect(validateIdeaMetadata({ type: 'idea' })).toContainEqual(
      expect.stringContaining('idea metadata missing'),
    );
  });
  it('no warnings for idea with status', () => {
    expect(validateIdeaMetadata({ type: 'idea', idea: { status: 'new' } })).toEqual([]);
  });
});

describe('validateTaskMetadata coding', () => {
  it('warns coding done without reviewed', () => {
    const w = validateTaskMetadata({
      type: 'task',
      task: { subtype: 'coding', status: 'done', commits: ['a'], reviewed: false },
    });
    expect(w.some(x => /reviewed/i.test(x))).toBe(true);
  });
  it('warns commits without coding subtype', () => {
    const w = validateTaskMetadata({
      type: 'task',
      task: { status: 'todo', commits: ['a'] },
    });
    expect(w.some(x => /subtype/i.test(x))).toBe(true);
  });
});
```

- [ ] **Step 2: Run — expect fail**

```bash
npm test -w packages/tim-store -- src/__tests__/validate.test.ts
```

- [ ] **Step 3: Implement validators**

Add `validateIdeaMetadata` mirroring `validateRuleMetadata`. Extend `validateTaskMetadata` object branch:

```ts
if (taskObj.subtype === 'coding') {
  if (taskObj.status === 'done' && taskObj.reviewed !== true) {
    warnings.push('reviewed=true recommended before marking coding tasks done');
  }
  if (taskObj.status === 'done' && (!Array.isArray(taskObj.commits) || taskObj.commits.length === 0)) {
    warnings.push('commits recommended for done coding tasks');
  }
} else {
  if (taskObj.commits !== undefined || taskObj.reviewed !== undefined) {
    warnings.push('commits/reviewed are for subtype=coding');
  }
  if (taskObj.status === 'changes_pending') {
    warnings.push('changes_pending is intended for subtype=coding');
  }
}
```

- [ ] **Step 4: Run — expect pass + commit**

```bash
npm test -w packages/tim-store -- src/__tests__/validate.test.ts
git add packages/tim-store/src/validate.ts packages/tim-store/src/__tests__/validate.test.ts
git commit -m "$(cat <<'EOF'
feat(tim-store): validate idea and coding task metadata

EOF
)"
```

---

### Task 5: Wire promote + Tasks move into updateSync

**Files:**
- Modify: `packages/tim-store/src/store.ts` (`updateSync` metadata IIFE ~L1498)
- Test: `packages/tim-store/src/__tests__/idea-promote-store.test.ts` (create)

- [ ] **Step 1: Write failing integration tests**

Create `idea-promote-store.test.ts`. Bootstrap project + Ideas + Tasks using the **same pattern** as `packages/tim-store/src/__tests__/resolve-section.test.ts` (copy its `beforeEach`; do not invent a different schema).

```ts
it('planned idea becomes task under Tasks with same id', async () => {
  const idea = await store.write('Brilliant thing', {
    parentId: ideasSectionId,
    metadata: { type: 'idea', idea: { status: 'new' } },
  });
  const updated = await store.update(idea.id, {
    metadata: { idea: { status: 'planned' } },
  });
  expect(updated.id).toBe(idea.id);
  expect(updated.metadata.idea).toBeUndefined();
  expect(updated.metadata.task).toMatchObject({ status: 'todo' });
  expect(updated.metadata.type).toBe('task');
  expect(updated.parentId).toBe(tasksSectionId);
});

it('already-task + idea.planned throws', async () => {
  const task = await store.write('Existing', {
    parentId: tasksSectionId,
    metadata: { type: 'task', task: { status: 'todo' } },
  });
  await expect(store.update(task.id, {
    metadata: { idea: { status: 'planned' } },
  })).rejects.toThrow(/already a task/i);
});

it('parked does not promote', async () => {
  const idea = await store.write('Park me', {
    parentId: ideasSectionId,
    metadata: { type: 'idea', idea: { status: 'new' } },
  });
  const updated = await store.update(idea.id, {
    metadata: { idea: { status: 'parked' } },
  });
  expect(updated.metadata.idea).toMatchObject({ status: 'parked' });
  expect(updated.metadata.task).toBeUndefined();
  expect(updated.parentId).toBe(ideasSectionId);
});
```

- [ ] **Step 2: Run — expect fail**

```bash
npm test -w packages/tim-store -- src/__tests__/idea-promote-store.test.ts
```

- [ ] **Step 3: Deep-merge idea + call applyIdeaPromote in updateSync**

In the metadata IIFE of `updateSync`, after the existing `task` deep-merge block, add the same pattern for `idea`, then promote:

```ts
if (
  typeof existingMeta.idea === 'object' && existingMeta.idea !== null &&
  typeof patchMeta.idea === 'object' && patchMeta.idea !== null
) {
  patchMeta.idea = {
    ...(existingMeta.idea as Record<string, unknown>),
    ...(patchMeta.idea as Record<string, unknown>),
  };
}
const merged = { ...existingMeta, ...patchMeta };
const promote = applyIdeaPromote(merged);
if (promote.error) {
  throw new Error(promote.error);
}
const finalMeta = promote.metadata;
// existing done/order cleanup operates on finalMeta
// assign didPromote in outer let for parent move
return JSON.stringify(finalMeta);
```

Refactor so `let didPromote = false` lives outside the IIFE and is set from `promote.didPromote`.

- [ ] **Step 4: Move to Tasks when didPromote**

Add private sync helper on `TimStore`:

```ts
private resolveSectionIdByTitleSync(projectLabel: string, title: string): string {
  // Same SQL as resolveSectionByTitle found path; throw if not exactly one match
}
```

When `didPromote`:
1. `const label = this.findProjectLabelForParent(existing.parent_id);` — throw if null.
2. `const tasksId = this.resolveSectionIdByTitleSync(label, 'Tasks');`
3. If `existing.parent_id !== tasksId`, set `parent_id` + `depth = min(parent.depth+1, 5)` on the UPDATE (extend UPDATE SQL columns). Skip move if already under Tasks.

Do **not** call async `resolveSectionByTitle` from `updateSync`.

- [ ] **Step 5: Run — expect pass + commit**

```bash
npm test -w packages/tim-store -- src/__tests__/idea-promote-store.test.ts
git add packages/tim-store/src/store.ts packages/tim-store/src/__tests__/idea-promote-store.test.ts
git commit -m "$(cat <<'EOF'
feat(tim-store): promote planned ideas to tasks on update

EOF
)"
```

---

### Task 6: getTasks filters — subtype + needs_review

**Files:**
- Modify: `packages/tim-store/src/store.ts` (`GetTasksOptions`, `getTasks`)
- Test: extend getTasks coverage in `packages/tim-store/src/__tests__/store.test.ts` or a dedicated file

- [ ] **Step 1: Write failing filter tests**

```ts
it('getTasks filters needs_review coding tasks', async () => {
  const list = await store.getTasks({ needs_review: true });
  expect(list.map(t => t.id)).toContain(codingNeedsReviewId);
  expect(list.map(t => t.id)).not.toContain(plainTaskId);
});

it('getTasks filters subtype coding', async () => {
  const list = await store.getTasks({ subtype: 'coding' });
  expect(list.map(t => t.id)).toContain(codingId);
});

it('getTasks status changes_pending', async () => {
  const list = await store.getTasks({ status: 'changes_pending' });
  expect(list).toHaveLength(1);
});
```

- [ ] **Step 2: Extend GetTasksOptions and filtering**

```ts
export interface GetTasksOptions {
  status?: string;
  subtype?: string;
  needs_review?: boolean;
}
```

In `getTasks`:
- `subtype`: `AND json_extract(e.metadata, '$.task.subtype') = ?`
- `needs_review: true`: post-filter with `isCodingNeedsReview(meta)` after mapping rows (v1-ok; task lists are small)
- Status CASE: add `WHEN 'changes_pending' THEN 0` (same bucket as `in_progress`)

- [ ] **Step 3: Run + commit**

```bash
npm test -w packages/tim-store -- src/__tests__/store.test.ts
git add packages/tim-store/src/store.ts packages/tim-store/src/__tests__/store.test.ts
git commit -m "$(cat <<'EOF'
feat(tim-store): filter tasks by subtype and needs_review

EOF
)"
```

---

### Task 7: tim_show `with=needs_review,coding`

**Files:**
- Modify: `packages/tim-mcp/src/server.ts` (`applyWith`)
- Test: existing tim_show tests under `packages/tim-mcp/src/__tests__/` (find via grep `tim_show` / `applyWith`)

- [ ] **Step 1: Confirm open-filter behavior**

`applyWith` `open` = status not `done`/`cancelled` → **`changes_pending` stays open**. No code change unless a test fails.

- [ ] **Step 2: Write failing show filter tests**

```ts
it('with=needs_review keeps only coding commits unreviewed', async () => { /* … */ });
it('with=coding keeps subtype=coding', async () => { /* … */ });
```

- [ ] **Step 3: Extend applyWith**

```ts
case 'needs_review':
  result = result.filter(e => isCodingNeedsReview(e.metadata));
  break;
case 'coding':
  result = result.filter(e => {
    const task = e.metadata.task;
    return typeof task === 'object' && task !== null
      && (task as { subtype?: string }).subtype === 'coding';
  });
  break;
```

Import `isCodingNeedsReview` from `tim-store`.

- [ ] **Step 4: Run MCP tests + commit**

```bash
npm test -w packages/tim-mcp
git add packages/tim-mcp/src/server.ts packages/tim-mcp/src/__tests__/
git commit -m "$(cat <<'EOF'
feat(tim-mcp): tim_show filters needs_review and coding

EOF
)"
```

---

### Task 8: Docs + skill contract

**Files:**
- Modify: `docs/project-schema.json`
- Modify: `.hermes/skills/tim-new-task/SKILL.md`

- [ ] **Step 1: Update project-schema.json**

Extend `task_annotation.fields.status.values` with `changes_pending`. Add:

```json
"subtype": { "type": "enum", "values": ["coding"], "optional": true },
"commits": { "type": "array", "items": "string", "optional": true },
"reviewed": { "type": "boolean", "optional": true, "default": false }
```

Add sibling `idea_annotation`:

```json
"idea_annotation": {
  "description": "metadata.idea marks an Idea. status=planned promotes in-place to a Task under Tasks.",
  "fields": {
    "status": { "type": "enum", "values": ["new", "planned", "parked", "rejected"], "default": "new" }
  }
}
```

- [ ] **Step 2: Skill section**

In `.hermes/skills/tim-new-task/SKILL.md`:

```markdown
## Promote Idea → Task
Set `metadata.idea.status` to `planned` via `tim_update`. Same entry ID becomes a task under Tasks.

## Coding subtype
For implementation work: `metadata.task.subtype: "coding"`. After commit, append SHAs to `metadata.task.commits` and leave `reviewed: false`. Prefer not setting `done` until review sets `reviewed: true` (rework uses `changes_pending`).
```

- [ ] **Step 3: Commit**

```bash
git add docs/project-schema.json .hermes/skills/tim-new-task/SKILL.md
git commit -m "$(cat <<'EOF'
docs: idea promote and coding task agent contract

EOF
)"
```

---

### Task 9: Rebuild dist + full test gate

**Files:**
- `packages/tim-core/dist/**`, `packages/tim-store/dist/**`, `packages/tim-mcp/dist/**` (tracked in this repo)

- [ ] **Step 1: Build**

```bash
npm run build -w packages/tim-core -w packages/tim-store -w packages/tim-mcp
```

- [ ] **Step 2: Full relevant tests**

```bash
npm test -w packages/tim-core -w packages/tim-store -w packages/tim-mcp
```

Expected: all pass.

- [ ] **Step 3: Commit dist**

```bash
git add packages/tim-core/dist packages/tim-store/dist packages/tim-mcp/dist
git commit -m "$(cat <<'EOF'
build: refresh dist for idea promote and coding tasks

EOF
)"
```

---

## Spec coverage checklist

| Spec requirement | Task |
|---|---|
| `IdeaMetadata` + idea marker | 1, 2 |
| Promote in-place on `planned` | 3, 5 |
| Move to Tasks section | 5 |
| Idempotent / already-task error | 3, 5 |
| Coding `subtype`/`commits`/`reviewed` | 1, 4, 6 |
| `changes_pending` status | 1, 6, 7 |
| `needs_review` query | 2, 6, 7 |
| Validation warnings | 4 |
| Docs / skills | 8 |
| Cron | Non-goal — no task |

## Placeholder / consistency self-review

- No TBD left for v1.
- `applyIdeaPromote` / `isCodingNeedsReview` names stable across tasks.
- Promote errors throw from `updateSync` (agent-visible).
- `open` in `tim_show` includes `changes_pending` via existing not-done/cancelled logic.
