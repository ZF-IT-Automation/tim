import { SCHEMA_KINDS } from 'tim-core';
export { SCHEMA_KINDS };
/** Bug statuses that mean the bug is no longer open. */
export declare const CLOSED_BUG_STATUSES: Set<string>;
/**
 * Stamp the section's declared entry type on a new child.
 *
 * A child of `Bugs` is a bug, a child of `Tasks` is a task — that should not
 * depend on whether whoever wrote it remembered the right metadata field. The
 * caller always wins: an explicit `type`, an existing marker object, or a schema
 * kind (sections, sessions, …) is left exactly as it came in.
 */
export declare function applySectionEntryType(metadata: Record<string, unknown> | undefined, sectionName: string | undefined, parentKind: string | undefined): Record<string, unknown> | undefined;
/**
 * A bug may only claim `fixed` with the commit that fixed it. The other closing
 * statuses are the honest way out for a bug that was closed without a change.
 *
 * Legacy bugs (`bug.legacy: true`) predate the rule and are exempt — their fix
 * commit is prose in the body, and reopening a dozen finished bugs to enforce a
 * rule retroactively would make the listing useless, which is what this is
 * meant to fix.
 */
export declare function validateBugStatus(metadata: Record<string, unknown> | undefined): {
    ok: true;
} | {
    ok: false;
    message: string;
};
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