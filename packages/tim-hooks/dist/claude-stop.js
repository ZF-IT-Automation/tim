"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_EXCHANGE_CHARS = exports.MAX_TRANSCRIPT_BYTES = void 0;
exports.readLastExchange = readLastExchange;
exports.runClaudeStop = runClaudeStop;
exports.stopExchangeCount = stopExchangeCount;
const node_crypto_1 = require("node:crypto");
const fs = __importStar(require("node:fs"));
const tim_store_1 = require("tim-store");
const cadence_runner_js_1 = require("./cadence-runner.js");
const marker_js_1 = require("./marker.js");
exports.MAX_TRANSCRIPT_BYTES = 1024 * 1024;
exports.MAX_EXCHANGE_CHARS = 64 * 1024;
function bounded(text, max = exports.MAX_EXCHANGE_CHARS) {
    const chars = Array.from(text);
    if (chars.length <= max)
        return text;
    return chars.slice(0, max).join('');
}
function extractText(content) {
    if (typeof content === 'string') {
        const trimmed = content.trim();
        return trimmed ? content : null;
    }
    if (!Array.isArray(content))
        return null;
    const parts = [];
    for (const block of content) {
        if (!block || typeof block !== 'object')
            continue;
        const record = block;
        if (record.type === 'text' && typeof record.text === 'string' && record.text.trim()) {
            parts.push(record.text);
        }
    }
    if (parts.length === 0)
        return null;
    return parts.join('\n');
}
function messageRole(record) {
    if (record.type === 'user' || record.type === 'assistant') {
        return record.type;
    }
    const message = record.message;
    if (message && typeof message === 'object' && !Array.isArray(message)) {
        const role = message.role;
        if (role === 'user' || role === 'assistant')
            return role;
    }
    return null;
}
function messageContent(record) {
    const message = record.message;
    if (message && typeof message === 'object' && !Array.isArray(message)) {
        return message.content;
    }
    return record.content;
}
function turnIdentity(userUuid, assistantUuid, user, assistant) {
    if (userUuid && assistantUuid)
        return `${userUuid}\0${assistantUuid}`;
    return (0, node_crypto_1.createHash)('sha256').update(`${user}\0${assistant}`).digest('hex');
}
/**
 * Read a Claude Code transcript JSONL and return the last genuine user/assistant turn.
 * Skips isMeta, tool-only assistants, malformed lines, and files over the byte bound.
 */
function readLastExchange(transcriptPath, maxBytes = exports.MAX_TRANSCRIPT_BYTES) {
    let stat;
    try {
        stat = fs.statSync(transcriptPath);
    }
    catch {
        return null;
    }
    if (!stat.isFile() || stat.size <= 0 || stat.size > maxBytes)
        return null;
    let raw;
    try {
        raw = fs.readFileSync(transcriptPath, 'utf8');
    }
    catch {
        return null;
    }
    if (Buffer.byteLength(raw, 'utf8') > maxBytes)
        return null;
    let lastUser = null;
    let lastTurn = null;
    for (const line of raw.split(/\r?\n/)) {
        if (!line.trim())
            continue;
        let record;
        try {
            const value = JSON.parse(line);
            if (!value || typeof value !== 'object' || Array.isArray(value))
                continue;
            record = value;
        }
        catch {
            continue;
        }
        if (record.isMeta === true)
            continue;
        const role = messageRole(record);
        if (!role)
            continue;
        const text = extractText(messageContent(record));
        if (!text)
            continue;
        const uuid = typeof record.uuid === 'string' ? record.uuid : null;
        if (role === 'user') {
            lastUser = { text, uuid };
            continue;
        }
        if (role === 'assistant' && lastUser) {
            lastTurn = {
                user: lastUser.text,
                assistant: text,
                identity: turnIdentity(lastUser.uuid, uuid, lastUser.text, text),
            };
            lastUser = null;
        }
    }
    return lastTurn;
}
async function ensureSessionForStop(store, sessions, sessionId, cwd) {
    const existing = await store.read(sessionId);
    if (existing?.metadata.kind === 'session')
        return true;
    const marker = (0, marker_js_1.findMarker)(cwd)?.marker;
    if (!marker?.project)
        return false;
    try {
        await sessions.startProjectSession({
            sessionId,
            projectId: marker.project,
            agentName: 'claude',
            cwd,
            harness: 'claude-code',
        });
        return true;
    }
    catch {
        return false;
    }
}
async function runClaudeStop(store, payload, options) {
    const sessionId = typeof payload.session_id === 'string' ? payload.session_id.trim() : '';
    const transcriptPath = typeof payload.transcript_path === 'string' ? payload.transcript_path.trim() : '';
    if (!sessionId || !transcriptPath)
        return { logged: false };
    const turn = readLastExchange(transcriptPath, exports.MAX_TRANSCRIPT_BYTES);
    if (!turn)
        return { logged: false };
    const key = (0, node_crypto_1.createHash)('sha256')
        .update(`${sessionId}\0${turn.identity}`)
        .digest('hex');
    const sessions = new tim_store_1.SessionManager(store);
    const ready = await ensureSessionForStop(store, sessions, sessionId, options.cwd);
    if (!ready)
        return { logged: false };
    let logged;
    try {
        logged = await sessions.logExchangeOnce(sessionId, key, [
            { role: 'user', content: bounded(turn.user) },
            { role: 'agent', content: bounded(turn.assistant) },
        ]);
    }
    catch {
        return { logged: false };
    }
    if (logged.length === 0)
        return { logged: false, duplicate: true };
    return { logged: true, ...(await (0, cadence_runner_js_1.afterExchangeLogged)(store, sessionId, options.cwd)) };
}
/** Test helper: expose counters after stop logging. */
async function stopExchangeCount(store, sessionId) {
    return (await (0, tim_store_1.deriveCounters)(store, sessionId)).exchangeCount;
}
//# sourceMappingURL=claude-stop.js.map