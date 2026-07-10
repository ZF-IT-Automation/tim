# RESULT — Task Queue Ordering (Insert-Between with Integer Gaps)

## Outcome
**DONE** — All 4 tasks implemented, 939 tests green, tsc clean.

## Commit
(see git log after commit)

## Changes

| File | Change |
|------|--------|
| `packages/tim-store/src/store.ts` | `setTaskOrder()` public method + `computeTaskOrder()`, `getOrderedProjectTasks()`, `renumberProjectTasks()`, `extractTaskOrder()`, `extractTaskStatus()` helpers. `updateSync()` deletes `metadata.task.order` on status→done. `getTasks()` SQL adds `$.task.order` as first ORDER BY. |
| `packages/tim-mcp/src/server.ts` | `tim_task_order` Tool (schema + handler) with lazy init. `resolveEntryTaskOrder()` helper. `sortForShow()` adds order as first sort key. `formatShowLine()` shows `[order]` prefix for active tasks. |

## Task Breakdown

### 1. Store: setTaskOrder(taskId, beforeId?, afterId?)
- Append (no anchors): max order + 100, or 100 if no existing orders
- Before: midpoint between previous task and target, or floor(beforeOrder/2) at head
- After: midpoint between target and next task, or afterOrder+100 at tail
- Both anchors: midpoint between the two (validates beforeId < afterId)
- Renumbering fallback: when gap = 1 or midpoint collides, renumber all active tasks in project (100/200/300...)

### 2. Store: Delete order on status→done
- In `updateSync()` metadata merge: detects `newStatus === 'done' && oldStatus !== 'done'` → deletes `order` from `task` object

### 3. MCP: tim_task_order Tool
- Schema: `taskId` (required), `before` (optional), `after` (optional)
- Validation: at least one of before/after required (runtime check)
- Lazy init: on first call, checks if any project tasks lack `metadata.task.order` → sorts by priority (high→medium→low) then createdAt, assigns 100/200/300...

### 4. Sort by order
- `getTasks()` SQL: `COALESCE(json_extract(metadata, '$.task.order'), 999999)` as first ORDER BY
- `sortForShow()`: order as first sort key (resolveEntryTaskOrder, missing = 999999)
- `formatShowLine()`: `[100]` prefix for active tasks with order

## Verification
- `npx tsc -b --force`: clean
- `npm test`: 939 passed, 2 skipped (146 test files) — green
- `compareEntryOrder` in project-output.ts already handles `metadata.order` (no change needed)
- `loadProject` already has `$.order` sort (line 540) — complementary

## Non-goals (unchanged)
- No fractional indexing
- No cross-project ordering (scoped per project_label)
- No Drag-and-Drop UI
- Priority semantics unchanged
