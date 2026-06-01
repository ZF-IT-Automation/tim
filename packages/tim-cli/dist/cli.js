#!/usr/bin/env node
"use strict";
// TIM CLI — v0.1.0-alpha
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
const tim_store_1 = require("tim-store");
const tim_core_1 = require("tim-core");
const tim_hooks_1 = require("tim-hooks");
const tim_migrate_1 = require("tim-migrate");
const sync_cli_js_1 = require("./sync-cli.js");
const git_commit_js_1 = require("./git-commit.js");
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
function getDbPath(config) {
    return process.env.TIM_DB_PATH || config.dbPath || path.join(os.homedir(), '.tim', 'tim.db');
}
function ensureDir(dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
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
async function cmdInit() {
    const timDir = (0, tim_core_1.getTimDir)();
    ensureDir(timDir);
    const config = (0, tim_core_1.loadConfig)();
    const dbPath = getDbPath(config);
    const store = new tim_store_1.TimStore(dbPath);
    try {
        await store.registerAgent('Default Agent', 'default');
        console.log('✓ Agent registered: "default"');
    }
    catch { }
    const mcpConfig = {
        mcpServers: {
            tim: {
                command: 'npx',
                args: ['tim-mcp'],
                env: { TIM_DB_PATH: dbPath },
            },
        },
    };
    fs.writeFileSync(path.join(timDir, 'mcp.json'), JSON.stringify(mcpConfig, null, 2));
    const health = await store.health();
    console.log(`✓ Database created: ${dbPath}`);
    console.log(`✓ MCP config written: ${timDir}/mcp.json`);
    console.log(`✓ Health: ${health.totalEntries} entries, FTS5=${health.ftsIntegrity ? 'OK' : 'BROKEN'}`);
    console.log(`\nTIM ready. Connect your MCP client to ${timDir}/mcp.json`);
    store.close();
}
async function cmdDoctor() {
    const config = (0, tim_core_1.loadConfig)();
    const store = new tim_store_1.TimStore(getDbPath(config));
    const health = await store.health();
    const stats = await store.stats();
    const agents = await store.getAgents();
    console.log('═══ TIM Doctor ═══');
    console.log(`DB: ${getDbPath(config)}`);
    console.log(`Entries: ${stats.totalEntries} | Edges: ${stats.totalEdges}`);
    console.log(`Confidence avg: ${stats.avgConfidence?.toFixed(2) ?? 'N/A'}`);
    console.log(`Broken links: ${health.brokenLinks}`);
    console.log(`Orphan entries: ${health.orphanEntries}`);
    console.log(`FTS5: ${health.ftsIntegrity ? '✓' : '✗ BROKEN'}`);
    console.log(`Agents: ${agents.map(a => a.label).join(', ') || 'none'}`);
    if (stats.oldestEntry)
        console.log(`Oldest: ${stats.oldestEntry}`);
    if (stats.newestEntry)
        console.log(`Newest: ${stats.newestEntry}`);
    console.log(`Stale (>30d): ${stats.staleCount}`);
    if (health.issues.length) {
        console.log('\n⚠ Issues:');
        health.issues.forEach(i => console.log(`  - ${i}`));
    }
    console.log(`\nTop tags: ${stats.topTags.slice(0, 5).map(t => `${t.tag}(${t.count})`).join(', ') || 'none'}`);
    store.close();
}
async function cmdStats() {
    const config = (0, tim_core_1.loadConfig)();
    const store = new tim_store_1.TimStore(getDbPath(config));
    const stats = await store.stats();
    console.log(JSON.stringify(stats, null, 2));
    store.close();
}
async function cmdResolveProject(args) {
    const flags = parseArgs(args);
    const cwd = flags.cwd ?? process.cwd();
    const format = flags.format ?? 'label';
    const located = (0, tim_hooks_1.findMarker)(cwd);
    if (!located)
        return; // no marker (or corrupt nearest) → silent skip, exit 0
    const { marker, dir } = located;
    if (format === 'json') {
        console.log(JSON.stringify({ ...marker, dir }));
    }
    else if (format === 'directive') {
        process.stdout.write((0, tim_hooks_1.buildLoadDirective)(marker.project, dir));
    }
    else {
        process.stdout.write(marker.project);
    }
}
async function cmdBindProject(args) {
    const flags = parseArgs(args);
    const cwd = flags.cwd ?? process.cwd();
    const label = flags.label;
    if (!label) {
        console.error('Usage: tim bind-project --label <P00XX> [--cwd <dir>] [--session <id>]');
        process.exit(1);
    }
    const existing = (0, tim_hooks_1.readMarker)(cwd);
    const marker = {
        project: label,
        session: flags.session ?? existing?.session ?? '',
        exchanges: existing?.exchanges ?? 0,
        batch_size: existing?.batch_size ?? 5,
        batches_summarized: existing?.batches_summarized ?? 0,
    };
    (0, tim_hooks_1.writeMarker)(cwd, marker);
    console.log(`Wrote .tim-project → ${label} at ${cwd}`);
}
async function cmdRecordCommit(args) {
    const flags = parseArgs(args);
    const cwd = flags.cwd ?? process.cwd();
    const located = (0, tim_hooks_1.findMarker)(cwd);
    const projectId = flags.project ?? located?.marker.project;
    if (!projectId)
        return; // no marker → silent skip (hook path)
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
async function cmdHook(args) {
    const sub = args[0];
    const flags = parseArgs(args.slice(1));
    const config = (0, tim_core_1.loadConfig)();
    const store = new tim_store_1.TimStore(getDbPath(config));
    try {
        switch (sub) {
            case 'session-start': {
                const sessionId = flags.session;
                const agentName = flags.agent ?? 'default';
                const cwd = flags.cwd ?? process.cwd();
                const harness = flags.harness ?? 'unknown';
                if (!sessionId) {
                    console.error('Usage: tim hook session-start --session <id> [--agent <name>] [--cwd <path>] [--harness <h>]');
                    process.exit(1);
                }
                const result = await (0, tim_hooks_1.runSessionStart)(store, {
                    sessionId,
                    agentName,
                    cwd,
                    harness,
                    hooksConfig: config.hooks,
                });
                console.log(JSON.stringify(result, null, 2));
                break;
            }
            case 'session-end': {
                const sessionId = flags.session;
                if (!sessionId) {
                    console.error('Usage: tim hook session-end --session <id>');
                    process.exit(1);
                }
                const summary = await (0, tim_hooks_1.runSessionEnd)(store, sessionId, {
                    hooksConfig: config.hooks,
                    env: { TIM_CWD: process.cwd() },
                });
                console.log(JSON.stringify({ summary }, null, 2));
                break;
            }
            default:
                console.error(`Unknown hook: ${sub ?? '(none)'}`);
                console.error('Usage: tim hook <session-start|session-end> [options]');
                process.exit(1);
        }
    }
    finally {
        store.close();
    }
}
async function cmdRebalance(args) {
    const flags = parseArgs(args);
    const sessionId = flags.session;
    if (!sessionId) {
        console.error('Usage: tim rebalance --session <id>');
        process.exit(1);
    }
    const config = (0, tim_core_1.loadConfig)();
    const store = new tim_store_1.TimStore(getDbPath(config));
    try {
        const result = await (0, tim_hooks_1.rebalanceBatch)(store, sessionId, {
            cwd: flags.cwd || process.cwd(),
        });
        console.log(JSON.stringify(result, null, 2));
    }
    finally {
        store.close();
    }
}
async function cmdCheckpoint(args) {
    const flags = parseArgs(args);
    const sessionId = flags.session;
    if (!sessionId) {
        console.error('Usage: tim checkpoint --session <id>');
        process.exit(1);
    }
    const config = (0, tim_core_1.loadConfig)();
    const store = new tim_store_1.TimStore(getDbPath(config));
    try {
        const summary = await (0, tim_hooks_1.runCheckpoint)(store, sessionId);
        console.log(JSON.stringify({ summary }, null, 2));
    }
    finally {
        store.close();
    }
}
async function cmdExport(args) {
    const flags = parseArgs(args);
    const positional = args.filter(a => !a.startsWith('--'));
    const targetPath = positional[0];
    const format = flags.format === 'text' ? 'text' : 'hmem';
    const config = (0, tim_core_1.loadConfig)();
    const store = new tim_store_1.TimStore(getDbPath(config));
    try {
        if (format === 'text') {
            const md = (0, tim_migrate_1.exportToMarkdown)(store);
            process.stdout.write(md);
            return;
        }
        if (!targetPath) {
            console.error('Usage: tim export <path.hmem> [--format hmem|text]');
            process.exit(1);
        }
        const result = (0, tim_migrate_1.tim_export)(store, targetPath, { format: 'hmem' });
        console.log(JSON.stringify(result, null, 2));
    }
    finally {
        store.close();
    }
}
async function cmdImport(args) {
    const flags = parseArgs(args);
    const positional = args.filter(a => !a.startsWith('--'));
    const sourcePath = positional[0];
    if (!sourcePath) {
        console.error('Usage: tim import <path.hmem> [--dry-run] [--deduplicate]');
        process.exit(1);
    }
    const config = (0, tim_core_1.loadConfig)();
    const store = new tim_store_1.TimStore(getDbPath(config));
    try {
        const report = (0, tim_migrate_1.tim_import)(store, sourcePath, {
            dryRun: flags['dry-run'] === 'true',
            deduplicate: flags.deduplicate === 'true',
        });
        console.log(JSON.stringify(report, null, 2));
    }
    finally {
        store.close();
    }
}
async function main() {
    const cmd = process.argv[2] || 'init';
    const rest = process.argv.slice(3);
    switch (cmd) {
        case 'init':
            await cmdInit();
            break;
        case 'doctor':
            await cmdDoctor();
            break;
        case 'stats':
            await cmdStats();
            break;
        case 'resolve-project':
            await cmdResolveProject(rest);
            break;
        case 'bind-project':
            await cmdBindProject(rest);
            break;
        case 'record-commit':
            await cmdRecordCommit(rest);
            break;
        case 'hook':
            await cmdHook(rest);
            break;
        case 'checkpoint':
            await cmdCheckpoint(rest);
            break;
        case 'rebalance':
            await cmdRebalance(rest);
            break;
        case 'export':
            await cmdExport(rest);
            break;
        case 'import':
            await cmdImport(rest);
            break;
        case 'sync': {
            const sub = rest[0];
            await (0, sync_cli_js_1.cmdSync)(sub, rest.slice(1));
            break;
        }
        case '--version':
        case '-v':
            console.log('tim v0.1.0-alpha');
            break;
        case '--help':
        case '-h':
            console.log(`TIM — Theoretically Infinite Memory

Usage: tim <command>

Commands:
  init                  Initialize TIM (create DB, register agents, write MCP config)
  doctor                Run diagnostics
  stats                 Show memory statistics
  resolve-project       Print bound project from nearest .tim-project (--cwd, --format label|json|directive)
  bind-project          Write/refresh .tim-project for a project (--label, --cwd, --session)
  record-commit         Record git commit to project Commits section (--cwd, --hash, --message, --diff)
  hook session-start    Start a session (--session, --agent, --cwd, --harness)
  hook session-end      End a session and run checkpoint (--session)
  checkpoint            Manual checkpoint for a session (--session)
  rebalance             Rebalance exchange batches at boundaries (--session, --cwd)
  export [path]           Export to .hmem or markdown (--format hmem|text)
  import <path>           Import from .hmem (--dry-run, --deduplicate)
  sync connect            Connect to o9k-sync server
  sync push               Push unacked staging to server
  sync pull               Pull remote changes
  sync status             Show sync configuration and health
  sync dev                Start local dev sync server (port 3100)
  --help                Show this help`);
            break;
        default:
            console.log(`Unknown command: ${cmd}\nRun 'tim --help' for usage.`);
            process.exit(1);
    }
}
main().catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
});
//# sourceMappingURL=cli.js.map