/**
 * FTS5 pre-filter query variant expansion — deterministic, no DB/LLM.
 */
/** Hartkodierte Synonym-Mini-Map für Query-Expansion (Phase 1.0). */
export declare const SYNONYM_MAP: Map<string, string[]>;
/**
 * Strip common DE/EN suffixes (-en, -er, -e, -s). Keeps result ≥3 chars or returns original.
 * Multi-word input: each token lemmatized separately.
 */
export declare function lemmatize(word: string): string;
/**
 * All Levenshtein-distance-1 variants: single-char insertions, deletions, substitutions.
 * Capped at 20. Empty for words shorter than 4 chars.
 */
export declare function fuzzyOne(word: string): string[];
/**
 * Generate FTS5 query variants: original, lowercase, lemmatized, synonyms, fuzzy per word.
 * Deduplicated, capped at 12. Higher-priority variants kept when cap trims tail.
 */
export declare function expandQueryVariants(query: string): string[];
/**
 * Deduplicate items by `id`, preserving first-occurrence order.
 */
export declare function dedupeById<T extends {
    id: string;
}>(items: T[]): T[];
//# sourceMappingURL=query-variants.d.ts.map