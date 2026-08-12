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
/**
 * Turn the sync outbox on or off for this database.
 *
 * Off is enforced by a trigger rather than by a flag at each write, because
 * thirteen call sites across four packages stage rows and every one of them
 * would have to remember the check. The trigger fires only for `acked = 0`, so
 * an inbound record being applied locally is never swallowed — only the outbox
 * inserts a local change writes for itself.
 *
 * The state is idempotent: a store that opens a database already in the wanted
 * state touches no schema at all.
 */
export declare function setStagingEnabled(db: Database.Database, enabled: boolean): void;
//# sourceMappingURL=schema.d.ts.map