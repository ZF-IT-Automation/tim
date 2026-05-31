import type { TimStore } from 'tim-store';
export interface ImportOptions {
    dryRun?: boolean;
    deduplicate?: boolean;
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
export declare function labelFromMetadata(metadata: Record<string, unknown>): string | null;
//# sourceMappingURL=import.d.ts.map