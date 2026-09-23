/** Minimum user/agent turns for a session to count as substantive without a handoff. */
export const SUBSTANTIVE_MIN_EXCHANGES = 3;

/** Substantive = enough exchanges or an explicit handoff note on the summary root. */
export function isSubstantiveSession(exchangeCount: number, hasHandoffNote: boolean): boolean {
  return exchangeCount >= SUBSTANTIVE_MIN_EXCHANGES || hasHandoffNote;
}

export function sessionHasHandoffNote(metadata: Record<string, unknown> | undefined): boolean {
  const note = metadata?.handoff_note;
  return typeof note === 'string' && note.trim().length > 0;
}
