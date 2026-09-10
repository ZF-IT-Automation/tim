/**
 * Read-time temporal projection — exposes state and relations without leaking
 * secret/suppressed entry bodies (#36).
 */

import type { Edge, TemporalEligibilityState } from 'tim-core';
import { parseTemporalMetadata, temporalEligibilityAt } from 'tim-core';
import type { TimStore } from './store.js';
import { resolveEntrySourceStatus } from './evidence-resolve.js';

export interface PresentedTemporalRef {
  entryId: string;
  status: 'available' | 'unavailable' | 'suppressed';
  title?: string;
}

export interface PresentedTemporal {
  state: TemporalEligibilityState;
  valid_from?: string;
  valid_until?: string;
  superseded_at?: string;
  superseded_by?: PresentedTemporalRef;
  supersedes: PresentedTemporalRef[];
  contradictions: PresentedTemporalRef[];
  as_of: string;
}

async function presentEntryRef(
  store: TimStore,
  entryId: string,
): Promise<PresentedTemporalRef> {
  const status = await resolveEntrySourceStatus(store, entryId);
  if (status === 'available') {
    const entry = await store.read(entryId, { includeChildren: false, enforceSuppression: true });
    return {
      entryId,
      status: 'available',
      ...(entry?.title ? { title: entry.title } : {}),
    };
  }
  return { entryId, status: status === 'suppressed' ? 'suppressed' : 'unavailable' };
}

export async function projectEntryTemporal(
  store: TimStore,
  entryId: string,
  metadata: Record<string, unknown>,
  edges: Edge[],
  asOf: Date = new Date(),
): Promise<PresentedTemporal> {
  const temporal = parseTemporalMetadata(metadata.temporal);
  const { state } = temporalEligibilityAt(temporal, asOf);

  const supersedes = await Promise.all(
    edges
      .filter(e => e.type === 'supersedes' && e.sourceId === entryId)
      .map(e => presentEntryRef(store, e.targetId)),
  );

  let supersededBy: PresentedTemporalRef | undefined;
  if (temporal?.supersededBy) {
    supersededBy = await presentEntryRef(store, temporal.supersededBy);
  }

  const contradictions = await Promise.all(
    edges
      .filter(e =>
        (e.type === 'contradicts' || e.type === 'contradicted_by')
        && (e.sourceId === entryId || e.targetId === entryId),
      )
      .map(e => presentEntryRef(store, e.sourceId === entryId ? e.targetId : e.sourceId)),
  );

  return {
    state,
    ...(temporal?.validFrom ? { valid_from: temporal.validFrom } : {}),
    ...(temporal?.validUntil ? { valid_until: temporal.validUntil } : {}),
    ...(temporal?.supersededAt ? { superseded_at: temporal.supersededAt } : {}),
    ...(supersededBy ? { superseded_by: supersededBy } : {}),
    supersedes,
    contradictions,
    as_of: asOf.toISOString(),
  };
}
