import type { TimStore } from 'tim-store';
export interface ImportOptions {
    dryRun?: boolean;
    deduplicate?: boolean;
    /** If true, bypass idempotency guard and force re-import of already-migrated entries. */
    force?: boolean;
}
export interface ImportConflict {
    label: string;
    action: 'merged' | 'remapped' | 'skipped';
    detail?: string;
}
export interface ImportReport {
    sourcePath: string;
    format: 'v2' | 'old' | 'unknown';
    dryRun: boolean;
    entriesImported: number;
    nodesImported: number;
    edgesImported: number;
    skipped: number;
    remapped: number;
    conflicts: ImportConflict[];
    newCount: number;
    changedCount: number;
    warnings: string[];
}
export declare function tim_import(store: TimStore, sourcePath: string, options?: ImportOptions): ImportReport;
export interface RepairReport {
    sourcePath: string;
    format: 'v2' | 'old' | 'unknown';
    dryRun: boolean;
    matched: number;
    repaired: number;
    warnings: string[];
}
/**
 * Repair irrelevant/favorite flags (and empty tags) on already-imported
 * entries from the source .hmem file, matched via metadata.hmemUid.
 *
 * Motivation: the 2026-05-30 production migration wrote inverted flags —
 * nearly every imported entry landed with irrelevant=1, hiding the entire
 * hmem heritage from every TIM tool. The source file is authoritative for
 * these mirror entries. Repaired rows are staged so the fix syncs.
 */
export declare function repairImportFlags(store: TimStore, sourcePath: string, options?: {
    dryRun?: boolean;
}): RepairReport;
export declare function labelFromMetadata(metadata: Record<string, unknown>): string | null;
//# sourceMappingURL=import.d.ts.map