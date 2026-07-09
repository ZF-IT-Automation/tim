import Database from 'better-sqlite3';
export type HmemFormat = 'v2' | 'old' | 'unknown';
export interface HmemFormatInfo {
    format: HmemFormat;
    entryCount: number;
    error?: string;
}
export interface HmemManifestLabel {
    label: string;
    prefix: string;
    seq: number;
    title: string;
    nodeCount: number;
}
export interface HmemManifest extends HmemFormatInfo {
    labels: HmemManifestLabel[];
}
export declare function detectHmemFormat(db: Database.Database): HmemFormat;
export declare function inspectHmemFile(sourcePath: string): HmemFormatInfo;
export declare function inspectHmemManifest(sourcePath: string): HmemManifest;
export declare function createV2HmemDatabase(targetPath: string): Database.Database;
export declare function parseLabel(label: string): {
    prefix: string;
    seq: number;
} | null;
export declare function formatLabel(prefix: string, seq: number): string;
//# sourceMappingURL=hmem-format.d.ts.map