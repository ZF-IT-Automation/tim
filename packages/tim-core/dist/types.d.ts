/** 14 built-in metadata.type values (Schema v3 Phase 1). */
export declare const BUILTIN_METADATA_TYPES: readonly ["standard", "project", "task", "error", "decision", "learning", "idea", "log", "commit", "summary", "session", "batch_summary", "exchange", "event"];
export type BuiltinMetadataType = (typeof BUILTIN_METADATA_TYPES)[number];
/** Phase 0 legacy values — still valid in DB, not part of the 14 built-ins. */
export declare const LEGACY_METADATA_TYPES: readonly ["rule", "human"];
export type LegacyMetadataType = (typeof LEGACY_METADATA_TYPES)[number];
export type MetadataType = BuiltinMetadataType | LegacyMetadataType;
/** @deprecated Use BUILTIN_METADATA_TYPES — kept for callers expecting BUILTIN_TYPES */
export declare const BUILTIN_TYPES: readonly ["standard", "project", "task", "error", "decision", "learning", "idea", "log", "commit", "summary", "session", "batch_summary", "exchange", "event"];
export type BuiltinType = BuiltinMetadataType;
export declare const METADATA_TYPES: readonly ["standard", "project", "task", "error", "decision", "learning", "idea", "log", "commit", "summary", "session", "batch_summary", "exchange", "event"];
export declare const ALL_METADATA_TYPES: readonly ["standard", "project", "task", "error", "decision", "learning", "idea", "log", "commit", "summary", "session", "batch_summary", "exchange", "event", "rule", "human"];
/** Nested task sub-section (Schema v3 Phase 2a). */
export interface TaskMetadata {
    status?: 'todo' | 'in_progress' | 'done' | 'cancelled';
    priority?: 'low' | 'medium' | 'high' | 'critical';
    due_date?: string;
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
export declare function isBuiltinMetadataType(value: unknown): value is BuiltinMetadataType;
export declare function isBuiltinType(value: unknown): value is BuiltinMetadataType;
export declare function isMetadataType(value: unknown): value is MetadataType;
/** Normalize legacy #rule / #human tags (Phase 0). Other types use section migration. */
export declare function normalizeLegacyTypeTag(tag: string | null | undefined): LegacyMetadataType | null;
export declare const DEPRECATED_STATUS_TAGS: Set<string>;
export declare const DEPRECATED_PRIORITY_TAGS: Set<string>;
export declare const DEPRECATED_TAGS: Set<string>;
export declare function isDeprecatedTag(tag: string): boolean;
export declare function stripDeprecatedTags(tags: string[]): {
    clean: string[];
    removed: string[];
};
//# sourceMappingURL=types.d.ts.map