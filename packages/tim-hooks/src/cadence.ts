import type { TimConfigFile } from 'tim-core';

export const DEFAULT_CHECKPOINT_EVERY_N = 20;
/** Default MCP project brief byte budget (12 KB, G9). */
export const DEFAULT_BRIEFING_MAX_TOKENS = 12288;
/** Session-start hook directive content budget (~4 KB, G9). */
export const DEFAULT_DIRECTIVE_HOOK_MAX_TOKENS = 1024;
export const DEFAULT_BRIEFING_RECENT_SESSIONS = 5;

export function getCheckpointEveryN(config: TimConfigFile): number {
  const n = config.checkpoint?.everyN;
  if (typeof n === 'number' && n > 0) return n;
  return DEFAULT_CHECKPOINT_EVERY_N;
}

export function getBriefingMaxTokens(config: TimConfigFile): number {
  const n = config.briefing?.maxTokens;
  if (typeof n === 'number' && Number.isFinite(n) && Number.isInteger(n) && n > 0) {
    return Math.min(n, 64000);
  }
  return DEFAULT_BRIEFING_MAX_TOKENS;
}

export function getDirectiveHookMaxTokens(_config: TimConfigFile): number {
  return DEFAULT_DIRECTIVE_HOOK_MAX_TOKENS;
}

export function getBriefingRecentSessions(config: TimConfigFile): number {
  const n = config.briefing?.recentSessions;
  if (typeof n === 'number' && n > 0) return Math.floor(n);
  return DEFAULT_BRIEFING_RECENT_SESSIONS;
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
