import type Database from 'better-sqlite3';

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

/** Count one typed object and the largest ciphertext among ambiguous LWW maxima. */
export function countUsageFromDb(db: Database.Database): QuotaUsage {
  const row = db.prepare(`
    SELECT COUNT(*) AS c, COALESCE(SUM(bytes),0) AS bytes FROM (
      SELECT MAX(LENGTH(CAST(b.data AS BLOB))) AS bytes
      FROM blobs b
      WHERE NOT EXISTS (
        SELECT 1 FROM blobs newer
        WHERE newer.file_id=b.file_id AND newer.entity_type=b.entity_type AND newer.entity_key=b.entity_key
          AND newer.lww_device IS NOT NULL AND b.lww_device IS NOT NULL
          AND (newer.updated_at>b.updated_at OR
            (newer.updated_at=b.updated_at AND newer.lww_device>b.lww_device))
      )
      GROUP BY b.file_id, COALESCE(b.entity_type, 'legacy'),
        COALESCE(b.entity_key,b.client_proposed_id),
        CASE WHEN b.entity_type IS NULL OR b.entity_key IS NULL OR b.lww_device IS NULL THEN b.id ELSE 0 END
    )
  `).get() as { c: number; bytes: number };
  return { entryCount: row.c, totalBytes: row.bytes };
}
