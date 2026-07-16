import type { TaskStatusEvent, TaskStatusValue } from 'tim-core';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getTaskObject(task: Record<string, unknown>): Record<string, unknown> {
  return isPlainObject(task) ? task : {};
}

/** Returns the append-only status history, or [] if absent/malformed. */
export function getTaskHistory(task: Record<string, unknown>): TaskStatusEvent[] {
  const t = getTaskObject(task);
  const history = t.history;
  if (!Array.isArray(history)) return [];
  return history.filter(
    (e): e is TaskStatusEvent => isPlainObject(e) && typeof e.status === 'string' && typeof e.at === 'string',
  );
}

/**
 * Seeds `history` from a bare `status` field when history is missing, and
 * migrates a legacy boolean `reviewed: true` into a `reviewed` history event.
 * Strips the boolean `reviewed` field either way. Idempotent.
 */
export function migrateTaskHistory(
  task: Record<string, unknown>,
  nowIso: string = new Date().toISOString(),
): Record<string, unknown> {
  const t = getTaskObject(task);
  const next: Record<string, unknown> = { ...t };

  let history = getTaskHistory(next);
  const hasHistory = Array.isArray(next.history) && history.length > 0;

  if (!hasHistory) {
    const bareStatus = typeof next.status === 'string' ? (next.status as TaskStatusValue) : undefined;
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

function latestIndexOf(history: TaskStatusEvent[], status: TaskStatusValue): number {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i].status === status) return i;
  }
  return -1;
}

/** history contains `reviewed`, with no `changes_pending` appended after the latest `reviewed`. */
export function hasFreshReview(history: TaskStatusEvent[]): boolean {
  const reviewedIdx = latestIndexOf(history, 'reviewed');
  if (reviewedIdx === -1) return false;
  const changesPendingIdx = latestIndexOf(history, 'changes_pending');
  return changesPendingIdx <= reviewedIdx;
}

function codingDoneGateError(
  task: Record<string, unknown>,
  history: TaskStatusEvent[],
): string | undefined {
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

/**
 * Appends a status event to the task's history, validating transitions.
 * Returns the updated task (with `history` and cached `status`), or an
 * `error` string and the original task unchanged.
 */
export function appendTaskStatus(
  task: Record<string, unknown>,
  status: TaskStatusValue,
  opts: { at?: string; by?: string; note?: string } = {},
): { task: Record<string, unknown>; error?: string } {
  const t = getTaskObject(task);
  const history = getTaskHistory(t);
  const at = opts.at ?? new Date().toISOString();

  if (status === 'done') {
    const isCoding = t.subtype === 'coding';
    if (isCoding) {
      const gateError = codingDoneGateError(t, history);
      if (gateError) {
        return { task, error: gateError };
      }
    }
  }

  const event: TaskStatusEvent = { status, at };
  if (opts.by !== undefined) event.by = opts.by;
  if (opts.note !== undefined) event.note = opts.note;

  const nextHistory = [...history, event];
  const nextTask: Record<string, unknown> = {
    ...t,
    history: nextHistory,
    status,
  };

  return { task: nextTask };
}

export function deriveStartedAt(task: Record<string, unknown>): string | null {
  const history = getTaskHistory(task);
  const event = history.find((e) => e.status === 'in_progress');
  return event ? event.at : null;
}

export function deriveFinishedAt(task: Record<string, unknown>): string | null {
  const history = getTaskHistory(task);
  const event = history.find((e) => e.status === 'done');
  return event ? event.at : null;
}

/**
 * v1: a coding task needs review when it has commits (or is not git-backed),
 * is not done/cancelled, and has no fresh review (reviewed after the latest
 * changes_pending, or any reviewed if there's no changes_pending).
 */
export function isCodingNeedsReview(metadata: Record<string, unknown>): boolean {
  const task = metadata.task;
  if (!isPlainObject(task)) return false;
  if (task.subtype !== 'coding') return false;

  const history = getTaskHistory(task);
  const current = history.length > 0 ? history[history.length - 1].status : task.status;
  if (current === 'done' || current === 'cancelled') return false;

  const commits = task.commits;
  const commitCount = Array.isArray(commits) ? commits.length : 0;
  const vcs = task.vcs;
  const hasSomethingToReview = commitCount >= 1 || vcs === 'none';
  if (!hasSomethingToReview) return false;

  return !hasFreshReview(history);
}
