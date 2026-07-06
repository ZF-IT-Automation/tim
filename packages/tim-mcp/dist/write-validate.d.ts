import { SCHEMA_KINDS } from 'tim-core';
export { SCHEMA_KINDS };
/** Minimum number of tags required on non-schema entries. */
export declare const MIN_TAGS_FOR_USER_CONTENT = 2;
export interface WriteTagsValidationOk {
    ok: true;
}
export interface WriteTagsValidationError {
    ok: false;
    error: 'tags_required';
    message: string;
    metadata_hint: Record<string, unknown>;
}
export type WriteTagsValidationResult = WriteTagsValidationOk | WriteTagsValidationError;
/**
 * Decide whether a tim_write call satisfies the "tags required" rule.
 *
 * - Schema entries (matching a kind in SCHEMA_KINDS) are exempt — tags optional.
 * - All other entries (user content: notes, tasks, learnings, ideas, …) require
 *   at least MIN_TAGS_FOR_USER_CONTENT tags.
 *
 * @param tags   Tags the caller passed (default [] when omitted).
 * @param metadata  Entry metadata — we look at `metadata.kind`.
 * @param parentMetadataKind  Optional: kind of the parent entry. A child of a
 *   schema-kind parent (e.g. a leaf under a 'section') is still user content
 *   and therefore not exempt — we only use `metadata.kind`, not parent kind.
 */
export declare function validateWriteTags(tags: string[] | undefined, metadata: Record<string, unknown> | undefined): WriteTagsValidationResult;
/**
 * Fill missing tags / infer section kind so tim_write can proceed when callers
 * omit tags (e.g. integration tests, quick MCP writes).
 */
export declare function supplementWriteTags(tags: string[] | undefined, metadata: Record<string, unknown> | undefined, parentKind?: string): {
    tags: string[];
    metadata: Record<string, unknown> | undefined;
};
//# sourceMappingURL=write-validate.d.ts.map