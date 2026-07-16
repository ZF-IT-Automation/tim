/** Known metadata keys stored as JSON booleans (legacy data may use 1/0 or "true"/"false"). */
export declare const BOOLEAN_METADATA_KEYS: readonly ["task", "archived", "pinned", "favorite", "irrelevant", "done", "completed", "cancelled", "in_progress"];
type BooleanMetadataKey = (typeof BOOLEAN_METADATA_KEYS)[number];
export declare function normalizeTaskValue(value: unknown): boolean | unknown;
export declare function isTaskMarker(value: unknown): boolean;
/** Idea marker is a nested object only (no boolean shorthand). */
export declare function isIdeaMarker(value: unknown): boolean;
export declare function coerceMetadataBooleans(meta: Record<string, unknown>): Record<string, unknown>;
export declare function metadataNeedsCoercion(meta: Record<string, unknown>): boolean;
export declare function parseAndCoerceMetadata(metadataJson: string): Record<string, unknown>;
/** @internal type guard for known boolean keys */
export declare function isBooleanMetadataKey(key: string): key is BooleanMetadataKey;
export {};
//# sourceMappingURL=metadata-coerce.d.ts.map