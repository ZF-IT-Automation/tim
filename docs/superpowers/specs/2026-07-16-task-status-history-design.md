# Append-Only Task Status History (+ Git-Conditional Coding Gates)

**Date:** 2026-07-16  
**Status:** Approved design direction (awaiting implementation plan)  
**Supersedes / extends:** `docs/superpowers/specs/2026-07-16-idea-promote-coding-task-design.md`  
**Related branch:** `feature/idea-promote-coding-task` (idea promote + coding subtype already implemented; status model evolves here)

## Problem

The coding-task design introduced overwriteable `metadata.task.status` plus boolean gates (`reviewed`, later discussed `pushed`). That loses:

1. When work started / finished  
2. The path through review / push / rework  
3. An audit trail agents can append without clobbering history  

Separately, requiring commits/push for every coding task is wrong when the bound project is not a Git repo.

## Goals

1. Task status is an **append-only history** with ISO timestamps (and optional `by` / `note`).  
2. **Current status** = last history entry (optionally cached on `metadata.task.status` for SQL/filters).  
3. **`done` may only be appended if history already contains `reviewed`** (coding subtype).  
4. **`commits` / `pushed` are mandatory only when the task/project is Git-backed** (`vcs === 'git'`), not merely because `git` is installed on the machine.  
5. Derive `started_at` / `finished_at` from history (first `in_progress`, first/last `done`).  
6. Keep idea→task in-place promote behavior from the prior spec unchanged.

## Non-Goals

- Reverse-promote Task → Idea  
- Review Cron automation  
- Rewriting / truncating history from normal agent APIs  
- Using “git binary installed” as the enforcement gate  
- Requiring `reviewed` before `done` for **non-coding** tasks  

## Design

### Schema

```ts
interface TaskStatusEvent {
  status:
    | 'todo'
    | 'in_progress'
    | 'changes_pending'
    | 'pushed'
    | 'reviewed'
    | 'done'
    | 'cancelled';
  at: string;       // ISO 8601
  by?: string;      // agent / device
  note?: string;
}

interface TaskMetadata {
  /** Cache of history.at(-1).status — updated on every append */
  status?: TaskStatusEvent['status'];

  /** Append-only. Never overwrite entries via normal update APIs. */
  history: TaskStatusEvent[];

  priority?: 'low' | 'medium' | 'high' | 'critical';
  due_date?: string;
  completion_evidence?: string | null;

  subtype?: 'coding';
  commits?: string[];

  /**
   * Set once when first known. 'git' if bound project path is inside a work tree;
   * 'none' otherwise. Not "git installed".
   */
  vcs?: 'git' | 'none';
}
```

**Removed** relative to the boolean design: `reviewed?: boolean`, `pushed?: boolean`. Those are history statuses.

### Derived fields (compute, do not require storage)

| Field | Rule |
|---|---|
| `current` | `history[history.length - 1]` |
| `started_at` | `at` of first event with `status === 'in_progress'` |
| `finished_at` | `at` of first (or last) event with `status === 'done'` |
| `has_reviewed` | history some `status === 'reviewed'` |
| `has_pushed` | history some `status === 'pushed'` |

### Append API

`tim_update` / store update when a new task status is requested:

1. Deep-merge other task fields as today.  
2. **Do not replace `history`.** If patch includes a new status (top-level `task.status` or explicit event), **append** `{ status, at: now, by? }` to `history`.  
3. Set cached `task.status` to that new value.  
4. Reject illegal transitions (see below).  

Reading: prefer cache `task.status`; if missing, derive from last history entry (migration).

### Transition rules

#### All tasks

| Append | Allowed when |
|---|---|
| `todo` | create / reset (rare) |
| `in_progress` | anytime while not `done`/`cancelled` (or allow re-open later — v1: not from `done`) |
| `cancelled` | anytime except already `cancelled` |
| `done` | see subtype rules |

#### `subtype === 'coding'`

| Append | Allowed when |
|---|---|
| `pushed` | `vcs === 'git'` and `commits.length ≥ 1` |
| `reviewed` | coding task (commits recommended if `vcs === 'git'`, not hard-required for review itself) |
| `changes_pending` | after work started |
| **`done`** | **history already contains ≥1 `reviewed`** |

