import Database from 'better-sqlite3';
import type { TenantRecord, TenantTier } from './quotas.js';
import type { QuotaUsage } from './quotas.js';
export interface RegistryStats {
    tenantCount: number;
    totalEntries: number;
    totalBytes: number;
}
export declare class TenantRegistry {
    private dataDir;
    private db;
    constructor(dataDir: string);
    register(tier?: TenantTier): TenantRecord;
    setTenantTier(tenantId: string, tier: TenantTier): boolean;
    resolveToken(token: string): TenantRecord | null;
    tenantDbPath(tenantId: string): string;
    private migrateTenantDbIfNeeded;
    private initTenantDb;
    getTenantDb(tenantId: string): Database.Database;
    getUsage(tenantId: string): QuotaUsage;
    aggregateStats(): RegistryStats;
    close(): void;
}
//# sourceMappingURL=tenant-registry.d.ts.map