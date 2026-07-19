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
exports.DEFAULT_PROJECT_SUMMARY_THRESHOLD = exports.detachedSpawner = exports.spawnSummarizer = exports.DEFAULT_SUMMARIZER_TIMEOUT_SEC = void 0;
exports.summarizerLogPath = summarizerLogPath;
exports.buildSummarizerCommand = buildSummarizerCommand;
exports.maybeSpawnSummarizer = maybeSpawnSummarizer;
exports.onSessionStop = onSessionStop;
exports.buildProjectSummaryCommand = buildProjectSummaryCommand;
exports.maybeSpawnProjectSummary = maybeSpawnProjectSummary;
const child_process_1 = require("child_process");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const tim_store_1 = require("tim-store");
const marker_js_1 = require("./marker.js");
const constants_js_1 = require("./constants.js");
var constants_js_2 = require("./constants.js");
Object.defineProperty(exports, "DEFAULT_SUMMARIZER_TIMEOUT_SEC", { enumerable: true, get: function () { return constants_js_2.DEFAULT_SUMMARIZER_TIMEOUT_SEC; } });
function summarizerLogPath(cwd) {
    return path.join(cwd, '.tim', 'summarizer.log');
}
/** Shell snippet: trap lock release, timeout, run tim-summarizer CLI with log append. */
function buildSummarizerCommand(sessionId, lockPath, logPath, timeoutSec = constants_js_1.DEFAULT_SUMMARIZER_TIMEOUT_SEC) {
    const q = (s) => JSON.stringify(s);
    const cmd = 'node ' + JSON.stringify(path.resolve(__dirname, '..', '..', 'tim-summarizer', 'dist', 'summarize.js'));
    return (`{ trap ${q(`rm -f ${lockPath}`)} EXIT; ` +
        `timeout ${timeoutSec} env TIM_SESSION_ID=${q(sessionId)} ${cmd} >>${q(logPath)} 2>&1; }`);
}
/** Detached spawn with log dir creation and spawn-error capture (does not throw). */
const spawnSummarizer = (command, ctx) => {
    const timDir = path.join(ctx.cwd, '.tim');
    try {
        fs.mkdirSync(timDir, { recursive: true });
    }
    catch {
        /* ignore */
    }
    const logPath = summarizerLogPath(ctx.cwd);
    try {
        const child = (0, child_process_1.spawn)(command, {
            shell: true,
            cwd: ctx.cwd,
            detached: true,
            stdio: 'ignore',
            env: { ...process.env, TIM_SESSION_ID: ctx.sessionId },
        });
        child.on('error', err => {
            try {
                fs.appendFileSync(logPath, `[${new Date().toISOString()}] spawn error: ${err.message}\n`);
            }
            catch {
                /* ignore */
            }
            (0, marker_js_1.releaseLock)(ctx.cwd);
        });
        child.unref();
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        try {
            fs.appendFileSync(logPath, `[${new Date().toISOString()}] spawn failed: ${msg}\n`);
        }
        catch {
            /* ignore */
        }
        (0, marker_js_1.releaseLock)(ctx.cwd);
    }
};
exports.spawnSummarizer = spawnSummarizer;
/** @deprecated Use spawnSummarizer */
exports.detachedSpawner = exports.spawnSummarizer;
/** Shared spawn gate for session-stop hook and live batch-full trigger. */
async function maybeSpawnSummarizer(store, cwd, opts = {}) {
    const spawn = opts.spawn ?? exports.spawnSummarizer;
    const marker = (0, marker_js_1.detectProject)(cwd);
    if (!marker)
        return { spawned: false, reason: 'no-marker' };
    const sessionEntry = opts.sessionId
        ? await store.read(opts.sessionId)
        : await (0, tim_store_1.resolveCurrentSession)(store, marker.project, cwd);
    if (!sessionEntry)
        return { spawned: false, reason: 'no-session' };
    const sessionId = sessionEntry.id;
    const batchSize = typeof sessionEntry.metadata.batch_size === 'number'
        ? sessionEntry.metadata.batch_size
        : 5;
    const { exchangeCount, batchesSummarized } = await (0, tim_store_1.deriveCounters)(store, sessionId);
    const pending = exchangeCount - batchesSummarized * batchSize;
    if (!opts.batchFull && pending < batchSize) {
        return { spawned: false, reason: 'below-threshold', pending };
    }
    if (!(0, marker_js_1.acquireLock)(cwd))
        return { spawned: false, reason: 'locked', pending };
    const lockPath = (0, marker_js_1.summarizerLockPath)(cwd);
    const logPath = summarizerLogPath(cwd);
    const timeoutSec = opts.timeoutSec ?? constants_js_1.DEFAULT_SUMMARIZER_TIMEOUT_SEC;
    try {
        spawn(buildSummarizerCommand(sessionId, lockPath, logPath, timeoutSec), {
            sessionId,
            cwd,
        });
        return { spawned: true, reason: 'spawned', pending };
    }
    catch {
        (0, marker_js_1.releaseLock)(cwd);
        return { spawned: false, reason: 'spawn-failed', pending };
    }
}
async function onSessionStop(store, cwd, opts = {}) {
    return maybeSpawnSummarizer(store, cwd, opts);
}
exports.DEFAULT_PROJECT_SUMMARY_THRESHOLD = 5;
/** Shell snippet: run tim-summarizer in --project-summary mode for a label. */
function buildProjectSummaryCommand(label, logPath, timeoutSec = constants_js_1.DEFAULT_SUMMARIZER_TIMEOUT_SEC) {
    const q = (s) => JSON.stringify(s);
    const cmd = 'node ' + JSON.stringify(path.resolve(__dirname, '..', '..', 'tim-summarizer', 'dist', 'summarize.js'));
    return `timeout ${timeoutSec} ${cmd} --project-summary ${q(label)} >>${q(logPath)} 2>&1`;
}
/**
 * Gate + detached spawn for periodic project-summary generation.
 * Fires only when sessions-so-far is a positive multiple of the threshold.
 * Fire-and-forget — never throws.
 */
async function maybeSpawnProjectSummary(store, cwd, label, opts = {}) {
    if (!label)
        return { spawned: false, reason: 'no-label' };
    const count = await store.countSessionSummaries(label);
    if (count <= 0)
        return { spawned: false, reason: 'no-sessions', count };
    const threshold = opts.threshold ?? exports.DEFAULT_PROJECT_SUMMARY_THRESHOLD;
    if (threshold <= 0 || count % threshold !== 0) {
        return { spawned: false, reason: 'below-threshold', count };
    }
    const spawn = opts.spawn ?? exports.spawnSummarizer;
    const logPath = summarizerLogPath(cwd);
    const timeoutSec = opts.timeoutSec ?? constants_js_1.DEFAULT_SUMMARIZER_TIMEOUT_SEC;
    try {
        spawn(buildProjectSummaryCommand(label, logPath, timeoutSec), { sessionId: label, cwd });
        return { spawned: true, reason: 'spawned', count };
    }
    catch {
        return { spawned: false, reason: 'spawn-failed', count };
    }
}
//# sourceMappingURL=session-hooks.js.map