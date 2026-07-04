// Read-time trust annotations: staleness (this task) and provenance
// drift (Task 5). Annotations are additive fields on the returned entry —
// the stored row is never modified by reading it.

import { SCHEMA_KINDS, type Entry } from 'tim-core';
import { commitsSince } from './provenance.js';

const DAY_MS = 86_400_000;

function staleDays(): number {
  const raw = Number(process.env.TIM_STALE_DAYS);
  return Number.isFinite(raw) && raw > 0 ? raw : 90;
}

export interface StaleInfo {
  lastVerified: string;   // ISO — verified_at, else updated_at, else created_at
  daysSince: number;
}

export type TrustAnnotated = Entry & {
  stale?: StaleInfo;
  provenance_drift?: { commitsSince: number };
};

export function annotateTrust(entry: Entry, cwd: string): TrustAnnotated {
  const kind = typeof entry.metadata.kind === 'string' ? entry.metadata.kind : undefined;
  if (kind && SCHEMA_KINDS.has(kind)) return entry;

  const verifiedAt =
    typeof entry.metadata.verified_at === 'string' ? entry.metadata.verified_at : undefined;
  const lastVerified = verifiedAt ?? entry.updatedAt ?? entry.createdAt;
  const daysSince = Math.floor((Date.now() - Date.parse(lastVerified)) / DAY_MS);

  const annotated: TrustAnnotated = { ...entry };
  if (Number.isFinite(daysSince) && daysSince > staleDays()) {
    annotated.stale = { lastVerified, daysSince };
  }

  const prov = entry.metadata.provenance as { commit?: unknown } | undefined;
  if (prov && typeof prov.commit === 'string') {
    const drift = commitsSince(cwd, prov.commit);
    if (drift !== null && drift > 0) {
      annotated.provenance_drift = { commitsSince: drift };
    }
  }

  return annotated.stale || annotated.provenance_drift ? annotated : entry;
}
