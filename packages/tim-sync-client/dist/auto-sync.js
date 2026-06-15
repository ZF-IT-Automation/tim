"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports._peekCooldown = _peekCooldown;
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
/** @internal peek at cooldown timestamp for tests (0 = not armed) */
function _peekCooldown(key) {
    return syncCooldowns.get(key) ?? 0;
}
async function autoPush(store) {
    const passphrase = process.env.TIM_SYNC_PASSPHRASE;
    if (!passphrase)
        return { ran: false, reason: 'no-passphrase' };
    if (pushInFlight)
        return { ran: false, reason: 'in-flight' };
    if (!shouldSync('push', COOLDOWN_MS))
        return { ran: false, reason: 'cooldown' };
    const config = (0, config_js_1.loadConfig)();
    if (!config)
        return { ran: false, reason: 'no-config' };
    pushInFlight = true;
    try {
        const ctx = (0, sync_js_1.buildSyncContext)(store, config, passphrase, (0, config_js_1.getDeviceId)());
        const result = await (0, sync_js_1.runPush)(ctx);
        markSynced('push'); // ONLY arm cooldown on success
        return { ran: true, pushed: result.pushed, queued: result.queued };
    }
    catch (err) {
        console.error('[tim-sync] autoPush failed:', err.message);
        // do NOT markSynced — let next call retry immediately (gated by InFlight only)
        return { ran: true, reason: 'error' };
    }
    finally {
        pushInFlight = false;
    }
}
async function autoPull(store) {
    const passphrase = process.env.TIM_SYNC_PASSPHRASE;
    if (!passphrase)
        return { ran: false, reason: 'no-passphrase' };
    if (pullInFlight)
        return { ran: false, reason: 'in-flight' };
    if (!shouldSync('pull', COOLDOWN_MS))
        return { ran: false, reason: 'cooldown' };
    const config = (0, config_js_1.loadConfig)();
    if (!config)
        return { ran: false, reason: 'no-config' };
    pullInFlight = true;
    try {
        const ctx = (0, sync_js_1.buildSyncContext)(store, config, passphrase, (0, config_js_1.getDeviceId)());
        const result = await (0, sync_js_1.runPull)(ctx);
        markSynced('pull'); // ONLY arm cooldown on success
        return { ran: true, pulled: result.pulled, conflicts: result.conflicts };
    }
    catch (err) {
        console.error('[tim-sync] autoPull failed:', err.message);
        // do NOT markSynced — let next call retry immediately (gated by InFlight only)
        return { ran: true, reason: 'error' };
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