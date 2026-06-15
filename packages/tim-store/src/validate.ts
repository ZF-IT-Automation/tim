/**
 * Standalone metadata validation (Schema v3 Phase 2a).
 * Warnings only — no throws during migration phase.
 */

export function validateTaskMetadata(metadata: Record<string, unknown>): string[] {
  const warnings: string[] = [];

  if (metadata.type === 'task') {
    const task = metadata.task;
    if (!task || typeof task !== 'object' || Array.isArray(task)) {
      warnings.push(
        'task metadata missing — recommended default: { status: "todo", priority: "medium" }',
      );
    } else {
      const taskObj = task as Record<string, unknown>;
      if (taskObj.status === 'done' && !taskObj.completion_evidence) {
        warnings.push('completion_evidence recommended for done tasks');
      }
    }
  }

  return warnings;
}
