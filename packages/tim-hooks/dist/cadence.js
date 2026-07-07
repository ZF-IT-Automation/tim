"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_BRIEFING_MAX_TOKENS = exports.DEFAULT_CHECKPOINT_EVERY_N = void 0;
exports.getCheckpointEveryN = getCheckpointEveryN;
exports.getBriefingMaxTokens = getBriefingMaxTokens;
exports.shouldAutoCheckpoint = shouldAutoCheckpoint;
exports.checkpointCadenceReminder = checkpointCadenceReminder;
exports.DEFAULT_CHECKPOINT_EVERY_N = 20;
exports.DEFAULT_BRIEFING_MAX_TOKENS = 9000;
function getCheckpointEveryN(config) {
    const n = config.checkpoint?.everyN;
    if (typeof n === 'number' && n > 0)
        return n;
    return exports.DEFAULT_CHECKPOINT_EVERY_N;
}
function getBriefingMaxTokens(config) {
    const n = config.briefing?.maxTokens;
    if (typeof n === 'number' && n > 0)
        return n;
    return exports.DEFAULT_BRIEFING_MAX_TOKENS;
}
/** True when an auto-checkpoint should fire after this exchange count. */
function shouldAutoCheckpoint(exchangeCount, everyN) {
    return exchangeCount > 0 && exchangeCount % everyN === 0;
}
/** Reminder line when approaching checkpoint cadence (last 3 before N). */
function checkpointCadenceReminder(exchangeCount, everyN) {
    if (everyN <= 0)
        return null;
    const remaining = everyN - (exchangeCount % everyN);
    if (remaining > 0 && remaining <= 3 && exchangeCount > 0) {
        return `TIM: checkpoint in ${remaining} exchange(s) (every ${everyN})`;
    }
    return null;
}
//# sourceMappingURL=cadence.js.map