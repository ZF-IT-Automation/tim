// Read-time trust annotations: staleness (this task) and provenance
// drift (Task 5). Annotations are additive fields on the returned entry —
// the stored row is never modified by reading it.

import { SCHEMA_KINDS, type Entry } from 'tim-core';

const DAY_MS = 86_400_000;

function staleDays(): number {
  const raw = Number(process.env.TIM_STALE_DAYS);
  return Number.isFinite(raw) && raw > 0 ? raw : 90;
}

export interface StaleInfo {
  lastVerified: string;   // ISO — verified_at, else updated_at, else created_at
  daysSince: number;
}

export type TrustAnnotated = Entry & { stale?: StaleInfo };

export function annotateTrust(entry: Entry, _cwd: string): TrustAnnotated {
  const kind = typeof entry.metadata.kind === 'string' ? entry.metadata.kind : undefined;
  if (kind && SCHEMA_KINDS.has(kind)) return entry;

  const verifiedAt =
    typeof entry.metadata.verified_at === 'string' ? entry.metadata.verified_at : undefined;
  const lastVerified = verifiedAt ?? entry.updatedAt ?? entry.createdAt;
  const daysSince = Math.floor((Date.now() - Date.parse(lastVerified)) / DAY_MS);

  if (!Number.isFinite(daysSince) || daysSince <= staleDays()) return entry;
  return { ...entry, stale: { lastVerified, daysSince } };
}
