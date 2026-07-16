"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SEARCH_RESPONSE_MAX_BYTES = exports.DEFAULT_SEARCH_EXCERPT_CODE_POINTS = void 0;
exports.buildBoundedSearchResponse = buildBoundedSearchResponse;
exports.DEFAULT_SEARCH_EXCERPT_CODE_POINTS = 500;
exports.SEARCH_RESPONSE_MAX_BYTES = 24 * 1024;
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
    const points = Array.from(text);
    if (points.length <= maxCodePoints)
        return { excerpt: text, truncated: false };
    if (maxCodePoints === 1)
        return { excerpt: '…', truncated: true };
    return {
        excerpt: `${points.slice(0, maxCodePoints - 1).join('')}…`,
        truncated: true,
    };
}
function selectMetadata(metadata) {
    const selected = {};
    for (const key of SEARCH_METADATA_KEYS) {
        if (metadata[key] !== undefined)
            selected[key] = metadata[key];
    }
    return selected;
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
    let excerptTruncated = false;
    for (const entry of entries) {
        const excerpt = unicodeExcerpt(entry.content, boundedExcerptCodePoints);
        const candidate = {
            id: entry.id,
            title: entry.title,
            excerpt: excerpt.excerpt,
            tags: entry.tags,
            metadata: selectMetadata(entry.metadata),
        };
        const proposed = responseFor([...accepted, candidate], entries.length, excerptTruncated || excerpt.truncated);
        if (Buffer.byteLength(JSON.stringify(proposed), 'utf8') <= maxBytes) {
            accepted.push(candidate);
            excerptTruncated ||= excerpt.truncated;
        }
    }
    return responseFor(accepted, entries.length, excerptTruncated);
}
//# sourceMappingURL=search-response.js.map