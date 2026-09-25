import type { TimStore } from './store.js';

export type SummarySkipReason = 'exhausted';

export interface SummarySkipped {
  reason: SummarySkipReason;
  at: string;
  /** Exchange count when marked. Marks written before 2026-09-25 18:30 lack it. */
  exchanges?: number;
}

/** Session metadata written once when a summary will never be produced. */
export function readSummarySkipped(metadata: Record<string, unknown>): SummarySkipped | null {
  const raw = metadata.summary_skipped;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const reason = (raw as { reason?: unknown }).reason;
  const at = (raw as { at?: unknown }).at;
  if (reason !== 'exhausted' || typeof at !== 'string' || !at) return null;
  const exchanges = (raw as { exchanges?: unknown }).exchanges;
  return typeof exchanges === 'number' ? { reason, at, exchanges } : { reason, at };
}

/**
 * The mark holds only while the session has not grown: a session that logs
 * again after a give-up (a long session idle for a while) gets swept again.
 */
export function isSummarySkipCurrent(
  metadata: Record<string, unknown>,
  exchangeCount: number,
): boolean {
  return readSummarySkipped(metadata)?.exchanges === exchangeCount;
}

/**
 * Record that this session should not be summarized again at this exchange count.
 * Returns false when a current mark is already present or the session is missing.
 * Logs once, at info, and never via the error log.
 */
export async function markSummarySkipped(
  store: TimStore,
  sessionId: string,
  reason: SummarySkipReason,
  exchangeCount: number,
  now: () => string = () => new Date().toISOString(),
): Promise<boolean> {
  const session = await store.read(sessionId);
  if (!session || session.metadata.kind !== 'session') return false;
  if (isSummarySkipCurrent(session.metadata, exchangeCount)) return false;
  const at = now();
  await store.update(sessionId, {
    metadata: { summary_skipped: { reason, at, exchanges: exchangeCount } },
  });
  console.info(`session summary skipped (${reason}) — ${sessionId}`);
  return true;
}
