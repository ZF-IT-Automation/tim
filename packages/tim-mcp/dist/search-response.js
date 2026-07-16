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
    'completion_evidence',
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
        const bounded = unicodeExcerpt(value, MAX_SEARCH_METADATA_STRING_CODE_POINTS);
        return { value: bounded.excerpt, truncated: bounded.truncated };
    }
    if (typeof value === 'number') {
        return { value: Number.isFinite(value) ? value : undefined, truncated: !Number.isFinite(value) };
    }
    if (typeof value === 'boolean' || value === null)
        return { value, truncated: false };
    return { value: undefined, truncated: value !== undefined };
}
function boundedTask(value) {
    if (typeof value !== 'object' || value === null)
        return boundedScalar(value);
    if (Array.isArray(value))
        return { value: undefined, truncated: true };
    const task = value;
    const selected = {};
    let truncated = Object.keys(task).some(key => !SEARCH_TASK_KEYS.includes(key));
    for (const key of SEARCH_TASK_KEYS) {
        const field = boundedScalar(task[key]);
        truncated ||= field.truncated;
        if (field.value !== undefined)
            selected[key] = field.value;
    }
    return { value: selected, truncated };
}
function selectMetadata(metadata) {
    const selected = {};
    let truncated = false;
    for (const key of SEARCH_METADATA_KEYS) {
        const value = key === 'task' ? boundedTask(metadata[key]) : boundedScalar(metadata[key]);
        truncated ||= value.truncated;
        if (value.value !== undefined)
            selected[key] = value.value;
    }
    return { value: selected, truncated };
}
function boundedTags(tags) {
    let truncated = tags.length > exports.MAX_SEARCH_TAGS;
    const value = tags.slice(0, exports.MAX_SEARCH_TAGS).map(tag => {
        const bounded = unicodeExcerpt(tag, exports.MAX_SEARCH_TAG_CODE_POINTS);
        truncated ||= bounded.truncated;
        return bounded.excerpt;
    });
    return { value, truncated };
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
    let resultTruncated = false;
    for (const entry of entries) {
        const excerpt = unicodeExcerpt(entry.content, boundedExcerptCodePoints);
        const title = unicodeExcerpt(entry.title, exports.MAX_SEARCH_TITLE_CODE_POINTS);
        const tags = boundedTags(entry.tags);
        const metadata = selectMetadata(entry.metadata);
        const candidateTruncated = excerpt.truncated || title.truncated || tags.truncated || metadata.truncated;
        const candidate = {
            id: entry.id,
            title: title.excerpt,
            excerpt: excerpt.excerpt,
            tags: tags.value ?? [],
            metadata: metadata.value ?? {},
        };
        const proposed = responseFor([...accepted, candidate], entries.length, resultTruncated || candidateTruncated);
        if (Buffer.byteLength(JSON.stringify(proposed), 'utf8') <= effectiveMaxBytes) {
            accepted.push(candidate);
            resultTruncated ||= candidateTruncated;
        }
        else {
            break;
        }
    }
    return responseFor(accepted, entries.length, resultTruncated);
}
//# sourceMappingURL=search-response.js.map