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
exports.cmdConsolidate = cmdConsolidate;
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const tim_core_1 = require("tim-core");
const tim_store_1 = require("tim-store");
const tim_summarizer_1 = require("tim-summarizer");
const args_js_1 = require("./args.js");
function resolveDbPath() {
    if (process.env.TIM_DB_PATH)
        return process.env.TIM_DB_PATH;
    const config = (0, tim_core_1.loadConfig)();
    return config.dbPath || path.join(os.homedir(), '.tim', 'tim.db');
}
function printHelp() {
    console.log(`tim consolidate — memory consolidation pipeline

Usage:
  tim consolidate find-duplicates [--project P0063]
  tim consolidate find-decay [--project P0063]
  tim consolidate run [--project P0063]
  tim consolidate status [--project P0063]
`);
}
async function cmdConsolidate(args) {
    const sub = args[0];
    const rest = sub ? args.slice(1) : args;
    const { flags } = (0, args_js_1.parseArgs)(rest, { valueOptions: (0, args_js_1.valueOptionsFor)('consolidate', sub) });
    const project = flags.project;
    if (!sub || sub === 'help' || sub === '--help') {
        printHelp();
        return;
    }
    if (!project) {
        console.error(`tim consolidate ${sub}: --project <P00XX> required`);
        process.exit(1);
    }
    const store = new tim_store_1.TimStore(resolveDbPath());
    try {
        const mgr = store.consolidate();
        switch (sub) {
            case 'find-duplicates': {
                const hits = await mgr.findDuplicateCandidates(project, {
                    threshold: flags.threshold ? Number(flags.threshold) : undefined,
                });
                console.log(JSON.stringify({ project, count: hits.length, candidates: hits }, null, 2));
                break;
            }
            case 'find-decay': {
                const hits = await mgr.findDecayCandidates(project, {
                    accessDays: flags['access-days'] ? Number(flags['access-days']) : undefined,
                    accessCount: flags['access-count'] ? Number(flags['access-count']) : undefined,
                    verifiedDays: flags['verified-days'] ? Number(flags['verified-days']) : undefined,
                });
                console.log(JSON.stringify({ project, count: hits.length, candidates: hits }, null, 2));
                break;
            }
            case 'run': {
                const dupes = await mgr.findDuplicateCandidates(project);
                const decay = await mgr.findDecayCandidates(project);
                const processed = await (0, tim_summarizer_1.processCurationQueue)(store, project);
                console.log(JSON.stringify({
                    project,
                    queued: { duplicates: dupes.length, decay: decay.length },
                    processed,
                }, null, 2));
                break;
            }
            case 'status': {
                const stats = await mgr.getCurationStats(project);
                const pending = await mgr.getCurationQueue(project, 'pending');
                console.log(JSON.stringify({
                    project,
                    stats,
                    pending: pending.map(e => ({
                        id: e.id,
                        consolidation: e.metadata.consolidation,
                        pair: e.metadata.pair,
                        target: e.metadata.target,
                        reason: e.metadata.reason,
                    })),
                }, null, 2));
                break;
            }
            default:
                printHelp();
                process.exit(1);
        }
    }
    finally {
        store.close();
    }
}
//# sourceMappingURL=consolidate.js.map