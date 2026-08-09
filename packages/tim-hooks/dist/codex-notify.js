"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseCodexNotifyArgs = parseCodexNotifyArgs;
exports.runCodexNotify = runCodexNotify;
const node_crypto_1 = require("node:crypto");
const tim_store_1 = require("tim-store");
const cadence_runner_js_1 = require("./cadence-runner.js");
const claude_stop_js_1 = require("./claude-stop.js");
const hook_session_js_1 = require("./hook-session.js");
function bounded(text, max = claude_stop_js_1.MAX_EXCHANGE_CHARS) {
    const chars = Array.from(text);
    if (chars.length <= max)
        return text;
    return chars.slice(0, max).join('');
}
/**
 * Parse the notify payload out of the argv Codex spawns the program with: it
 * appends the JSON as the final argument, so the command array itself may be
 * spelled any way the installer likes.
 */
function parseCodexNotifyArgs(args) {
    const last = args[args.length - 1];
    if (typeof last !== 'string' || !last.trim())
        return null;
    try {
        const value = JSON.parse(last);
        if (!value || typeof value !== 'object' || Array.isArray(value))
            return null;
        return value;
    }
    catch {
        return null;
    }
}
/**
 * `input-messages` holds only what the human sent: Codex injects
 * `<recommended_plugins>` and friends as separate transcript items that never
 * reach this field, so joining every element is safe.
 */
function userText(payload) {
    const messages = payload['input-messages'];
    if (!Array.isArray(messages))
        return '';
    return messages.filter((m) => typeof m === 'string').join('\n').trim();
}
async function runCodexNotify(store, payload, options) {
    // Anything but a completed turn is not an exchange, including a payload that
    // names no type at all — notify carries other event types.
    if (payload.type !== 'agent-turn-complete')
        return { logged: false };
    const sessionId = typeof payload['thread-id'] === 'string' ? payload['thread-id'].trim() : '';
    const turnId = typeof payload['turn-id'] === 'string' ? payload['turn-id'].trim() : '';
    const user = userText(payload);
    const assistantRaw = payload['last-assistant-message'];
    const assistant = typeof assistantRaw === 'string' ? assistantRaw.trim() : '';
    if (!sessionId || !turnId || !user || !assistant)
        return { logged: false };
    // turn-id is stable per turn, so a re-fired notify derives the same key.
    const key = (0, node_crypto_1.createHash)('sha256').update(`${sessionId}\0${turnId}`).digest('hex');
    const sessions = new tim_store_1.SessionManager(store);
    const ready = await (0, hook_session_js_1.ensureHookSession)(store, sessions, sessionId, options.cwd, {
        agentName: 'codex',
        harness: 'codex',
    });
    if (!ready)
        return { logged: false };
    let logged;
    try {
        logged = await sessions.logExchangeOnce(sessionId, key, [
            { role: 'user', content: bounded(user) },
            { role: 'agent', content: bounded(assistant) },
        ]);
    }
    catch {
        return { logged: false };
    }
    if (logged.length === 0)
        return { logged: false, duplicate: true };
    return { logged: true, ...(await (0, cadence_runner_js_1.afterExchangeLogged)(store, sessionId, options.cwd)) };
}
//# sourceMappingURL=codex-notify.js.map