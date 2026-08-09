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
export declare function resolveEntryTaskStatus(metadata: Record<string, unknown>): string;
//# sourceMappingURL=task-status.d.ts.map