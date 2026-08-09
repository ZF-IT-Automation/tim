"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveEntryTaskStatus = resolveEntryTaskStatus;
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
 * Canonical task status resolution for MCP renderers.
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
function resolveEntryTaskStatus(metadata) {
    const task = metadata.task;
    if (typeof task === 'object' && task !== null && !Array.isArray(task)) {
        const st = task.status;
        if (typeof st === 'string')
            return st;
        return 'todo';
    }
    const bug = metadata.bug;
    if (typeof bug === 'object' && bug !== null && !Array.isArray(bug)) {
        const st = bug.status;
        if (st === 'wontfix' || st === 'duplicate')
            return 'cancelled';
        if (typeof st === 'string' && st !== 'open')
            return 'done';
        return 'todo';
    }
    const legacy = metadata.status;
    if (typeof legacy === 'string' && TASK_STATUSES.has(legacy))
        return legacy;
    return 'todo';
}
//# sourceMappingURL=task-status.js.map