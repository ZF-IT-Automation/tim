"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveEntryTaskStatus = resolveEntryTaskStatus;
/**
 * Canonical task status resolution for MCP renderers.
 * Reads metadata.task.status only — legacy metadata.status is ignored
 * so tim_show and project briefing badges stay consistent.
 */
function resolveEntryTaskStatus(metadata) {
    const task = metadata.task;
    if (typeof task === 'object' && task !== null && !Array.isArray(task)) {
        const st = task.status;
        if (typeof st === 'string')
            return st;
    }
    return 'todo';
}
//# sourceMappingURL=task-status.js.map