import type { TimConfigFile } from 'tim-core';
export declare const DEFAULT_CHECKPOINT_EVERY_N = 20;
export declare const DEFAULT_BRIEFING_MAX_TOKENS = 9000;
export declare function getCheckpointEveryN(config: TimConfigFile): number;
export declare function getBriefingMaxTokens(config: TimConfigFile): number;
/** True when an auto-checkpoint should fire after this exchange count. */
export declare function shouldAutoCheckpoint(exchangeCount: number, everyN: number): boolean;
/** Reminder line when approaching checkpoint cadence (last 3 before N). */
export declare function checkpointCadenceReminder(exchangeCount: number, everyN: number): string | null;
//# sourceMappingURL=cadence.d.ts.map