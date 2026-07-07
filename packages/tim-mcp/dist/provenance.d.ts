export interface Provenance {
    commit: string;
    branch?: string;
}
export declare function captureProvenance(cwd: string): Provenance | null;
export declare function commitsSince(cwd: string, commit: string): number | null;
export declare function commitsSinceCached(cwd: string, commit: string): number | null;
/** Test helper — clears memoisation cache and hit/miss counters. */
export declare function clearCommitsSinceCache(): void;
/** Test helper — returns cache hit/miss counters since last clear. */
export declare function getCommitsSinceCacheStats(): {
    hits: number;
    misses: number;
};
//# sourceMappingURL=provenance.d.ts.map