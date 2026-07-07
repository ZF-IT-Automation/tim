/**
 * Canonical task status resolution for MCP renderers.
 * Reads metadata.task.status only — legacy metadata.status is ignored
 * so tim_show and project briefing badges stay consistent.
 */
export declare function resolveEntryTaskStatus(metadata: Record<string, unknown>): string;
//# sourceMappingURL=task-status.d.ts.map