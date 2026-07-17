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
exports.reconcileMarkerCounters = reconcileMarkerCounters;
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
const RECONCILE_TTL_MS = 5_000;
const reconcileCache = new Map();
function dbPath() {
    const config = (0, tim_core_1.loadConfig)();
    return process.env.TIM_DB_PATH || config.dbPath || path.join(os.homedir(), '.tim', 'tim.db');
}
/** DB-authoritative exchange counters (5s in-process cache). */
async function reconcileMarkerCounters(store, marker) {
    const sid = marker.session?.trim();
    if (!sid)
        return { version: 2, ...marker };
    const entry = await store.read(sid);
    if (!entry || entry.metadata.kind !== 'session')
        return { version: 2, ...marker };
    const now = Date.now();
    const hit = reconcileCache.get(sid);
    if (hit && now - hit.at < RECONCILE_TTL_MS) {
        return {
            version: 2,
            ...marker,
            exchanges: hit.exchanges,
            batches_summarized: hit.batches_summarized,
        };
    }
    const { exchangeCount, batchesSummarized } = await (0, tim_store_1.deriveCounters)(store, sid);
    reconcileCache.set(sid, {
        at: now,
        exchanges: exchangeCount,
        batches_summarized: batchesSummarized,
    });
    return {
        version: 2,
        ...marker,
        exchanges: exchangeCount,
        batches_summarized: batchesSummarized,
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
function formatTimStatusLine(marker, projectName) {
    const batchSize = marker.batch_size > 0 ? marker.batch_size : 5;
    const exchanges = Math.max(0, marker.exchanges);
    const inBatch = exchangesInCurrentBatch(exchanges, batchSize);
    const k = summaryIn(exchanges, batchSize);
    const name = projectName?.trim() || marker.project;
    return `${name} · ${inBatch}/${batchSize} exchanges · summary in ${k}`;
}
function formatNoProjectStatusLine() {
    return 'no project';
}
function formatHermesStatus(marker, projectName) {
    if (!marker) {
        return { device: '', project: 'no project', o_node: '', counter: '' };
    }
    const batchSize = marker.batch_size > 0 ? marker.batch_size : 5;
    const inBatch = exchangesInCurrentBatch(marker.exchanges, batchSize);
    const k = summaryIn(marker.exchanges, batchSize);
    return {
        device: '',
        project: projectName?.trim() || marker.project,
        o_node: '',
        counter: `${inBatch}/${batchSize} · Σ${k}`,
    };
}
async function projectNameForStatusline(store, marker) {
    if ((0, tim_hooks_1.isUnboundProjectLabel)(marker.project)) {
        return (0, tim_hooks_1.formatUnboundProjectLabel)((0, tim_hooks_1.stripUnboundProjectSuffix)(marker.project));
    }
    return (0, tim_store_1.resolveProjectDisplayName)(store, marker.project);
}
async function resolveStatuslineMarker(cwd, _sessionIdArg, options, store) {
    const located = (0, tim_hooks_1.findMarker)(cwd, { walkUp: true, ...options });
    if (!located)
        return null;
    const validated = await (0, tim_hooks_1.validateMarkerAgainstStore)(located.marker, store);
    const marker = validated ?? {
        ...located.marker,
        project: (0, tim_hooks_1.formatUnboundProjectLabel)(located.marker.project),
    };
    return reconcileMarkerCounters(store, marker);
}
async function statuslineFromCwd(cwd, options, sessionIdArg) {
    const store = new tim_store_1.TimStore(dbPath());
    try {
        const marker = await resolveStatuslineMarker(cwd, sessionIdArg, options, store);
        if (!marker)
            return formatNoProjectStatusLine();
        const name = await projectNameForStatusline(store, marker);
        return formatTimStatusLine(marker, name);
    }
    finally {
        store.close();
    }
}
async function hermesStatusFromCwd(cwd, options, sessionIdArg) {
    const store = new tim_store_1.TimStore(dbPath());
    try {
        const marker = await resolveStatuslineMarker(cwd, sessionIdArg, options, store);
        if (!marker)
            return formatHermesStatus(null);
        const name = await projectNameForStatusline(store, marker);
        return formatHermesStatus(marker, name);
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
        const marker = await resolveStatuslineMarker(cwd, opts.sessionId?.trim(), findOpts, store);
        const projectName = marker ? await projectNameForStatusline(store, marker) : undefined;
        const format = opts.format ?? 'text';
        if (format === 'hermes') {
            process.stdout.write(`${JSON.stringify(formatHermesStatus(marker, projectName))}\n`);
            return;
        }
        const line = marker
            ? formatTimStatusLine(marker, projectName)
            : formatNoProjectStatusLine();
        process.stdout.write(`${line}\n`);
    }
    finally {
        store.close();
    }
}
//# sourceMappingURL=statusline.js.map