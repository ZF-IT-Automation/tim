import type { Entry } from 'tim-core';
import type { TimStore } from 'tim-store';
export interface TimRowEntry {
    id: string;
    parent_id: string | null;
    title: string;
    content: string;
    content_type: string;
    depth: number;
    confidence: number;
    created_at: string;
    accessed_at: string;
    decay_rate: number;
    visibility: number;
    tags: string;
    irrelevant: number;
    favorite: number;
    tombstoned_at: string | null;
    metadata: string;
}
export interface ExportOptions {
    format?: 'hmem' | 'text';
    entryFilter?: (entry: Entry) => boolean;
}
export interface HmemExportResult {
    targetPath: string;
    entriesExported: number;
    nodesExported: number;
    linksExported: number;
}
export declare function exportToMarkdown(store: TimStore, options?: ExportOptions): string;
export declare function exportToHmem(store: TimStore, targetPath: string, options?: ExportOptions): HmemExportResult;
export declare function tim_export(store: TimStore, targetPath?: string, options?: ExportOptions): string | HmemExportResult;
//# sourceMappingURL=export.d.ts.map