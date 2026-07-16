# Idea Lifecycle Promote + Coding Task Subtype

**Date:** 2026-07-16  
**Status:** Approved — plan at `docs/superpowers/plans/2026-07-16-idea-promote-coding-task.md`  
**Related Ideas:** P0063/Ideas — *Task-Subtype coding: commits + reviewed*; *Idea-Lifecycle: Status planned → Auto-Promote zu Task*

## Problem

TIM treats Ideas and Tasks as loosely related conventions (section placement + optional
`metadata.type` / `metadata.task` marker), not as a typed lifecycle:

1. Promoting an Idea to a Task is manual (copy, rewrite markers, hope the agent remembers).
2. Coding work has no first-class place for commit SHAs or review state, so “done” can mean
   “committed” or “reviewed” depending on who last touched the node.
3. There is no queue signal for “has commits, needs review”.

These two gaps share one schema extension surface (`metadata.idea` / `metadata.task`) and
should ship as one design so Promote and Coding-Review do not invent competing status models.

## Goals

1. Give Ideas a nested status lifecycle parallel to `metadata.task` / `metadata.bug`.
2. On Idea status → `planned`, **promote in place** (same entry ID): strip idea marker, add
   task marker, move into the project’s `Tasks` section.
3. Extend tasks with optional `subtype: 'coding'`, `commits[]`, and `reviewed`.
4. Add task status `changes_pending` for post-review rework.
5. Expose a store/MCP-queryable **needs_review** signal for coding tasks with commits and
   `reviewed !== true`.
6. Keep v1 operable via existing `tim_write` / `tim_update` (no new MCP tool required).

## Non-Goals

- Additional subtypes beyond `coding`.
- Automated review Cron / Worker spawn (Phase 2+; v1 only schema + query).
- Idea↔Task link graph (`promoted_from` edges) — in-place promote makes this unnecessary.
- Reverse promote (Task → Idea).
- Changing commit tree / `tim_record_commit` semantics (commits on tasks are SHA references,
  not `kind: 'commit'` nodes).
- Migrating historical Ideas that used only section placement without `metadata.idea`.

## Approaches Considered

| Approach | Summary | Decision |
|---|---|---|
| **1 Nested markers** | `metadata.idea.status` + extend `metadata.task` | **Chosen** — matches Schema v3 |
| **2 Boolean-only** | `planned: true` on ideas | Rejected — no parked/rejected |
| **3 Tags-only** | `#planned` / `#coding` conventions | Rejected — fragile, weak queries |

**Promote shape:** User chose **B — in-place transform** (not copy+link, not tombstone).

## Design

### Lifecycle

```text
Idea (new | parked | rejected)
        │  status → planned
        ▼
   [in-place promote — same ID]
        ▼
Task (todo → in_progress → done | cancelled | changes_pending)
        │  if subtype=coding
        ▼
  commits[] written, reviewed=false  →  needs_review queue
        ├─ review OK  → reviewed=true, status=done
        └─ review FAIL → status=changes_pending, reviewed=false
```

### Idea schema

While the entry is an Idea:

```ts
metadata.idea = {
  status: 'new' | 'planned' | 'parked' | 'rejected'; // default 'new' when marker present
};
// Prefer metadata.type = 'idea' when writing new ideas (already a builtin type).
```

**Marker rule:** An idea is recognized when `metadata.idea` is present (object), analogous to
`isTaskMarker()` for tasks. Section `Ideas` remains the default placement, not the identity.

`planned` is a **transition trigger**, not a durable end state. After successful promote, the
entry no longer carries `metadata.idea`.

### Task schema (extensions)

```ts
interface TaskMetadata {
  status?: 'todo' | 'in_progress' | 'done' | 'cancelled' | 'changes_pending';
  priority?: 'low' | 'medium' | 'high' | 'critical';
  due_date?: string;
  completion_evidence?: string | null;
  // existing runtime: order?

  subtype?: 'coding';
  commits?: string[];   // git SHAs; append-only by convention
  reviewed?: boolean;   // coding: default false when subtype set and field omitted
}
```

**Validation warnings (non-fatal, consistent with current task validator style):**

- `subtype: 'coding'` without `commits` while `status === 'done'` → warn (prefer evidence).
- `subtype: 'coding'` + `status === 'done'` + `reviewed !== true` → warn.
- `commits` / `reviewed` set without `subtype: 'coding'` → warn (fields ignored by queue).
- `changes_pending` without `subtype: 'coding'` → warn (allowed but odd).

### Promote semantics (in-place)

Triggered inside store update when a patch sets `metadata.idea.status` to `'planned'` on an
entry that is currently an idea (has `metadata.idea`) and is **not** already a task.

Atomic logical steps (one update transaction):

