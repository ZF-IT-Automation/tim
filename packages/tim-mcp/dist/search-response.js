"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_SEARCH_TAG_CODE_POINTS = exports.MAX_SEARCH_TAGS = exports.MAX_SEARCH_TITLE_CODE_POINTS = exports.SEARCH_RESPONSE_MIN_BYTES = exports.SEARCH_RESPONSE_MAX_BYTES = exports.DEFAULT_SEARCH_EXCERPT_CODE_POINTS = void 0;
exports.buildBoundedSearchResponse = buildBoundedSearchResponse;
exports.DEFAULT_SEARCH_EXCERPT_CODE_POINTS = 500;
exports.SEARCH_RESPONSE_MAX_BYTES = 24 * 1024;
exports.SEARCH_RESPONSE_MIN_BYTES = 128;
exports.MAX_SEARCH_TITLE_CODE_POINTS = 256;
exports.MAX_SEARCH_TAGS = 16;
exports.MAX_SEARCH_TAG_CODE_POINTS = 64;
const MAX_SEARCH_METADATA_STRING_CODE_POINTS = 128;
const SEARCH_TASK_KEYS = [
    'status',
    'priority',
    'due',
    'due_date',
    'assignee',
    'order',
];
const SEARCH_METADATA_KEYS = [
    'kind',
    'label',
    'type',
    'status',
    'project_ref',
    'task',
];
function unicodeExcerpt(text, maxCodePoints) {
    if (maxCodePoints <= 0)
        return { excerpt: '', truncated: text.length > 0 };
    const points = [];
    for (const point of text) {
        if (points.length === maxCodePoints) {
            points[points.length - 1] = '…';
            return { excerpt: points.join(''), truncated: true };
        }
        points.push(point);
    }
    return { excerpt: points.join(''), truncated: false };
}
function boundedScalar(value) {
    if (typeof value === 'string') {
        return unicodeExcerpt(value, MAX_SEARCH_METADATA_STRING_CODE_POINTS).excerpt;
    }
    if (typeof value === 'number')
        return Number.isFinite(value) ? value : undefined;
    if (typeof value === 'boolean' || value === null)
        return value;
    return undefined;
}
function boundedTask(value) {
    const scalar = boundedScalar(value);
    if (scalar !== undefined)
        return scalar;
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return undefined;
    const task = value;
    const selected = {};
    for (const key of SEARCH_TASK_KEYS) {
        const field = boundedScalar(task[key]);
        if (field !== undefined)
            selected[key] = field;
    }
    return selected;
}
function selectMetadata(metadata) {
    const selected = {};
    for (const key of SEARCH_METADATA_KEYS) {
        const value = key === 'task' ? boundedTask(metadata[key]) : boundedScalar(metadata[key]);
        if (value !== undefined)
            selected[key] = value;
    }
    return selected;
}
function boundedTags(tags) {
    return tags.slice(0, exports.MAX_SEARCH_TAGS).map(tag => unicodeExcerpt(tag, exports.MAX_SEARCH_TAG_CODE_POINTS).excerpt);
}
function boundedMaxBytes(maxBytes) {
    if (!Number.isFinite(maxBytes))
        return exports.SEARCH_RESPONSE_MAX_BYTES;
    return Math.min(exports.SEARCH_RESPONSE_MAX_BYTES, Math.max(exports.SEARCH_RESPONSE_MIN_BYTES, Math.floor(maxBytes)));
}
function responseFor(results, total, excerptTruncated) {
    const omitted = total - results.length;
    return {
        results,
        returned: results.length,
        omitted,
        truncated: omitted > 0 || excerptTruncated,
    };
}
function buildBoundedSearchResponse(entries, excerptCodePoints = exports.DEFAULT_SEARCH_EXCERPT_CODE_POINTS, maxBytes = exports.SEARCH_RESPONSE_MAX_BYTES) {
    const accepted = [];
    const boundedExcerptCodePoints = Math.min(Math.max(0, excerptCodePoints), exports.DEFAULT_SEARCH_EXCERPT_CODE_POINTS);
    const effectiveMaxBytes = boundedMaxBytes(maxBytes);
    let excerptTruncated = false;
    for (const entry of entries) {
        const excerpt = unicodeExcerpt(entry.content, boundedExcerptCodePoints);
        const candidate = {
            id: entry.id,
            title: unicodeExcerpt(entry.title, exports.MAX_SEARCH_TITLE_CODE_POINTS).excerpt,
            excerpt: excerpt.excerpt,
            tags: boundedTags(entry.tags),
            metadata: selectMetadata(entry.metadata),
        };
        const proposed = responseFor([...accepted, candidate], entries.length, excerptTruncated || excerpt.truncated);
        if (Buffer.byteLength(JSON.stringify(proposed), 'utf8') <= effectiveMaxBytes) {
            accepted.push(candidate);
            excerptTruncated ||= excerpt.truncated;
        }
        else {
            break;
        }
    }
    return responseFor(accepted, entries.length, excerptTruncated);
}
//# sourceMappingURL=search-response.js.map