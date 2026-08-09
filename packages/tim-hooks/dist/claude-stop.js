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
const hook_session_js_1 = require("./hook-session.js");
/** Tail window, not a file-size limit: only the last turn is needed. */
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
    // Cursor writes the role at the top level and the content one level down;
    // Claude's records never carry a top-level role, so this stays additive.
    if (record.role === 'user' || record.role === 'assistant')
        return record.role;
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
 * Skips isMeta, tool-only assistants and malformed lines. Long transcripts are read
 * from the tail — bailing on size logged nothing at all once a session got going.
 */
function readLastExchange(transcriptPath, maxBytes = exports.MAX_TRANSCRIPT_BYTES) {
    let stat;
    try {
        stat = fs.statSync(transcriptPath);
    }
    catch {
        return null;
    }
    if (!stat.isFile() || stat.size <= 0)
        return null;
    const start = Math.max(0, stat.size - maxBytes);
    let raw;
    try {
        const fd = fs.openSync(transcriptPath, 'r');
        try {
            const buf = Buffer.alloc(stat.size - start);
            fs.readSync(fd, buf, 0, buf.length, start);
            raw = buf.toString('utf8');
        }
        finally {
            fs.closeSync(fd);
        }
    }
    catch {
        return null;
    }
    // The window cuts mid-line; that first fragment is not a whole JSON record.
    if (start > 0)
        raw = raw.slice(raw.indexOf('\n') + 1);
    let pendingUser = null;
    // One turn emits many assistant records (text, thinking, tool_use); the text ones
    // all belong to the same answer and are collected until the next user message.
    let pendingAssistant = null;
    let lastTurn = null;
    // The uuid pair stays the first of each side, so a re-fired hook derives the same key.
    const commitTurn = () => {
        if (pendingUser && pendingAssistant) {
            const assistant = pendingAssistant.parts.join('\n\n');
            lastTurn = {
                user: pendingUser.text,
                assistant,
                identity: turnIdentity(pendingUser.uuid, pendingAssistant.uuid, pendingUser.text, assistant),
            };
        }
        pendingUser = null;
        pendingAssistant = null;
    };
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
            commitTurn();
            pendingUser = { text, uuid };
            continue;
        }
        if (role === 'assistant' && pendingUser) {
            if (!pendingAssistant)
                pendingAssistant = { parts: [], uuid };
            pendingAssistant.parts.push(text);
        }
    }
    commitTurn();
    return lastTurn;
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
    const ready = await (0, hook_session_js_1.ensureHookSession)(store, sessions, sessionId, options.cwd, options.agent ?? {
        agentName: 'claude',
        harness: 'claude-code',
    });
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