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
exports.resolveStatuslineCounters = resolveStatuslineCounters;
exports.resolveStatuslineCwd = resolveStatuslineCwd;
exports.exchangesInCurrentBatch = exchangesInCurrentBatch;
exports.summaryIn = summaryIn;
exports.formatTimStatusLine = formatTimStatusLine;
exports.formatNoProjectStatusLine = formatNoProjectStatusLine;
exports.formatHermesStatus = formatHermesStatus;
exports.statuslineFromCwd = statuslineFromCwd;
exports.hermesStatusFromCwd = hermesStatusFromCwd;
exports.readStatuslineInputSync = readStatuslineInputSync;
exports.runStatusline = runStatusline;
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const tim_core_1 = require("tim-core");
const tim_store_1 = require("tim-store");
const tim_hooks_1 = require("tim-hooks");
const COUNTERS_TTL_MS = 5_000;
const countersCache = new Map();
function dbPath() {
    const config = (0, tim_core_1.loadConfig)();
    return process.env.TIM_DB_PATH || config.dbPath || path.join(os.homedir(), '.tim', 'tim.db');
}
/** DB-authoritative exchange counters (5s in-process cache keyed by session id). */
async function resolveStatuslineCounters(store, project, cwd, sessionIdArg) {
    const noSession = {
        project,
        exchanges: 0,
        batchSize: tim_store_1.DEFAULT_BATCH_SIZE,
        batchesSummarized: 0,
    };
    let sessionId = sessionIdArg?.trim();
    if (!sessionId) {
        const sessionEntry = await (0, tim_store_1.resolveCurrentSession)(store, project, cwd);
        if (!sessionEntry)
            return noSession;
        sessionId = sessionEntry.id;
    }
    const sessionEntry = await store.read(sessionId);
    if (!sessionEntry || sessionEntry.metadata.kind !== 'session')
        return noSession;
    const batchSize = typeof sessionEntry.metadata.batch_size === 'number'
        ? sessionEntry.metadata.batch_size
        : tim_store_1.DEFAULT_BATCH_SIZE;
    const now = Date.now();
    const hit = countersCache.get(sessionId);
    if (hit && now - hit.at < COUNTERS_TTL_MS) {
        return {
            project,
            exchanges: hit.exchanges,
            batchSize: hit.batchSize,
            batchesSummarized: hit.batchesSummarized,
        };
    }
    const { exchangeCount, batchesSummarized } = await (0, tim_store_1.deriveCounters)(store, sessionId);
    countersCache.set(sessionId, {
        at: now,
        exchanges: exchangeCount,
        batchesSummarized,
        batchSize,
    });
    return {
        project,
        exchanges: exchangeCount,
        batchSize,
        batchesSummarized,
    };
}
function resolveStatuslineCwd(input, fallback = process.cwd()) {
    const fromWorkspace = input.workspace?.current_dir?.trim();
    if (fromWorkspace)
        return fromWorkspace;
    const fromCwd = input.cwd?.trim();
    if (fromCwd)
        return fromCwd;
    return fallback;
}
/** User exchanges in current batch (1..batch_size at boundary). */
function exchangesInCurrentBatch(exchanges, batchSize) {
    const bs = Math.max(1, batchSize);
    const mod = ((exchanges % bs) + bs) % bs;
    return mod === 0 && exchanges > 0 ? bs : mod;
}
/** Exchanges until next batch summary trigger. */
function summaryIn(exchanges, batchSize) {
    const bs = Math.max(1, batchSize);
    const mod = ((exchanges % bs) + bs) % bs;
    if (mod === 0)
        return exchanges === 0 ? bs : 0;
    return bs - mod;
}
function formatTimStatusLine(counters, projectName) {
    const batchSize = counters.batchSize > 0 ? counters.batchSize : tim_store_1.DEFAULT_BATCH_SIZE;
    const exchanges = Math.max(0, counters.exchanges);
    const inBatch = exchangesInCurrentBatch(exchanges, batchSize);
    const k = summaryIn(exchanges, batchSize);
    const name = projectName?.trim() || counters.project;
    return `${name} · ${inBatch}/${batchSize} exchanges · summary in ${k}`;
}
function formatNoProjectStatusLine() {
    return 'no project';
}
function formatHermesStatus(counters, projectName) {
    if (!counters) {
        return { device: '', project: 'no project', o_node: '', counter: '' };
    }
    const batchSize = counters.batchSize > 0 ? counters.batchSize : tim_store_1.DEFAULT_BATCH_SIZE;
    const inBatch = exchangesInCurrentBatch(counters.exchanges, batchSize);
    const k = summaryIn(counters.exchanges, batchSize);
    return {
        device: '',
        project: projectName?.trim() || counters.project,
        o_node: '',
        counter: `${inBatch}/${batchSize} · Σ${k}`,
    };
}
async function projectNameForStatusline(store, counters) {
    if ((0, tim_hooks_1.isUnboundProjectLabel)(counters.project)) {
        return (0, tim_hooks_1.formatUnboundProjectLabel)((0, tim_hooks_1.stripUnboundProjectSuffix)(counters.project));
    }
    return (0, tim_store_1.resolveProjectDisplayName)(store, counters.project);
}
async function resolveStatuslineData(cwd, sessionIdArg, options, store) {
    const located = (0, tim_hooks_1.findMarker)(cwd, { walkUp: true, ...options });
    if (!located)
        return null;
    const validated = await (0, tim_hooks_1.validateMarkerAgainstStore)(located.marker, store);
    const project = validated?.project ?? (0, tim_hooks_1.formatUnboundProjectLabel)(located.marker.project);
    if (!validated) {
        return {
            project,
            exchanges: 0,
            batchSize: tim_store_1.DEFAULT_BATCH_SIZE,
            batchesSummarized: 0,
        };
    }
    const counters = await resolveStatuslineCounters(store, validated.project, located.dir, sessionIdArg);
    return { ...counters, project };
}
async function statuslineFromCwd(cwd, options, sessionIdArg) {
    const store = new tim_store_1.TimStore(dbPath());
    try {
        const counters = await resolveStatuslineData(cwd, sessionIdArg, options, store);
        if (!counters)
            return formatNoProjectStatusLine();
        const name = await projectNameForStatusline(store, counters);
        return formatTimStatusLine(counters, name);
    }
    finally {
        store.close();
    }
}
async function hermesStatusFromCwd(cwd, options, sessionIdArg) {
    const store = new tim_store_1.TimStore(dbPath());
    try {
        const counters = await resolveStatuslineData(cwd, sessionIdArg, options, store);
        if (!counters)
            return formatHermesStatus(null);
        const name = await projectNameForStatusline(store, counters);
        return formatHermesStatus(counters, name);
    }
    finally {
        store.close();
    }
}
/** Sync stdin read — reliable when Claude pipes JSON (async iterator can miss short pipes). */
function readStatuslineInputSync() {
    try {
        if (process.stdin.isTTY)
            return {};
        const raw = fs.readFileSync(0, 'utf8').trim();
        if (!raw)
            return {};
        return JSON.parse(raw);
    }
    catch {
        return {};
    }
}
async function runStatusline(opts = {}) {
    const input = readStatuslineInputSync();
    const cwd = opts.cwd?.trim() || resolveStatuslineCwd(input);
    const findOpts = { walkUp: true, ...(0, tim_hooks_1.findMarkerOptionsFromEnv)() };
    const store = new tim_store_1.TimStore(dbPath());
    try {
        const counters = await resolveStatuslineData(cwd, opts.sessionId?.trim(), findOpts, store);
        const projectName = counters ? await projectNameForStatusline(store, counters) : undefined;
        const format = opts.format ?? 'text';
        if (format === 'hermes') {
            process.stdout.write(`${JSON.stringify(formatHermesStatus(counters, projectName))}\n`);
            return;
        }
        const line = counters
            ? formatTimStatusLine(counters, projectName)
            : formatNoProjectStatusLine();
        process.stdout.write(`${line}\n`);
    }
    finally {
        store.close();
    }
}
//# sourceMappingURL=statusline.js.map