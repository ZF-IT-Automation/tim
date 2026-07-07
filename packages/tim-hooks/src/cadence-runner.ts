import type { TimStore } from 'tim-store';
import { SessionManager, deriveCounters } from 'tim-store';
import { loadConfig } from 'tim-core';
import { writeMarker, readMarker, reconcileMarker } from './marker.js';
import { getCheckpointEveryN, shouldAutoCheckpoint } from './cadence.js';

export interface CadenceResult {
  exchangeCount: number;
  autoCheckpoint?: boolean;
  checkpointEntryId?: string;
}

/**
 * After logging exchanges: bump marker counter, optionally auto-checkpoint.
 */
export async function afterExchangeLogged(
  store: TimStore,
  sessionId: string,
  cwd: string,
): Promise<CadenceResult> {
  const marker = readMarker(cwd);
  if (!marker) {
    const { exchangeCount } = await deriveCounters(store, sessionId);
    return { exchangeCount };
  }

  const reconciled = await reconcileMarker(store, cwd);
  const everyN = getCheckpointEveryN(loadConfig());
  const result: CadenceResult = { exchangeCount: reconciled.exchanges };

  if (shouldAutoCheckpoint(reconciled.exchanges, everyN)) {
    const sessions = new SessionManager(store);
    const entry = await sessions.checkpoint(sessionId);
    result.autoCheckpoint = true;
    result.checkpointEntryId = entry.id;
    const after = await reconcileMarker(store, cwd);
    writeMarker(cwd, after);
  }

  return result;
}
