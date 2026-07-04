// TIM MCP — write validation helpers
// Pure functions (no DB, no transport) so they can be unit-tested without MCP plumbing.

import { SCHEMA_KINDS } from 'tim-core';
export { SCHEMA_KINDS };

/** Minimum number of tags required on non-schema entries. */
export const MIN_TAGS_FOR_USER_CONTENT = 2;

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
export function validateWriteTags(
  tags: string[] | undefined,
  metadata: Record<string, unknown> | undefined,
): WriteTagsValidationResult {
  const kind = typeof metadata?.kind === 'string' ? (metadata.kind as string) : undefined;

  // Schema entries are exempt.
  if (kind && SCHEMA_KINDS.has(kind)) {
    return { ok: true };
  }

  const tagCount = tags?.length ?? 0;
  if (tagCount >= MIN_TAGS_FOR_USER_CONTENT) {
    return { ok: true };
  }

  // Build a metadata hint that points the caller at the fix.
  const metadataHint: Record<string, unknown> = {};
  if (kind) metadataHint.kind = kind;
  if (metadata?.topic) metadataHint.topic = metadata.topic;
  if (metadata?.title) metadataHint.title = metadata.title;
  if (Object.keys(metadataHint).length === 0) {
    metadataHint.note = 'Pass at least 2 tags in the `tags` array.';
  }

  return {
    ok: false,
    error: 'tags_required',
    message:
      'Non-schema entries require at least 2 tags. ' +
      'Schema entries (sections, project roots, sessions) are exempt.',
    metadata_hint: metadataHint,
  };
}

/**
 * Fill missing tags / infer section kind so tim_write can proceed when callers
 * omit tags (e.g. integration tests, quick MCP writes).
 */
export function supplementWriteTags(
  tags: string[] | undefined,
  metadata: Record<string, unknown> | undefined,
  parentKind?: string,
): { tags: string[]; metadata: Record<string, unknown> | undefined } {
  const meta = metadata ? { ...metadata } : {};
  const kind = typeof meta.kind === 'string' ? meta.kind : undefined;

  if (kind && SCHEMA_KINDS.has(kind)) {
    return { tags: tags ?? [], metadata: meta };
  }

  if (parentKind === 'project' && !kind) {
    meta.kind = 'section';
    return { tags: tags ?? [], metadata: meta };
  }

  const tagList = [...(tags ?? [])];
  if (tagList.length >= MIN_TAGS_FOR_USER_CONTENT) {
    return { tags: tagList, metadata: meta };
  }

  const primary = kind ? `#${kind}` : '#entry';
  const merged = [...new Set([...tagList, primary, '#tim'])];
  while (merged.length < MIN_TAGS_FOR_USER_CONTENT) {
    merged.push('#tim');
  }
  return { tags: merged, metadata: meta };
}
