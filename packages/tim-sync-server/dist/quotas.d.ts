export type TenantTier = 'free' | 'pro';
export interface TenantRecord {
    id: string;
    token: string;
    tier: TenantTier;
    createdAt: string;
}
export interface QuotaLimits {
    maxEntries: number | null;
    maxBytes: number | null;
}
export declare const TIER_QUOTAS: Record<TenantTier, QuotaLimits>;
export declare function getQuotaLimits(tier: TenantTier): QuotaLimits;
export interface QuotaUsage {
    entryCount: number;
    totalBytes: number;
}
export declare function quotaExceeded(tier: TenantTier, usage: QuotaUsage, additionalEntries: number, additionalBytes: number): {
    exceeded: boolean;
    reason?: string;
};
//# sourceMappingURL=quotas.d.ts.map