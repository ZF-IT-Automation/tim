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
exports.resolveOnPath = resolveOnPath;
exports.auditSummarizerHealth = auditSummarizerHealth;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const tim_core_1 = require("tim-core");
const tim_store_1 = require("tim-store");
const tim_summarizer_1 = require("tim-summarizer");
const SCAN_LIMIT = 500;
/** Which binary a chain entry actually spawns (see tryCli in tim-summarizer). */
function commandForCli(cli) {
    return cli === 'curl-openrouter' ? 'curl' : cli;
}
/** PATH lookup without spawning anything — doctor stays read-only. */
function resolveOnPath(command) {
    if (command.includes(path.sep)) {
        return fs.existsSync(command);
    }
    const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
    for (const dir of dirs) {
        const candidate = path.join(dir, command);
        try {
            fs.accessSync(candidate, fs.constants.X_OK);
            return true;
        }
        catch {
            // not here — keep looking
        }
    }
    return false;
}
/** Read-only summarizer health check for `tim doctor` (no writes, no spawns). */
async function auditSummarizerHealth(store, config) {
    const issues = [];
    const chain = config.summarizer?.chain ?? [];
    const first = chain[0];
    const firstEntry = first ? `${first.cli}/${first.model}` : null;
    if (chain.length === 0) {
        issues.push(`no summarizer chain configured — every summary falls back to a raw transcript. ` +
            `Add a "summarizer" block to ${(0, tim_core_1.getConfigPath)()}.`);
    }
    else if (!resolveOnPath(commandForCli(first.cli))) {
        issues.push(`first chain CLI '${commandForCli(first.cli)}' not found on PATH — ` +
            `the chain starts by failing over.`);
    }
    // Previously-corrupted summaries: the marker survives in the tree until resummarized.
    const corrupted = new Set();
    for (const kind of [tim_store_1.KIND_BATCH, tim_store_1.KIND_SUMMARY_ROOT]) {
        const nodes = await store.getByMetadataKind(kind, SCAN_LIMIT);
        for (const node of nodes) {
            if (!(node.content || '').includes(tim_summarizer_1.SUMMARY_FAILURE_MARKER))
                continue;
            const sessionId = typeof node.metadata.sessionId === 'string' ? node.metadata.sessionId : node.parentId;
            if (sessionId)
                corrupted.add(sessionId);
        }
    }
    const corruptedSessions = [...corrupted].sort();
    if (corruptedSessions.length > 0) {
        issues.push(`${corruptedSessions.length} session(s) hold a failed-summary marker: ` +
            `${corruptedSessions.slice(0, 5).join(', ')}${corruptedSessions.length > 5 ? ', …' : ''}`);
    }
    return {
        healthy: issues.length === 0,
        firstEntry,
        chainLength: chain.length,
        corruptedSessions,
        issues,
    };
}
//# sourceMappingURL=summarizer-health.js.map