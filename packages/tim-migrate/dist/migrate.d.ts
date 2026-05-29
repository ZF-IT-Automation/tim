export interface MigrationReport {
    sourcePath: string;
    targetPath: string;
    entriesMigrated: number;
    edgesCreated: number;
    warnings: string[];
    duration: number;
    sourceEntryCount: number;
}
/**
 * Migrate from OLD format hmem file to TIM.
 * Old format: prefix+seq IDs, level_1..5 content, no parent_id.
 */
export declare function migrateHmemToTim(sourcePath: string, targetPath: string): Promise<MigrationReport>;
export declare function verifyHmemFile(path: string): {
    valid: boolean;
    entryCount: number;
    format?: string;
    error?: string;
};
//# sourceMappingURL=migrate.d.ts.map