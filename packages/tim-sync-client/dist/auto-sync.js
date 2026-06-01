"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.autoPush = autoPush;
exports.autoPull = autoPull;
exports.resetSyncCooldowns = resetSyncCooldowns;
const config_js_1 = require("./config.js");
const sync_js_1 = require("./sync.js");
const syncCooldowns = new Map();
const COOLDOWN_MS = 30_000;
let pushInFlight = false;
let pullInFlight = false;
function shouldSync(key, cooldownMs) {
    const last = syncCooldowns.get(key) ?? 0;
    return Date.now() - last > cooldownMs;
}
function markSynced(key) {
    syncCooldowns.set(key, Date.now());
}
async function autoPush(store) {
    const passphrase = process.env.TIM_SYNC_PASSPHRASE;
    if (!passphrase || !shouldSync('push', COOLDOWN_MS) || pushInFlight)
        return;
    const config = (0, config_js_1.loadConfig)();
    if (!config)
        return;
    markSynced('push');
    pushInFlight = true;
    try {
        const ctx = (0, sync_js_1.buildSyncContext)(store, config, passphrase, (0, config_js_1.getDeviceId)());
        await (0, sync_js_1.runPush)(ctx);
    }
    catch (err) {
        console.error('[tim-sync] autoPush failed:', err.message);
    }
    finally {
        pushInFlight = false;
    }
}
async function autoPull(store) {
    const passphrase = process.env.TIM_SYNC_PASSPHRASE;
    if (!passphrase || !shouldSync('pull', COOLDOWN_MS) || pullInFlight)
        return;
    const config = (0, config_js_1.loadConfig)();
    if (!config)
        return;
    markSynced('pull');
    pullInFlight = true;
    try {
        const ctx = (0, sync_js_1.buildSyncContext)(store, config, passphrase, (0, config_js_1.getDeviceId)());
        await (0, sync_js_1.runPull)(ctx);
    }
    catch (err) {
        console.error('[tim-sync] autoPull failed:', err.message);
    }
    finally {
        pullInFlight = false;
    }
}
/** @internal reset cooldowns for tests */
function resetSyncCooldowns() {
    syncCooldowns.clear();
    pushInFlight = false;
    pullInFlight = false;
}
//# sourceMappingURL=auto-sync.js.map