"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.afterExchangeLogged = afterExchangeLogged;
const tim_store_1 = require("tim-store");
const tim_core_1 = require("tim-core");
const cadence_js_1 = require("./cadence.js");
/**
 * After logging exchanges: derive counters from the store, optionally auto-checkpoint.
 */
async function afterExchangeLogged(store, sessionId, _cwd) {
    const { exchangeCount } = await (0, tim_store_1.deriveCounters)(store, sessionId);
    const everyN = (0, cadence_js_1.getCheckpointEveryN)((0, tim_core_1.loadConfig)());
    const result = { exchangeCount };
    if ((0, cadence_js_1.shouldAutoCheckpoint)(exchangeCount, everyN)) {
        const sessions = new tim_store_1.SessionManager(store);
        const entry = await sessions.checkpoint(sessionId);
        result.autoCheckpoint = true;
        result.checkpointEntryId = entry.id;
    }
    return result;
}
//# sourceMappingURL=cadence-runner.js.map