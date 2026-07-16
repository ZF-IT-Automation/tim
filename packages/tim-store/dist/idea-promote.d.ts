export declare function isCodingNeedsReview(metadata: Record<string, unknown>): boolean;
export interface PromoteResult {
    metadata: Record<string, unknown>;
    didPromote: boolean;
    error?: string;
}
export declare function applyIdeaPromote(metadata: Record<string, unknown>, nowIso?: string): PromoteResult;
//# sourceMappingURL=idea-promote.d.ts.map