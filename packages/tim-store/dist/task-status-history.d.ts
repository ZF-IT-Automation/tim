import type { TaskStatusEvent, TaskStatusValue } from 'tim-core';
/** Returns the append-only status history, or [] if absent/malformed. */
export declare function getTaskHistory(task: Record<string, unknown>): TaskStatusEvent[];
/**
 * Seeds `history` from a bare `status` field when history is missing, and
 * migrates a legacy boolean `reviewed: true` into a `reviewed` history event.
 * Strips the boolean `reviewed` field either way. Idempotent.
 */
export declare function migrateTaskHistory(task: Record<string, unknown>, nowIso?: string): Record<string, unknown>;
/** history contains `reviewed`, with no `changes_pending` appended after the latest `reviewed`. */
export declare function hasFreshReview(history: TaskStatusEvent[]): boolean;
/**
 * Appends a status event to the task's history, validating transitions.
 * Returns the updated task (with `history` and cached `status`), or an
 * `error` string and the original task unchanged.
 */
export declare function appendTaskStatus(task: Record<string, unknown>, status: TaskStatusValue, opts?: {
    at?: string;
    by?: string;
    note?: string;
}): {
    task: Record<string, unknown>;
    error?: string;
};
export declare function deriveStartedAt(task: Record<string, unknown>): string | null;
export declare function deriveFinishedAt(task: Record<string, unknown>): string | null;
/**
 * v1: a coding task needs review when it has commits (or is not git-backed),
 * is not done/cancelled, and has no fresh review (reviewed after the latest
 * changes_pending, or any reviewed if there's no changes_pending).
 */
export declare function isCodingNeedsReview(metadata: Record<string, unknown>): boolean;
//# sourceMappingURL=task-status-history.d.ts.map