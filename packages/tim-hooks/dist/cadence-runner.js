"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.afterExchangeLogged = afterExchangeLogged;
const tim_store_1 = require("tim-store");
const tim_core_1 = require("tim-core");
const marker_js_1 = require("./marker.js");
const cadence_js_1 = require("./cadence.js");
/**
 * After logging exchanges: bump marker counter, optionally auto-checkpoint.
 */
async function afterExchangeLogged(store, sessionId, cwd) {
    const marker = (0, marker_js_1.readMarker)(cwd);
    if (!marker) {
        const { exchangeCount } = await (0, tim_store_1.deriveCounters)(store, sessionId);
        return { exchangeCount };
    }
    const reconciled = await (0, marker_js_1.reconcileMarker)(store, cwd);
    const everyN = (0, cadence_js_1.getCheckpointEveryN)((0, tim_core_1.loadConfig)());
    const result = { exchangeCount: reconciled.exchanges };
    if ((0, cadence_js_1.shouldAutoCheckpoint)(reconciled.exchanges, everyN)) {
        const sessions = new tim_store_1.SessionManager(store);
        const entry = await sessions.checkpoint(sessionId);
        result.autoCheckpoint = true;
        result.checkpointEntryId = entry.id;
        const after = await (0, marker_js_1.reconcileMarker)(store, cwd);
        (0, marker_js_1.writeMarker)(cwd, after);
    }
    return result;
}
//# sourceMappingURL=cadence-runner.js.map