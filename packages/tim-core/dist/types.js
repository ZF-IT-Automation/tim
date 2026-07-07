"use strict";
// packages/tim-core/src/types.ts
// Built-in 14 metadata types for TIM Schema v3 (Tags → Metadata refactor)
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEPRECATED_TAGS = exports.DEPRECATED_PRIORITY_TAGS = exports.DEPRECATED_STATUS_TAGS = exports.ALL_METADATA_TYPES = exports.METADATA_TYPES = exports.BUILTIN_TYPES = exports.LEGACY_METADATA_TYPES = exports.BUILTIN_METADATA_TYPES = void 0;
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