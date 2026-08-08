"use strict";
// TIM MCP — write validation helpers
// Pure functions (no DB, no transport) so they can be unit-tested without MCP plumbing.
Object.defineProperty(exports, "__esModule", { value: true });
exports.MIN_TAGS_FOR_USER_CONTENT = exports.CLOSED_BUG_STATUSES = exports.SCHEMA_KINDS = void 0;
exports.applySectionEntryType = applySectionEntryType;
exports.validateBugStatus = validateBugStatus;
exports.validateWriteTags = validateWriteTags;
exports.supplementWriteTags = supplementWriteTags;
const tim_core_1 = require("tim-core");
Object.defineProperty(exports, "SCHEMA_KINDS", { enumerable: true, get: function () { return tim_core_1.SCHEMA_KINDS; } });
/**
 * What each schema `entry_type` stamps on a child: the marker field that makes
 * the listings find it, and the status it starts in.
 */
const ENTRY_TYPE_MARKERS = {
    task: { field: 'task', defaults: { status: 'todo', priority: 'medium' } },
    bug: { field: 'bug', defaults: { status: 'open' } },
    idea: { field: 'idea', defaults: { status: 'new' } },
};
/** Bug statuses that mean the bug is no longer open. */
exports.CLOSED_BUG_STATUSES = new Set(['fixed', 'documented', 'wontfix', 'duplicate']);
/**
 * Stamp the section's declared entry type on a new child.
 *
 * A child of `Bugs` is a bug, a child of `Tasks` is a task — that should not
 * depend on whether whoever wrote it remembered the right metadata field. The
 * caller always wins: an explicit `type`, an existing marker object, or a schema
 * kind (sections, sessions, …) is left exactly as it came in.
 */
function applySectionEntryType(metadata, sectionName, parentKind) {
    if (!sectionName || parentKind !== 'section')
        return metadata;
    const entryType = (0, tim_core_1.findSchemaSection)(tim_core_1.PROJECT_SCHEMA.sections, sectionName)?.entry_type;
    if (!entryType)
        return metadata;
    const marker = ENTRY_TYPE_MARKERS[entryType];
    const meta = metadata ? { ...metadata } : {};
    const kind = typeof meta.kind === 'string' ? meta.kind : undefined;
    if (kind && tim_core_1.SCHEMA_KINDS.has(kind))
        return metadata;
    if (typeof meta.type === 'string' && meta.type)
        return metadata;
    // Classified as something else already — don't add a second marker.
    const foreignMarkers = Object.entries(ENTRY_TYPE_MARKERS)
        .filter(([type]) => type !== entryType)
        .map(([, m]) => m.field);
    if (foreignMarkers.some(field => meta[field] !== undefined))
        return metadata;
    // A caller who passed the section's own marker (metadata.bug under Bugs) still
    // needs `type` — the listings select on it, so without it the entry is written
    // into the section and then invisible in the section's listing.
    meta.type = entryType;
    if (meta[marker.field] === undefined)
        meta[marker.field] = { ...marker.defaults };
    return meta;
}
/**
 * A bug may only claim `fixed` with the commit that fixed it. The other closing
 * statuses are the honest way out for a bug that was closed without a change.
 *
 * Legacy bugs (`bug.legacy: true`) predate the rule and are exempt — their fix
 * commit is prose in the body, and reopening a dozen finished bugs to enforce a
 * rule retroactively would make the listing useless, which is what this is
 * meant to fix.
 */
function validateBugStatus(metadata) {
    const bug = metadata?.bug;
    if (bug === null || typeof bug !== 'object' || Array.isArray(bug))
        return { ok: true };
    const { status, commit, legacy } = bug;
    if (status !== 'fixed' || legacy === true)
        return { ok: true };
    if (typeof commit === 'string' && commit.trim())
        return { ok: true };
    return {
        ok: false,
        message: "a bug closes as 'fixed' only with the commit that fixed it — pass metadata.bug.commit. " +
            "If it was closed without a fix, use status 'documented', 'wontfix' or 'duplicate' instead. " +
            'Note that metadata.provenance.commit is HEAD when the bug was filed, not the fix.',
    };
}
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