import type { TimStore } from 'tim-store';
import { type LegacyMetadataType } from 'tim-core';
export interface MigrationEntryResult {
    id: string;
    title: string;
    oldTags: string[];
    newTags: string[];
    typeSet: LegacyMetadataType | null;
    changed: boolean;
}
export interface MigrationReport {
    scanned: number;
    migrated: number;
    skipped: number;
    errors: Array<{
        id: string;
        error: string;
    }>;
    sampleChanges: MigrationEntryResult[];
}
/**
 * Scan all entries and migrate any that carry a legacy type tag
 * (`#rule`, `#human` — with or without leading `#`, any case, any
 * surrounding whitespace) to use `metadata.type` instead. Idempotent.
 *
 * - Already-migrated entries (have `metadata.type` set, no legacy tag)
 *   are skipped silently.
 * - Entries with a legacy tag AND no `metadata.type` are migrated:
 *   the recognized tag is removed from the `tags` array, and
 *   `metadata.type` is set to the corresponding enum value.
 * - If multiple recognized tags are present (e.g. both `#rule` and
 *   `#human`), the first match wins and a warning is recorded in
 *   the report.
 */
export declare function migrateTagsToTypes(store: TimStore, options?: {
    dryRun?: boolean;
    sampleLimit?: number;
}): Promise<MigrationReport>;
//# sourceMappingURL=tags-to-types.d.ts.map