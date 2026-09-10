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
