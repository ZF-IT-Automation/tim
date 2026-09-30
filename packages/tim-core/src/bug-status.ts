/** Closed bug statuses — shared by MCP renderers and store-backed counts. */
export const CLOSED_BUG_STATUSES = new Set([
  'fixed',
  'closed',
  'resolved',
  'wontfix',
  'done',
  'documented',
  'duplicate',
  'cancelled',
]);

/** Resolve bug status from entry metadata — same precedence as the Bugs renderer. */
export function resolveBugStatusFromMetadata(metadata: Record<string, unknown>): string {
  // A bug closed through the task lifecycle (task.status done/cancelled) is closed,
  // whatever bug.status still says — tim_show resolves task.status first as well.
  const task = metadata.task;
  if (typeof task === 'object' && task !== null && !Array.isArray(task)) {
    const st = (task as { status?: unknown }).status;
    if (st === 'done' || st === 'cancelled') return st;
  }
  const bug = metadata.bug;
  if (typeof bug === 'object' && bug !== null && !Array.isArray(bug)) {
    const st = (bug as { status?: unknown }).status;
    if (typeof st === 'string' && st) return st;
  }
  if (String(metadata.type ?? '') === 'bug' && typeof metadata.status === 'string') {
    return metadata.status;
  }
  return 'open';
}

export function isClosedBugStatus(status: string): boolean {
  return CLOSED_BUG_STATUSES.has(status);
}

export function isClosedBugMetadata(metadata: Record<string, unknown>): boolean {
  return isClosedBugStatus(resolveBugStatusFromMetadata(metadata));
}
