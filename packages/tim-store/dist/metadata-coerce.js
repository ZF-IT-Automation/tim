"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BOOLEAN_METADATA_KEYS = void 0;
exports.normalizeTaskValue = normalizeTaskValue;
exports.isTaskMarker = isTaskMarker;
exports.coerceMetadataBooleans = coerceMetadataBooleans;
exports.metadataNeedsCoercion = metadataNeedsCoercion;
exports.parseAndCoerceMetadata = parseAndCoerceMetadata;
exports.isBooleanMetadataKey = isBooleanMetadataKey;
/** Known metadata keys stored as JSON booleans (legacy data may use 1/0 or "true"/"false"). */
exports.BOOLEAN_METADATA_KEYS = [
    'task',
    'archived',
    'pinned',
    'favorite',
    'irrelevant',
    'done',
    'completed',
    'cancelled',
    'in_progress',
];
const BOOLEAN_KEY_SET = new Set(exports.BOOLEAN_METADATA_KEYS);
function normalizeTaskValue(value) {
    if (value === 1 || value === 'true')
        return true;
    if (value === 0 || value === 'false')
        return false;
    return value;
}
function isTaskMarker(value) {
    // Recognizes BOTH the legacy boolean form (task: true / 1 / "true")
    // AND the canonical object form (task: { status: ..., priority: ... }).
    // The object form is what real tasks look like in the DB; the boolean
    // form is what legacy entries (and some tests) use.
    if (normalizeTaskValue(value) === true)
        return true;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        return true;
    }
    return false;
}
function coerceBooleanValue(value) {
    if (value === 1 || value === 'true')
        return true;
    if (value === 0 || value === 'false')
        return false;
    return value;
}
function coerceMetadataBooleans(meta) {
    const out = {};
    for (const [key, value] of Object.entries(meta)) {
        if (BOOLEAN_KEY_SET.has(key)) {
            out[key] = coerceBooleanValue(value);
        }
        else if (Array.isArray(value)) {
            out[key] = value.map(item => item !== null && typeof item === 'object' && !Array.isArray(item)
                ? coerceMetadataBooleans(item)
                : item);
        }
        else if (value !== null && typeof value === 'object') {
            out[key] = coerceMetadataBooleans(value);
        }
        else {
            out[key] = value;
        }
    }
    return out;
}
function metadataNeedsCoercion(meta) {
    return JSON.stringify(meta) !== JSON.stringify(coerceMetadataBooleans(meta));
}
function parseAndCoerceMetadata(metadataJson) {
    const parsed = JSON.parse(metadataJson);
    return coerceMetadataBooleans(parsed);
}
/** @internal type guard for known boolean keys */
function isBooleanMetadataKey(key) {
    return BOOLEAN_KEY_SET.has(key);
}
//# sourceMappingURL=metadata-coerce.js.map