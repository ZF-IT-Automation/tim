/**
 * Canonical task status resolution for MCP renderers.
 *
 * Canonical shape is metadata.task = { status, priority, history }. Legacy entries
 * carry metadata.task = true plus a top-level metadata.status; isTaskMarker accepts
 * both, so those are listed as tasks and their status has to be read too — otherwise
 * finished legacy tasks render as 'todo' forever. Only canonical status values are
 * accepted from the legacy field; other vocabularies there (metadata.status of
 * 'fixed'/'documented' on bug entries) are not task statuses.
 */
export declare function resolveEntryTaskStatus(metadata: Record<string, unknown>): string;
//# sourceMappingURL=task-status.d.ts.map