import type { Entry } from 'tim-core';
export declare const DEFAULT_SEARCH_EXCERPT_CODE_POINTS = 500;
export declare const SEARCH_RESPONSE_MAX_BYTES: number;
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
export declare function buildBoundedSearchResponse(entries: Entry[], excerptCodePoints?: number, maxBytes?: number): BoundedSearchResponse;
//# sourceMappingURL=search-response.d.ts.map