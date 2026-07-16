"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getTaskHistory = getTaskHistory;
exports.migrateTaskHistory = migrateTaskHistory;
exports.hasFreshReview = hasFreshReview;
exports.appendTaskStatus = appendTaskStatus;
exports.deriveStartedAt = deriveStartedAt;
exports.deriveFinishedAt = deriveFinishedAt;
exports.isCodingNeedsReview = isCodingNeedsReview;
function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function getTaskObject(task) {
    return isPlainObject(task) ? task : {};
}
/** Returns the append-only status history, or [] if absent/malformed. */
function getTaskHistory(task) {
    const t = getTaskObject(task);
    const history = t.history;
    if (!Array.isArray(history))
        return [];
    return history.filter((e) => isPlainObject(e) && typeof e.status === 'string' && typeof e.at === 'string');
}
/**
 * Seeds `history` from a bare `status` field when history is missing, and
 * migrates a legacy boolean `reviewed: true` into a `reviewed` history event.
 * Strips the boolean `reviewed` field either way. Idempotent.
 */
function migrateTaskHistory(task, nowIso = new Date().toISOString()) {
    const t = getTaskObject(task);
    const next = { ...t };
    let history = getTaskHistory(next);
    const hasHistory = Array.isArray(next.history) && history.length > 0;
    if (!hasHistory) {
        const bareStatus = typeof next.status === 'string' ? next.status : undefined;
        if (bareStatus) {
            history = [{ status: bareStatus, at: nowIso }];
        }
    }
    const legacyReviewed = next.reviewed;
    if (legacyReviewed === true) {
        const alreadyReviewed = history.some((e) => e.status === 'reviewed');
        if (!alreadyReviewed) {
            history = [...history, { status: 'reviewed', at: nowIso }];
        }
    }
    delete next.reviewed;
    if (history.length > 0) {
        next.history = history;
        next.status = history[history.length - 1].status;
    }
    return next;
}
function latestIndexOf(history, status) {
    for (let i = history.length - 1; i >= 0; i -= 1) {
        if (history[i].status === status)
            return i;
    }
    return -1;
}
/** history contains `reviewed`, with no `changes_pending` appended after the latest `reviewed`. */
function hasFreshReview(history) {
    const reviewedIdx = latestIndexOf(history, 'reviewed');
    if (reviewedIdx === -1)
        return false;
    const changesPendingIdx = latestIndexOf(history, 'changes_pending');
    return changesPendingIdx <= reviewedIdx;
}
function codingDoneGateError(task, history) {
    if (!hasFreshReview(history)) {
        return 'Cannot mark coding task done: requires a fresh "reviewed" entry in history (no changes_pending after it).';
    }
    const vcs = task.vcs;
    if (vcs === 'git') {
        const hasPushed = history.some((e) => e.status === 'pushed');
        if (!hasPushed) {
            return 'Cannot mark coding task done: vcs is "git" but history has no "pushed" entry.';
        }
        const commits = task.commits;
        const commitCount = Array.isArray(commits) ? commits.length : 0;
        if (commitCount < 1) {
            return 'Cannot mark coding task done: vcs is "git" but no commits recorded.';
        }
    }
    return undefined;
}
function currentTaskStatus(task, history) {
    if (history.length > 0)
        return history[history.length - 1].status;
    return typeof task.status === 'string' ? task.status : undefined;
}
/** Transition rules beyond the coding done-gate (spec v1). */
function transitionError(task, history, status) {
    const current = currentTaskStatus(task, history);
    if (status === 'in_progress' && (current === 'done' || current === 'cancelled')) {
        return `Cannot append "in_progress" from "${current}".`;
    }
    if (status === 'cancelled' && current === 'cancelled') {
        return 'Cannot append "cancelled": already cancelled.';
    }
    if (status === 'pushed') {
        if (task.vcs !== 'git') {
            return 'Cannot append "pushed": vcs is not "git".';
        }
        const commits = task.commits;
        const commitCount = Array.isArray(commits) ? commits.length : 0;
        if (commitCount < 1) {
            return 'Cannot append "pushed": no commits recorded.';
        }
    }
    if (status === 'done') {
        const isCoding = task.subtype === 'coding';
        if (isCoding) {
            return codingDoneGateError(task, history);
        }
    }
    return undefined;
}
/**
 * Appends a status event to the task's history, validating transitions.
 * Returns the updated task (with `history` and cached `status`), or an
 * `error` string and the original task unchanged.
 */
function appendTaskStatus(task, status, opts = {}) {
    const t = getTaskObject(task);
    const history = getTaskHistory(t);
    const at = opts.at ?? new Date().toISOString();
    const gateError = transitionError(t, history, status);
    if (gateError) {
        return { task, error: gateError };
    }
    const event = { status, at };
    if (opts.by !== undefined)
        event.by = opts.by;
    if (opts.note !== undefined)
        event.note = opts.note;
    const nextHistory = [...history, event];
    const nextTask = {
        ...t,
        history: nextHistory,
        status,
    };
    return { task: nextTask };
}
function deriveStartedAt(task) {
    const history = getTaskHistory(task);
    const event = history.find((e) => e.status === 'in_progress');
    return event ? event.at : null;
}
function deriveFinishedAt(task) {
    const history = getTaskHistory(task);
    const event = history.find((e) => e.status === 'done');
    return event ? event.at : null;
}
/**
 * v1: a coding task needs review when it has commits (or is not git-backed),
 * is not done/cancelled, and has no fresh review (reviewed after the latest
 * changes_pending, or any reviewed if there's no changes_pending).
 */
function isCodingNeedsReview(metadata) {
    const task = metadata.task;
    if (!isPlainObject(task))
        return false;
    if (task.subtype !== 'coding')
        return false;
    const history = getTaskHistory(task);
    const current = history.length > 0 ? history[history.length - 1].status : task.status;
    if (current === 'done' || current === 'cancelled')
        return false;
    const commits = task.commits;
    const commitCount = Array.isArray(commits) ? commits.length : 0;
    const vcs = task.vcs;
    const hasSomethingToReview = commitCount >= 1 || vcs === 'none';
    if (!hasSomethingToReview)
        return false;
    return !hasFreshReview(history);
}
//# sourceMappingURL=task-status-history.js.map