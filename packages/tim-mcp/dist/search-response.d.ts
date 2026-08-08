import type { Entry } from 'tim-core';
export declare const DEFAULT_SEARCH_EXCERPT_CODE_POINTS = 500;
export declare const SEARCH_MAX_TOP_K = 100;
export declare const SEARCH_RESPONSE_MAX_BYTES: number;
export declare const SEARCH_RESPONSE_MIN_BYTES = 128;
export declare const MAX_SEARCH_TITLE_CODE_POINTS = 256;
export declare const MAX_SEARCH_TAGS = 16;
export declare const MAX_SEARCH_TAG_CODE_POINTS = 64;
export interface BoundedSearchResult {
    id: string;
    title: string;
    excerpt: string;
    tags: string[];
    metadata: Record<string, unknown>;
}
export interface BoundedSearchResponse {
    results: BoundedSearchResult[];
    returned: number;
    omitted: number;
    truncated: boolean;
}
/**
 * Oversized `topK` / `excerptChars` are clamped, not rejected. The 24 KiB
 * response budget truncates first, so a caller asking for 2000 excerpt chars
 * was never going to get them — failing the call just returns nothing instead
 * of something. The adjustment is reported back so nobody mistakes a trimmed
 * result set for the full one.
 */
export declare function clampSearchRequest(topK: number, excerptChars: number): {
    topK: number;
    excerptChars: number;
    clamped?: string[];
};
export declare function buildBoundedSearchResponse(entries: Entry[], excerptCodePoints?: number, maxBytes?: number): BoundedSearchResponse;
//# sourceMappingURL=search-response.d.ts.map