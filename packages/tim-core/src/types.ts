// packages/tim-core/src/types.ts
// Built-in 14 metadata types for TIM Schema v3 (Tags → Metadata refactor)

/** 14 built-in metadata.type values (Schema v3 Phase 1). */
export const BUILTIN_METADATA_TYPES = [
  'standard',
  'project',
  'task',
  'error',
  'decision',
  'learning',
  'idea',
  'log',
  'commit',
  'summary',
  'session',
  'batch_summary',
  'exchange',
  'event',
] as const;

export type BuiltinMetadataType = (typeof BUILTIN_METADATA_TYPES)[number];

/** Phase 0 legacy values — still valid in DB, not part of the 14 built-ins. */
export const LEGACY_METADATA_TYPES = ['rule', 'human'] as const;
export type LegacyMetadataType = (typeof LEGACY_METADATA_TYPES)[number];

export type MetadataType = BuiltinMetadataType | LegacyMetadataType;

/** @deprecated Use BUILTIN_METADATA_TYPES — kept for callers expecting BUILTIN_TYPES */
export const BUILTIN_TYPES = BUILTIN_METADATA_TYPES;
export type BuiltinType = BuiltinMetadataType;

export const METADATA_TYPES = BUILTIN_METADATA_TYPES;
export const ALL_METADATA_TYPES = [
  ...BUILTIN_METADATA_TYPES,
  ...LEGACY_METADATA_TYPES,
] as const;

/** Nested task sub-section (Schema v3 Phase 2a). */
export interface TaskMetadata {
  status?: 'todo' | 'in_progress' | 'done' | 'cancelled';
  priority?: 'low' | 'medium' | 'high' | 'critical';
  due_date?: string; // ISO 8601 date
  completion_evidence?: string | null;
}

/** Stub for Phase 2b */
export interface RuleMetadata {
  trigger?: string;
  action?: string;
}

/** Nested bug sub-section (Schema v3 Phase 2c). */
export interface BugMetadata {
  severity?: 'P0' | 'P1' | 'P2' | 'P3';
  status?: 'open' | 'in_progress' | 'fixed' | 'wontfix';
}

/** Entry metadata — `type` is the Schema v3 semantic classifier. */
export interface EntryMetadata {
  type?: MetadataType;
  kind?: string;
  label?: string;
  /** When true, entry is secret (materialized on descendants). */
  secret?: boolean;
  [key: string]: unknown;
}

export function isBuiltinMetadataType(value: unknown): value is BuiltinMetadataType {
  return typeof value === 'string' && (BUILTIN_METADATA_TYPES as readonly string[]).includes(value);
}

export function isBuiltinType(value: unknown): value is BuiltinMetadataType {
  return isBuiltinMetadataType(value);
}

export function isMetadataType(value: unknown): value is MetadataType {
  return typeof value === 'string' && (ALL_METADATA_TYPES as readonly string[]).includes(value);
}

/** Normalize legacy #rule / #human tags (Phase 0). Other types use section migration. */
export function normalizeLegacyTypeTag(tag: string | null | undefined): LegacyMetadataType | null {
  if (typeof tag !== 'string') return null;
  const cleaned = tag.trim().replace(/^#/, '').toLowerCase();
  if (cleaned === 'rule' || cleaned === 'human') return cleaned;
  return null;
}

// Status/priority tags — DEPRECATED. metadata.task.status is source-of-truth.
export const DEPRECATED_STATUS_TAGS = new Set([
  '#todo', '#done', '#in_progress', '#cancelled',
  'todo', 'done', 'in_progress', 'cancelled',
]);
export const DEPRECATED_PRIORITY_TAGS = new Set([
  '#priority-critical', '#priority-high', '#priority-medium', '#priority-low',
  'priority-critical', 'priority-high', 'priority-medium', 'priority-low',
]);
export const DEPRECATED_TAGS = new Set([
  ...DEPRECATED_STATUS_TAGS,
  ...DEPRECATED_PRIORITY_TAGS,
]);

export function isDeprecatedTag(tag: string): boolean {
  return DEPRECATED_TAGS.has(tag.toLowerCase());
}

export function stripDeprecatedTags(tags: string[]): { clean: string[]; removed: string[] } {
  const clean: string[] = [];
  const removed: string[] = [];
  for (const tag of tags) {
    if (isDeprecatedTag(tag)) {
      removed.push(tag);
    } else {
      clean.push(tag);
    }
  }
  return { clean, removed };
}
