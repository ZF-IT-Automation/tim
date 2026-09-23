/** Minimum user/agent turns for a session to count as substantive without a handoff. */
export const SUBSTANTIVE_MIN_EXCHANGES = 3;

/** Summarizer verdict on whether a session batch carried project work. */
export type SessionSubstance = 'none' | 'low' | 'real';

const SUBSTANCE_RANK: Record<SessionSubstance, number> = {
  none: 0,
  low: 1,
  real: 2,
};

/** Parse stored metadata; missing or garbled → undefined (backward compatible). */
export function parseSessionSubstance(raw: unknown): SessionSubstance | undefined {
  if (raw === 'none' || raw === 'low' || raw === 'real') return raw;
  return undefined;
}

/** Max over batches: real > low > none. */
export function aggregateSubstance(
  values: Array<SessionSubstance | undefined>,
): SessionSubstance | undefined {
  let best: SessionSubstance | undefined;
  for (const value of values) {
    if (!value) continue;
    if (!best || SUBSTANCE_RANK[value] > SUBSTANCE_RANK[best]) best = value;
  }
  return best;
}

/**
 * Substantive = handoff note, or summarizer says real, or enough exchanges —
 * unless summarizer explicitly marked none.
 */
export function isSubstantiveSession(
  exchangeCount: number,
  hasHandoffNote: boolean,
  substance?: SessionSubstance,
): boolean {
  if (hasHandoffNote) return true;
  if (substance === 'none') return false;
  if (substance === 'real') return true;
  return exchangeCount >= SUBSTANTIVE_MIN_EXCHANGES;
}

export function sessionHasHandoffNote(metadata: Record<string, unknown> | undefined): boolean {
  const note = metadata?.handoff_note;
  return typeof note === 'string' && note.trim().length > 0;
}
