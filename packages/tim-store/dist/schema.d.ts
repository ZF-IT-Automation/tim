import Database from 'better-sqlite3';
export declare const MIGRATIONS: {
    version: number;
    sql: string;
}[];
export declare function getCurrentVersion(): number;
export interface RunMigrationsOptions {
    /** When false (default), refuse pending upgrades on version > 0. Version 0 always bootstraps. */
    allowMigrations?: boolean;
}
export interface MigrationRunResult {
    from: number;
    to: number;
    applied: number[];
    backupPath: string | null;
}
export declare function runMigrations(db: Database.Database, migrations?: {
    version: number;
    sql: string;
}[], options?: RunMigrationsOptions): MigrationRunResult | null;
export declare function createTriggers(db: Database.Database): void;
//# sourceMappingURL=schema.d.ts.map