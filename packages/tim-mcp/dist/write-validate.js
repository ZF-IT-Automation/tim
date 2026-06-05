"use strict";
// TIM MCP — write validation helpers
// Pure functions (no DB, no transport) so they can be unit-tested without MCP plumbing.
Object.defineProperty(exports, "__esModule", { value: true });
exports.MIN_TAGS_FOR_USER_CONTENT = exports.SCHEMA_KINDS = void 0;
exports.validateWriteTags = validateWriteTags;
/**
 * Kind values that identify schema/structural entries. Entries with these kinds
 * are exempt from the "tags required" rule in tim_write. Everything else
 * (user-generated content) MUST carry at least 2 tags for discoverability.
 *
 * Sourced from:
 *   - packages/tim-core/src/project.ts   (project)
 *   - packages/tim-store/src/session-tree.ts  (sessions/summary/batch/exchange)
 *   - packages/tim-store/src/commit-tree.ts  (commits)
 *   - ad-hoc structural kinds in checkpoint + section code paths
 */
exports.SCHEMA_KINDS = new Set([
    // Project tree
    'project',
    'section',
    // Sessions sub-tree
    'sessions-root',
    'session',
    'session-summary-root',
    'exchanges-root',
    'exchange-batch',
    'exchange',
    'batch-summary',
    // Commits sub-tree
    'commits-root',
    'commit',
    // Other structural
    'checkpoint',
]);
/** Minimum number of tags required on non-schema entries. */
exports.MIN_TAGS_FOR_USER_CONTENT = 2;
/**
 * Decide whether a tim_write call satisfies the "tags required" rule.
 *
 * - Schema entries (matching a kind in SCHEMA_KINDS) are exempt — tags optional.
 * - All other entries (user content: notes, tasks, learnings, ideas, …) require
 *   at least MIN_TAGS_FOR_USER_CONTENT tags.
 *
 * @param tags   Tags the caller passed (default [] when omitted).
 * @param metadata  Entry metadata — we look at `metadata.kind`.
 * @param parentMetadataKind  Optional: kind of the parent entry. A child of a
 *   schema-kind parent (e.g. a leaf under a 'section') is still user content
 *   and therefore not exempt — we only use `metadata.kind`, not parent kind.
 */
function validateWriteTags(tags, metadata) {
    const kind = typeof metadata?.kind === 'string' ? metadata.kind : undefined;
    // Schema entries are exempt.
    if (kind && exports.SCHEMA_KINDS.has(kind)) {
        return { ok: true };
    }
    const tagCount = tags?.length ?? 0;
    if (tagCount >= exports.MIN_TAGS_FOR_USER_CONTENT) {
        return { ok: true };
    }
    // Build a metadata hint that points the caller at the fix.
    const metadataHint = {};
    if (kind)
        metadataHint.kind = kind;
    if (metadata?.topic)
        metadataHint.topic = metadata.topic;
    if (metadata?.title)
        metadataHint.title = metadata.title;
    if (Object.keys(metadataHint).length === 0) {
        metadataHint.note = 'Pass at least 2 tags in the `tags` array.';
    }
    return {
        ok: false,
        error: 'tags_required',
        message: 'Non-schema entries require at least 2 tags. ' +
            'Schema entries (sections, project roots, sessions) are exempt.',
        metadata_hint: metadataHint,
    };
}
//# sourceMappingURL=write-validate.js.map