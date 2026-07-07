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
exports.cmdRecordCommit = cmdRecordCommit;
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const tim_store_1 = require("tim-store");
const tim_core_1 = require("tim-core");
const tim_hooks_1 = require("tim-hooks");
const git_commit_js_1 = require("./git-commit.js");
function getDbPath(config) {
    return process.env.TIM_DB_PATH || config.dbPath || path.join(os.homedir(), '.tim', 'tim.db');
}
function parseArgs(args) {
    const parsed = {};
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg.startsWith('--')) {
            const key = arg.slice(2);
            const next = args[i + 1];
            if (next && !next.startsWith('--')) {
                parsed[key] = next;
                i++;
            }
            else {
                parsed[key] = 'true';
            }
        }
    }
    return parsed;
}
/** Record git commit under project Commits section. Silent skip when no .tim-project. */
async function cmdRecordCommit(args) {
    const flags = parseArgs(args);
    const cwd = flags.cwd ?? process.cwd();
    const located = (0, tim_hooks_1.findMarker)(cwd, { walkUp: true, ...(0, tim_hooks_1.findMarkerOptionsFromEnv)() });
    const projectId = flags.project ?? located?.marker.project;
    if (!projectId)
        return;
    const sessionId = flags.session ?? located?.marker.session ?? undefined;
    let hash = flags.hash;
    let message = flags.message;
    let diffSummary = flags.diff;
    let author = flags.author;
    let date = flags.date;
    let branch = flags.branch;
    if (!hash || !message) {
        if (!(0, git_commit_js_1.isGitRepo)(cwd)) {
            console.error('Not a git repository and --hash/--message not provided');
            process.exit(1);
        }
        const info = (0, git_commit_js_1.readGitCommit)(cwd, hash);
        hash = hash ?? info.hash;
        message = message ?? info.message;
        diffSummary = diffSummary ?? info.diffSummary;
        author = author ?? info.author;
        date = date ?? info.date;
        branch = branch ?? info.branch;
    }
    if (!hash || !message) {
        console.error('Usage: tim record-commit [--cwd DIR] [--project LABEL] [--session ID] [--hash SHA] [--message TEXT] [--diff STAT]');
        process.exit(1);
    }
    const config = (0, tim_core_1.loadConfig)();
    const store = new tim_store_1.TimStore(getDbPath(config));
    try {
        const mgr = new tim_store_1.CommitManager(store);
        const entry = await mgr.recordCommit({
            projectId,
            hash,
            message,
            diffSummary,
            sessionId: sessionId || undefined,
            author,
            date,
            branch,
        });
        console.log(JSON.stringify(entry, null, 2));
    }
    finally {
        store.close();
    }
}
//# sourceMappingURL=record-commit.js.map