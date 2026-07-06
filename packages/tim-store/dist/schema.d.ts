import Database from 'better-sqlite3';
export declare const MIGRATIONS: {
    version: number;
    sql: string;
}[];
export declare function getCurrentVersion(): number;
export declare function runMigrations(db: Database.Database, migrations?: {
    version: number;
    sql: string;
}[]): void;
export declare function createTriggers(db: Database.Database): void;
//# sourceMappingURL=schema.d.ts.map