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

export const TIER_QUOTAS: Record<TenantTier, QuotaLimits> = {
  free: { maxEntries: 1000, maxBytes: 10 * 1024 * 1024 },
  pro: { maxEntries: null, maxBytes: null },
};

export function getQuotaLimits(tier: TenantTier): QuotaLimits {
  return TIER_QUOTAS[tier];
}

export interface QuotaUsage {
  entryCount: number;
  totalBytes: number;
}

export function quotaExceeded(
  tier: TenantTier,
  usage: QuotaUsage,
  additionalEntries: number,
  additionalBytes: number,
): { exceeded: boolean; reason?: string } {
  const limits = getQuotaLimits(tier);
  if (limits.maxEntries != null) {
    const next = usage.entryCount + additionalEntries;
    if (next > limits.maxEntries) {
      return { exceeded: true, reason: `Entry quota exceeded (${limits.maxEntries} max for ${tier})` };
    }
  }
  if (limits.maxBytes != null) {
    const next = usage.totalBytes + additionalBytes;
    if (next > limits.maxBytes) {
      return { exceeded: true, reason: `Storage quota exceeded (${limits.maxBytes} bytes max for ${tier})` };
    }
  }
  return { exceeded: false };
}
