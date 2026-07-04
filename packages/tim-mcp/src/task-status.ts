/**
 * Canonical task status resolution for MCP renderers.
 * Reads metadata.task.status only — legacy metadata.status is ignored
 * so tim_show and project briefing badges stay consistent.
 */
export function resolveEntryTaskStatus(metadata: Record<string, unknown>): string {
  const task = metadata.task;
  if (typeof task === 'object' && task !== null && !Array.isArray(task)) {
    const st = (task as { status?: unknown }).status;
    if (typeof st === 'string') return st;
  }
  return 'todo';
}