1. Preserve entry **id**, title, body, tags (except type-ish tags if any), confidence, etc.
2. Remove `metadata.idea`.
3. Set `metadata.type` to `'task'` (if type was `'idea'` or missing).
4. Set `metadata.task` to `{ status: 'todo', … }` — copy `priority` from
   `metadata.priority` / idea-level priority if present; do not invent due dates.
5. Move parent to the project’s **Tasks** section (same mechanism as `tim_move_entry` /
   store move). If already under Tasks, skip move.
6. Optional provenance stub (keep minimal):
   `metadata.provenance = { …existing, promoted_from_idea_at: <ISO> }` — do **not** require
   a separate link table.

**Idempotency / guards:**

- Entry already has `metadata.task` → do not re-promote; if patch also sets idea.status
  planned, reject or no-op with clear error (“already a task”).
- Entry lacks `metadata.idea` but patch sets `idea.status: planned` → treat as invalid idea
  promote (error), not silent create.
- Setting idea status to `parked` / `rejected` / `new` → no promote.
- Writing a brand-new entry with `idea.status: planned` in one `tim_write` → promote runs
  after create (or create directly as task); preferred: **write as idea then update**, or
  allow write-with-planned to land as task in Tasks immediately (same end state).

### Coding review loop

| Condition | Meaning |
|---|---|
| `task.subtype === 'coding'` ∧ `(commits?.length ?? 0) ≥ 1` ∧ `reviewed !== true` | **needs_review** |
| Review pass | `reviewed: true`, `status: 'done'`, optional `completion_evidence` = primary SHA |
| Review fail | `status: 'changes_pending'`, leave `reviewed: false` |
| Rework | Agent appends SHAs to `commits`; entry stays/re-enters needs_review |

Agents that implement coding tasks **must** write commit SHAs into `metadata.task.commits`
before claiming completion. `done` without `reviewed: true` remains possible but warned;
review automation should key off **needs_review**, not off `done`.

### Query / MCP surface (v1)

- Extend store `getTasks` (and `tim_show what=tasks`) with filter(s):
  - `subtype: 'coding'`
  - `needs_review: true` (computed predicate above)
  - `status: 'changes_pending'` (already covered if status filter accepts new enum value)
- No new MCP tool in v1.
- Docs + skills (`tim-new-task`, idea capture) document: set `idea.status` to `planned` to
  promote; coding tasks use subtype fields.

### Cron (explicitly out of v1)

A later job may list `needs_review` and spawn reviewers. Spec only requires the query
predicate to be stable so Cron does not scrape prose.

## Implementation touchpoints (indicative)

| Area | Likely files |
|---|---|
| Types | `packages/tim-core/src/types.ts` — `TaskMetadata`, new `IdeaMetadata` |
| Coercion / markers | `packages/tim-store/src/metadata-coerce.ts` — `isIdeaMarker` |
| Validation | `packages/tim-store/src/validate.ts` |
| Promote hook | `packages/tim-store` update path (`updateSync` or dedicated helper called from it) |
| Move-on-promote | existing move/parent APIs |
| Task queries | store `getTasks`, MCP `tim_show` |
| Docs | `docs/project-schema.json`, `docs/tim-capabilities.md`, skills |

## Phasing

1. **Schema + validation** — types, markers, warnings, unit tests.
2. **Promote-on-update** — in-place marker swap + Tasks move + idempotency tests.
3. **Coding fields + `changes_pending` + `needs_review` query** — store + `tim_show`.
4. **Docs / skills** — agent contract for commits + promote.
5. **Later** — review Cron / Worker integration (separate spec).

## Testing (acceptance)

1. Create idea with `metadata.idea.status: 'new'` under Ideas → listed by `tim_show ideas`.
2. Update status to `planned` → same ID, under Tasks, `metadata.task.status === 'todo'`,
   no `metadata.idea`.
3. Second planned update on that task → no-op/error, not duplicate.
4. Coding task with commits + `reviewed: false` → appears in needs_review filter.
5. Set `reviewed: true` + `done` → leaves needs_review.
6. Set `changes_pending` → status filter works; still needs_review until reviewed.

## Open questions (resolved in design)

| Question | Resolution |
|---|---|
| Promote A/B/C | **B** in-place |
| Boolean vs status for ideas | **Status** under `metadata.idea` |
| Persist `planned` after promote? | **No** — trigger only |
| Review Cron in v1? | **No** |

## Spec self-review

- [x] No TBD/placeholder sections left for v1 scope
- [x] Promote and coding status models do not contradict
- [x] Non-goals exclude Cron and reverse-promote
- [x] Acceptance tests map to goals
- [x] Scope is one shippable slice (schema → promote → coding query → docs)
