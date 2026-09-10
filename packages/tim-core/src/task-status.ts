/** TaskStatusValue from tim-core, as a runtime set. */
const TASK_STATUSES = new Set([
  'todo',
  'in_progress',
  'changes_pending',
  'pushed',
  'reviewed',
  'done',
  'cancelled',
]);

/**
 * Canonical task status resolution for search filters and MCP renderers.
 *
 * Canonical shape is metadata.task = { status, priority, history }. Legacy entries
 * carry metadata.task = true plus a top-level metadata.status; isTaskMarker accepts
 * both, so those are listed as tasks and their status has to be read too — otherwise
 * finished legacy tasks render as 'todo' forever. Only canonical status values are
 * accepted from the legacy field; other vocabularies there (metadata.status of
 * 'fixed'/'documented' on bug entries) are not task statuses.
 *
 * Bugs carry metadata.bug instead of metadata.task, with their own status
 * vocabulary. The open/done distinction the listings filter on is shared, so
 * bug statuses are mapped onto it here: 'open' (or missing) is still open work,
 * 'wontfix'/'duplicate' are closed without a fix, everything else is done.
 */
/** SQLite expression mirroring resolveEntryTaskStatus() for pre-limit search filters. */
export function entryTaskStatusSql(metadataColumn = 'e.metadata'): string {
  const col = metadataColumn;
  const legacyStatuses =
    "('todo','in_progress','changes_pending','pushed','reviewed','done','cancelled')";
  return `CASE
    WHEN json_type(${col}, '$.task') = 'object' THEN COALESCE(json_extract(${col}, '$.task.status'), 'todo')
    WHEN json_type(${col}, '$.bug') = 'object' THEN
      CASE
        WHEN json_extract(${col}, '$.bug.status') IN ('wontfix', 'duplicate') THEN 'cancelled'
        WHEN json_extract(${col}, '$.bug.status') IS NOT NULL
             AND json_extract(${col}, '$.bug.status') != 'open' THEN 'done'
        ELSE 'todo'
      END
    WHEN json_extract(${col}, '$.status') IN ${legacyStatuses} THEN json_extract(${col}, '$.status')
    ELSE 'todo'
  END`;
}

/**
 * Search-filter status resolution — distinct from task-list display defaults.
 *
 * Precedence (first match wins):
 * 1. `metadata.task` object → `task.status` or `'todo'`
 * 2. `metadata.bug` object → `bug.status` or `'open'` (bug vocabulary preserved)
 * 3. legacy flat `metadata.status` string (any value, including `fixed`/`documented`)
 * 4. legacy `metadata.task === true` marker → `'todo'`
 * 5. otherwise → `null` (plain notes do not inherit a status)
 *
 * `entryTaskStatusSql` / `resolveEntryTaskStatus` keep the display mapping
 * (bugs → open/done, missing → todo). Use these only for search filters.
 */
export function entrySearchStatusSql(metadataColumn = 'e.metadata'): string {
  const col = metadataColumn;
  return `CASE
    WHEN json_type(${col}, '$.task') = 'object' THEN COALESCE(json_extract(${col}, '$.task.status'), 'todo')
    WHEN json_type(${col}, '$.bug') = 'object' THEN COALESCE(json_extract(${col}, '$.bug.status'), 'open')
    WHEN json_type(${col}, '$.status') = 'text' THEN json_extract(${col}, '$.status')
    WHEN json_type(${col}, '$.task') = 'true' THEN 'todo'
    ELSE NULL
  END`;
}

export function resolveEntrySearchStatus(metadata: Record<string, unknown>): string | null {
  const task = metadata.task;
  if (typeof task === 'object' && task !== null && !Array.isArray(task)) {
    const st = (task as { status?: unknown }).status;
    if (typeof st === 'string') return st;
    return 'todo';
  }
  const bug = metadata.bug;
  if (typeof bug === 'object' && bug !== null && !Array.isArray(bug)) {
    const st = (bug as { status?: unknown }).status;
    if (typeof st === 'string') return st;
    return 'open';
  }
  const legacy = metadata.status;
  if (typeof legacy === 'string') return legacy;
  if (task === true) return 'todo';
  return null;
}

export function resolveEntryTaskStatus(metadata: Record<string, unknown>): string {
  const task = metadata.task;
  if (typeof task === 'object' && task !== null && !Array.isArray(task)) {
    const st = (task as { status?: unknown }).status;
    if (typeof st === 'string') return st;
    return 'todo';
  }
  const bug = metadata.bug;
  if (typeof bug === 'object' && bug !== null && !Array.isArray(bug)) {
    const st = (bug as { status?: unknown }).status;
    if (st === 'wontfix' || st === 'duplicate') return 'cancelled';
    if (typeof st === 'string' && st !== 'open') return 'done';
    return 'todo';
  }
  const legacy = metadata.status;
  if (typeof legacy === 'string' && TASK_STATUSES.has(legacy)) return legacy;
  return 'todo';
}
