import type { TimStore } from './store.js';

export type SummarySkipReason = 'trivial' | 'exhausted';

export interface SummarySkipped {
  reason: SummarySkipReason;
  at: string;
}

/** Session metadata written once when a summary will never be produced. */
export function readSummarySkipped(metadata: Record<string, unknown>): SummarySkipped | null {
  const raw = metadata.summary_skipped;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const reason = (raw as { reason?: unknown }).reason;
  const at = (raw as { at?: unknown }).at;
  if ((reason !== 'trivial' && reason !== 'exhausted') || typeof at !== 'string' || !at) return null;
  return { reason, at };
}

/**
 * Record that this session should not be summarized again.
 * Returns false when the mark is already present or the session is missing.
 * Logs once, at info, and never via the error log.
 */
export async function markSummarySkipped(
  store: TimStore,
  sessionId: string,
  reason: SummarySkipReason,
  now: () => string = () => new Date().toISOString(),
): Promise<boolean> {
  const session = await store.read(sessionId);
  if (!session || session.metadata.kind !== 'session') return false;
  if (readSummarySkipped(session.metadata)) return false;
  const at = now();
  await store.update(sessionId, {
    metadata: { summary_skipped: { reason, at } },
  });
  console.info(`session summary skipped (${reason}) — ${sessionId}`);
  return true;
}
