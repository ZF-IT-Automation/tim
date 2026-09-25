/**
 * Read-time temporal projection (#36).
 */

import type { TimStore } from 'tim-store';
import { projectEntryTemporal, type PresentedTemporal } from 'tim-store';

export type { PresentedTemporal, PresentedTemporalRef } from 'tim-store';

export async function projectReadTemporal(
  store: TimStore,
  entryId: string,
  metadata: Record<string, unknown>,
  asOf: Date = new Date(),
): Promise<PresentedTemporal> {
  const edges = await store.getEdges(entryId, 'both');
  return projectEntryTemporal(store, entryId, metadata, edges, asOf);
}

/**
 * Current, with no relations and no validity window. `as_of` alone is not
 * information — it changes on every read.
 */
export function isDefaultPresentedTemporal(temporal: PresentedTemporal): boolean {
  return temporal.state === 'current'
    && temporal.supersedes.length === 0
    && temporal.contradictions.length === 0
    && temporal.superseded_by === undefined
    && temporal.valid_from === undefined
    && temporal.valid_until === undefined
    && temporal.superseded_at === undefined;
}
