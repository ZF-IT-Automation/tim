export interface PromoteResult {
    metadata: Record<string, unknown>;
    didPromote: boolean;
    error?: string;
}
export interface PromoteOptions {
    /**
     * When false, refuse to promote even if merged metadata contains
     * `idea.status: planned` — the entry was not an idea before the patch.
     * Omit on write (creating with planned is allowed).
     */
    hadIdeaMarker?: boolean;
}
export declare function applyIdeaPromote(metadata: Record<string, unknown>, nowIso?: string, opts?: PromoteOptions): PromoteResult;
//# sourceMappingURL=idea-promote.d.ts.map