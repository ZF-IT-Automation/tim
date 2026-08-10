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
/**
 * Thrown when an existing schema is behind this build and the caller did not opt
 * in. Carries the versions so a consumer can render its own message; the `code`
 * tag is what cross-package callers should test — `instanceof` breaks if two
 * copies of tim-store end up loaded.
 */
export declare class SchemaMigrationPendingError extends Error {
    readonly from: number;
    readonly to: number;
    readonly pending: number[];
    readonly code = "SCHEMA_MIGRATION_PENDING";
    constructor(from: number, to: number, pending: number[], message: string);
}
export declare function isSchemaMigrationPendingError(error: unknown): error is SchemaMigrationPendingError;
export declare function runMigrations(db: Database.Database, migrations?: {
    version: number;
    sql: string;
}[], options?: RunMigrationsOptions): MigrationRunResult | null;
export declare function createTriggers(db: Database.Database): void;
//# sourceMappingURL=schema.d.ts.map