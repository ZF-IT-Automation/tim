import type { TimConfigFile } from 'tim-core';

export const DEFAULT_CHECKPOINT_EVERY_N = 20;
export const DEFAULT_BRIEFING_MAX_TOKENS = 9000;

export function getCheckpointEveryN(config: TimConfigFile): number {
  const n = config.checkpoint?.everyN;
  if (typeof n === 'number' && n > 0) return n;
  return DEFAULT_CHECKPOINT_EVERY_N;
}

export function getBriefingMaxTokens(config: TimConfigFile): number {
  const n = config.briefing?.maxTokens;
  if (typeof n === 'number' && n > 0) return n;
  return DEFAULT_BRIEFING_MAX_TOKENS;
}

/** True when an auto-checkpoint should fire after this exchange count. */
export function shouldAutoCheckpoint(exchangeCount: number, everyN: number): boolean {
  return exchangeCount > 0 && exchangeCount % everyN === 0;
}

/** Reminder line when approaching checkpoint cadence (last 3 before N). */
export function checkpointCadenceReminder(
  exchangeCount: number,
  everyN: number,
): string | null {
  if (everyN <= 0) return null;
  const remaining = everyN - (exchangeCount % everyN);
  if (remaining > 0 && remaining <= 3 && exchangeCount > 0) {
    return `TIM: checkpoint in ${remaining} exchange(s) (every ${everyN})`;
  }
  return null;
}
