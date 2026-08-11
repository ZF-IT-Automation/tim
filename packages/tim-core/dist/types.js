"use strict";
// packages/tim-core/src/types.ts
// Built-in 14 metadata types for TIM Schema v3 (Tags → Metadata refactor)
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEPRECATED_TAGS = exports.RETIRED_STRUCTURAL_TAGS = exports.DEPRECATED_PRIORITY_TAGS = exports.DEPRECATED_STATUS_TAGS = exports.ALL_METADATA_TYPES = exports.METADATA_TYPES = exports.BUILTIN_TYPES = exports.LEGACY_METADATA_TYPES = exports.BUILTIN_METADATA_TYPES = void 0;
exports.isBuiltinMetadataType = isBuiltinMetadataType;
exports.isBuiltinType = isBuiltinType;
exports.isMetadataType = isMetadataType;
exports.normalizeLegacyTypeTag = normalizeLegacyTypeTag;
exports.isDeprecatedTag = isDeprecatedTag;
exports.stripDeprecatedTags = stripDeprecatedTags;
/** 14 built-in metadata.type values (Schema v3 Phase 1). */
exports.BUILTIN_METADATA_TYPES = [
    'standard',
    'project',
    'task',
    'error',
    'decision',
    'learning',
    'idea',
    'log',
    'commit',
    'summary',
    'session',
    'batch_summary',
    'exchange',
    'event',
];
/** Phase 0 legacy values — still valid in DB, not part of the 14 built-ins. */
exports.LEGACY_METADATA_TYPES = ['rule', 'human'];
/** @deprecated Use BUILTIN_METADATA_TYPES — kept for callers expecting BUILTIN_TYPES */
exports.BUILTIN_TYPES = exports.BUILTIN_METADATA_TYPES;
exports.METADATA_TYPES = exports.BUILTIN_METADATA_TYPES;
exports.ALL_METADATA_TYPES = [
    ...exports.BUILTIN_METADATA_TYPES,
    ...exports.LEGACY_METADATA_TYPES,
];
function isBuiltinMetadataType(value) {
    return typeof value === 'string' && exports.BUILTIN_METADATA_TYPES.includes(value);
}
function isBuiltinType(value) {
    return isBuiltinMetadataType(value);
}
function isMetadataType(value) {
    return typeof value === 'string' && exports.ALL_METADATA_TYPES.includes(value);
}
/** Normalize legacy #rule / #human tags (Phase 0). Other types use section migration. */
function normalizeLegacyTypeTag(tag) {
    if (typeof tag !== 'string')
        return null;
    const cleaned = tag.trim().replace(/^#/, '').toLowerCase();
    if (cleaned === 'rule' || cleaned === 'human')
        return cleaned;
    return null;
}
// Status/priority tags — DEPRECATED. metadata.task.status is source-of-truth.
exports.DEPRECATED_STATUS_TAGS = new Set([
    '#todo', '#done', '#in_progress', '#cancelled',
    'todo', 'done', 'in_progress', 'cancelled',
]);
exports.DEPRECATED_PRIORITY_TAGS = new Set([
    '#priority-critical', '#priority-high', '#priority-medium', '#priority-low',
    'priority-critical', 'priority-high', 'priority-medium', 'priority-low',
]);
// Structural tags the session tree used to stamp on every node it wrote. The write sites
// are gone, so nothing emits them automatically any more.
//
// Deliberately NOT part of DEPRECATED_TAGS: these words are subject matter, not just
// plumbing. In a project about sessions, checkpoints and exchanges, a summary of the work
// on checkpoint reaping *should* be able to carry #checkpoint — banning the word would
// cost the tag vocabulary four of the terms the project is most about. The structural
// meaning lives in metadata.kind and never needed a tag.
//
// This set exists for one job: the one-time cleanup of the rows the old write sites left
// behind (`tim migrate retire-deprecated-tags`). Run that cleanup before using any of
// these as a content tag, or the sweep will take the new tag with it.
exports.RETIRED_STRUCTURAL_TAGS = new Set([
    '#exchange', 'exchange',
    '#session', 'session',
    '#exchanges', 'exchanges',
    '#sessions', 'sessions',
    '#checkpoint', 'checkpoint',
]);
exports.DEPRECATED_TAGS = new Set([
    ...exports.DEPRECATED_STATUS_TAGS,
    ...exports.DEPRECATED_PRIORITY_TAGS,
]);
function isDeprecatedTag(tag) {
    return exports.DEPRECATED_TAGS.has(tag.toLowerCase());
}
function stripDeprecatedTags(tags) {
    const clean = [];
    const removed = [];
    for (const tag of tags) {
        if (isDeprecatedTag(tag)) {
            removed.push(tag);
        }
        else {
            clean.push(tag);
        }
    }
    return { clean, removed };
}
//# sourceMappingURL=types.js.map