#### Coding + `vcs === 'git'` additional gates

Before appending `done`:

- history contains `reviewed` (**hard**, always for coding)  
- history contains `pushed` (**hard** when `vcs === 'git'`)  
- `commits.length ≥ 1` (**hard** when `vcs === 'git'`)  

#### Coding + `vcs === 'none'`

- No requirement for `commits` or `pushed`  
- **`done` still requires prior `reviewed`** in history  

#### Non-coding tasks

- No `reviewed` / `pushed` requirement  
- `todo` → `in_progress` → `done` allowed  

### VCS detection (gate ≠ “git installed”)

**Canonical gate:** project working tree is a Git repo.

```text
git rev-parse --is-inside-work-tree  (exit 0)  →  vcs = 'git'
otherwise                                      →  vcs = 'none'
```

**When to set `task.vcs`:**

1. On first coding-relevant write/update if unset: resolve project path from `.tim-project` / session cwd / bound path, run check, store `vcs`.  
2. If path/cwd unknown: leave `vcs` unset; treat enforcement as **lenient** (warn only) until set — or require agent to pass `vcs` explicitly.  
3. Never use “is `git` on PATH?” as the gate.  

Hybrid (approved): once set, rules use stored `vcs` so updates without cwd stay deterministic.

### needs_review (replaces boolean `reviewed !== true`)

```text
subtype === 'coding'
AND (commits.length ≥ 1 OR vcs === 'none')  // something to review
AND !history.some(e => e.status === 'reviewed')  // or last cycle after changes_pending
AND current ∉ { done, cancelled }
```

After `changes_pending`, a new `reviewed` entry is required again before `done` (history must contain `reviewed` **after** the latest `changes_pending`, or simply: latest gate event wins — **v1 rule:**

**v1 done-gate:** history contains at least one `reviewed`, and there is **no** `changes_pending` **after** the latest `reviewed`.

### Idea promote

Unchanged from prior spec: `metadata.idea.status → planned` promotes in-place to task under Tasks with initial history:

```ts
history: [{ status: 'todo', at: <now> }]
status: 'todo'
```

### Migration from feature branch fields

| Old | New |
|---|---|
| `task.status = 'X'` (overwrite) | seed `history: [{ status: X, at: updatedAt \|\| now }]` if history missing |
| `task.reviewed === true` | append `{ status: 'reviewed', at }` if not present |
| `task.reviewed === false` / absent | no event |
| `task.pushed` (if any) | same → `pushed` event |
| boolean fields | stop writing; validators warn if present |

## Phasing

1. **Schema + append helper** — `appendTaskStatus`, transition validation, unit tests  
2. **Wire `updateSync`** — status patches append; reject illegal `done`  
3. **VCS detect + `task.vcs`** — set-on-first-touch; git-conditional commit/push gates  
4. **needs_review query** — rewrite predicate off history  
5. **Migrate readers** — `tim_show` / getTasks use cache + history fallback  
6. **Docs / CHANGELOG / skill** — agent contract: append-only; done after reviewed; push only if git repo  
7. **Data migration** — one-shot or lazy on read/update for existing tasks  

## Acceptance

1. Updating status twice yields two history rows; cache equals last status.  
2. Coding `done` without prior `reviewed` → error.  
3. Coding + `vcs=git` + `done` without `pushed` or commits → error.  
4. Coding + `vcs=none` + `reviewed` then `done` without commits → ok.  
5. Non-coding `in_progress` → `done` without `reviewed` → ok.  
6. `started_at` / `finished_at` helpers match first `in_progress` / `done`.  
7. Idea promote still lands as task with `history: [todo]`.  

## Resolved decisions

| Question | Resolution |
|---|---|
| Status overwrite vs append | **Append-only history** |
| `done` gate | **Only after `reviewed` in history** (coding) |
| `pushed` / commits | Status events + commits[]; **required only if `vcs === 'git'`** |
| Git gate | **Inside work tree**, not “git installed” |
| Booleans `reviewed`/`pushed` | **Replaced by history statuses** |

## Spec self-review

- [x] No TBD for v1 rules above  
- [x] Compatible with idea-promote design  
- [x] Explicit migration from boolean branch  
- [x] Non-coding unaffected by review gate  
