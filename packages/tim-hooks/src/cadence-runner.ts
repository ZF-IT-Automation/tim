import type { TimStore } from 'tim-store';
import { SessionManager, deriveCounters } from 'tim-store';
import { loadConfig } from 'tim-core';
import { getCheckpointEveryN, shouldAutoCheckpoint } from './cadence.js';

export interface CadenceResult {
  exchangeCount: number;
  autoCheckpoint?: boolean;
  checkpointEntryId?: string;
}

/**
 * After logging exchanges: derive counters from the store, optionally auto-checkpoint.
 */
export async function afterExchangeLogged(
  store: TimStore,
  sessionId: string,
  _cwd: string,
): Promise<CadenceResult> {
  const { exchangeCount } = await deriveCounters(store, sessionId);
  const everyN = getCheckpointEveryN(loadConfig());
  const result: CadenceResult = { exchangeCount };

  if (shouldAutoCheckpoint(exchangeCount, everyN)) {
    const sessions = new SessionManager(store);
    const entry = await sessions.checkpoint(sessionId);
    result.autoCheckpoint = true;
    result.checkpointEntryId = entry.id;
  }

  return result;
}
