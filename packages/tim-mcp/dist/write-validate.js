"use strict";
// TIM MCP — write validation helpers
// Pure functions (no DB, no transport) so they can be unit-tested without MCP plumbing.
Object.defineProperty(exports, "__esModule", { value: true });
exports.MIN_TAGS_FOR_USER_CONTENT = exports.SCHEMA_KINDS = void 0;
exports.validateWriteTags = validateWriteTags;
exports.supplementWriteTags = supplementWriteTags;
const tim_core_1 = require("tim-core");
Object.defineProperty(exports, "SCHEMA_KINDS", { enumerable: true, get: function () { return tim_core_1.SCHEMA_KINDS; } });
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
    if (kind && tim_core_1.SCHEMA_KINDS.has(kind)) {
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
/**
 * Fill missing tags / infer section kind so tim_write can proceed when callers
 * omit tags (e.g. integration tests, quick MCP writes).
 */
function supplementWriteTags(tags, metadata, parentKind) {
    const meta = metadata ? { ...metadata } : {};
    const kind = typeof meta.kind === 'string' ? meta.kind : undefined;
    if (kind && tim_core_1.SCHEMA_KINDS.has(kind)) {
        return { tags: tags ?? [], metadata: meta };
    }
    if (parentKind === 'project' && !kind) {
        meta.kind = 'section';
        return { tags: tags ?? [], metadata: meta };
    }
    const tagList = [...(tags ?? [])];
    if (tagList.length >= exports.MIN_TAGS_FOR_USER_CONTENT) {
        return { tags: tagList, metadata: meta };
    }
    const primary = kind ? `#${kind}` : '#entry';
    const merged = [...new Set([...tagList, primary, '#tim'])];
    while (merged.length < exports.MIN_TAGS_FOR_USER_CONTENT) {
        merged.push('#tim');
    }
    return { tags: merged, metadata: meta };
}
//# sourceMappingURL=write-validate.js.map