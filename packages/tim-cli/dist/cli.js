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
const install_js_1 = require("./install.js");
const user_js_1 = require("./user.js");
const tim_migrate_1 = require("tim-migrate");
const sync_cli_js_1 = require("./sync-cli.js");
const snapshot_js_1 = require("./snapshot.js");
const restore_js_1 = require("./restore.js");
const statusline_js_1 = require("./statusline.js");
const record_commit_js_1 = require("./record-commit.js");
const new_project_js_1 = require("./new-project.js");
const hermes_statusline_install_js_1 = require("./hermes-statusline-install.js");
const consolidate_js_1 = require("./consolidate.js");
const secret_js_1 = require("./secret.js");
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
    const installed = (0, install_js_1.installMcpForHosts)(dbPath, true);
    if (installed.length > 0) {
        for (const i of installed) {
            console.log(`✓ MCP config: ${i.tool} → ${i.path}`);
        }
    }
    else {
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
        console.log(`✓ MCP config written: ${timDir}/mcp.json`);
    }
    const health = await store.health();
    console.log(`✓ Database created: ${dbPath}`);
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
    const hermesDir = path.join(os.homedir(), '.hermes');
    if (fs.existsSync(hermesDir)) {
        const { installed, issues } = (0, hermes_statusline_install_js_1.auditHermesStatusline)();
        if (installed) {
            console.log('\nHermes statusline: ✓ installed');
        }
        else {
            console.log('\nHermes statusline: ✗ not fully installed');
            issues.forEach(i => console.log(`  - ${i}`));
            console.log('  Fix: tim setup-hermes-statusline');
        }
    }
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
    const envOpts = (0, tim_hooks_1.findMarkerOptionsFromEnv)() ?? {};
    const walkUp = flags['walk-up'] !== undefined ? flags['walk-up'] === 'true' : (envOpts.walkUp ?? false);
    const located = (0, tim_hooks_1.findMarker)(cwd, { ...envOpts, walkUp });
    if (!located)
        return; // no marker (or corrupt nearest) → silent skip, exit 0
    const { marker, dir } = located;
    if (format === 'json') {
        console.log(JSON.stringify({ ...marker, dir }));
        return;
    }
    const config = (0, tim_core_1.loadConfig)();
    const store = new tim_store_1.TimStore(getDbPath(config));
    try {
        if (format === 'directive') {
            const binding = await (0, tim_store_1.resolveProjectBindingLabel)(store, marker.project);
            process.stdout.write((0, tim_hooks_1.buildLoadDirective)(marker.project, dir, binding));
        }
        else {
            process.stdout.write(marker.project);
        }
    }
    finally {
        store.close();
    }
}
async function cmdResolveSession(args) {
    const flags = parseArgs(args);
    const sessionId = flags.session?.trim();
    if (!sessionId) {
        console.error('Usage: tim resolve-session --session <id> [--cwd <dir>] [--format label|directive|json]');
        process.exit(1);
    }
    const cwd = flags.cwd ?? process.cwd();
    const format = flags.format ?? 'label';
    const config = (0, tim_core_1.loadConfig)();
    const store = new tim_store_1.TimStore(getDbPath(config));
    try {
        const entry = await store.read(sessionId);
        if (!entry || entry.metadata.kind !== 'session')
            return;
        const projectRef = typeof entry.metadata.project_ref === 'string' ? entry.metadata.project_ref.trim() : '';
        if (!projectRef)
            return;
        if (format === 'json') {
            console.log(JSON.stringify({ sessionId, project: projectRef, cwd }));
        }
        else if (format === 'directive') {
            const binding = await (0, tim_store_1.resolveProjectBindingLabel)(store, projectRef);
            process.stdout.write((0, tim_hooks_1.buildSessionDirective)(projectRef, cwd, binding));
        }
        else {
            process.stdout.write(projectRef);
        }
    }
    finally {
        store.close();
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
        version: 2,
    };
    (0, tim_hooks_1.writeMarker)(cwd, marker);
    console.log(`Wrote .tim-project → ${label} at ${cwd}`);
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
                const projectId = flags.project; // optional, auto-resolved from .tim-project
                const tool = flags.tool;
                const model = flags.model;
                const taskSummary = flags['task-summary'];
                if (!sessionId) {
                    console.error('Usage: tim hook session-start --session <id> [--agent <name>] [--cwd <path>] [--harness <h>] [--project <label>] [--tool <name>] [--model <name>]');
                    process.exit(1);
                }
                const result = await (0, tim_hooks_1.runSessionStart)(store, {
                    sessionId,
                    agentName,
                    cwd,
                    harness,
                    projectId,
                    tool,
                    model,
                    taskSummary,
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
            case 'log': {
                const sessionId = flags.session;
                const userText = flags.user || '';
                const agentText = flags.agent || '';
                if (!sessionId || !userText || !agentText) {
                    console.error('Usage: tim hook log --session <id> --user <text> --agent <text>');
                    process.exit(1);
                }
                const sessions = new tim_store_1.SessionManager(store);
                const entries = await sessions.logExchange(sessionId, [
                    { role: 'user', content: userText },
                    { role: 'agent', content: agentText },
                ]);
                const cadence = await (0, tim_hooks_1.afterExchangeLogged)(store, sessionId, flags.cwd || process.cwd());
                console.log(JSON.stringify({ count: entries.length, cadence }, null, 2));
                break;
            }
            default:
                console.error(`Unknown hook: ${sub ?? '(none)'}`);
                console.error('Usage: tim hook <session-start|session-end|log> [options]');
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
        const summary = await (0, tim_hooks_1.runCheckpoint)(store, sessionId, {
            handoffNote: flags['handoff-note'],
        });
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
async function cmdMigrateTagsToTypes(args) {
    const flags = parseArgs(args);
    const dryRun = flags['dry-run'] === 'true';
    const sampleLimit = flags['sample-limit'] ? parseInt(flags['sample-limit'], 10) : 20;
    const config = (0, tim_core_1.loadConfig)();
    const store = new tim_store_1.TimStore(getDbPath(config));
    try {
        const report = await (0, tim_migrate_1.migrateTagsToTypes)(store, { dryRun, sampleLimit });
        console.log(JSON.stringify(report, null, 2));
        if (dryRun) {
            console.error(`\n[tim] migrate tags-to-types — DRY RUN. ${report.migrated} entries would be migrated.`);
        }
        else {
            console.error(`\n[tim] migrate tags-to-types — ${report.migrated} migrated, ${report.skipped} skipped, ${report.errors.length} errors.`);
        }
    }
    finally {
        store.close();
    }
}
async function cmdRootEntries(args) {
    const flags = parseArgs(args);
    const type = flags.type;
    const tag = flags.tag;
    // Backward-compat: --tag '#rule' still works (Phase 0 keeps the alias
    // for hooks and external scripts). When --tag is the only filter, log
    // a deprecation warning and route to the type-based query path.
    let resolvedType;
    let resolvedTag;
    if (type) {
        resolvedType = type;
        if (tag) {
            // Both flags → type wins, warn about the conflict.
            console.error(`[tim] root-entries: --type and --tag both passed; --type (${type}) takes precedence.`);
        }
    }
    else if (tag) {
        const normalized = (0, tim_core_1.normalizeLegacyTypeTag)(tag);
        if (normalized) {
            console.error(`[tim] root-entries: --tag '${tag}' is deprecated; use --type ${normalized} instead.`);
            resolvedType = normalized;
        }
        else {
            // Not a known type tag → fall back to legacy JSON-LIKE matching
            // so external scripts that pass arbitrary tags keep working.
            console.error(`[tim] root-entries: --tag '${tag}' is deprecated and not a known metadata type. ` +
                `Falling back to legacy tag-LIKE match.`);
            resolvedTag = tag;
        }
    }
    const config = (0, tim_core_1.loadConfig)();
    const store = new tim_store_1.TimStore(getDbPath(config));
    try {
        const entries = store.getRootLevelEntries({ type: resolvedType, tag: resolvedTag });
        if (flags.format === 'json') {
            console.log(JSON.stringify(entries, null, 2));
            return;
        }
        if (flags.format === 'content') {
            for (const entry of entries) {
                // Emit full content block for each entry (title + body)
                const fullText = entry.content ? `${entry.title}\n${entry.content}` : entry.title;
                process.stdout.write(fullText.trimEnd() + '\n\n');
            }
            return;
        }
        // Default: JSON
        console.log(JSON.stringify(entries, null, 2));
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
        case 'resolve-session':
            await cmdResolveSession(rest);
            break;
        case 'bind-project':
            await cmdBindProject(rest);
            break;
        case 'new-project':
            await (0, new_project_js_1.cmdNewProject)(rest);
            break;
        case 'record-commit':
            await (0, record_commit_js_1.cmdRecordCommit)(rest);
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
        case 'statusline': {
            const flags = parseArgs(rest);
            await (0, statusline_js_1.runStatusline)({
                cwd: flags.cwd,
                sessionId: flags.session,
                format: flags.format === 'hermes' ? 'hermes' : 'text',
            });
            break;
        }
        case 'setup-hermes-statusline':
            await (0, hermes_statusline_install_js_1.cmdSetupHermesStatusline)(rest);
            break;
        case 'export':
            await cmdExport(rest);
            break;
        case 'import':
            await cmdImport(rest);
            break;
        case 'migrate': {
            // Subcommand dispatch: `tim migrate <sub> [args...]`
            const sub = rest[0];
            if (sub === 'tags-to-types') {
                await cmdMigrateTagsToTypes(rest.slice(1));
            }
            else {
                console.error(`Usage: tim migrate <subcommand>\n` +
                    `  tags-to-types   Convert legacy #rule / #human tags to metadata.type [--dry-run] [--sample-limit N]`);
                process.exit(1);
            }
            break;
        }
        case 'snapshot':
            await (0, snapshot_js_1.cmdSnapshot)(rest);
            break;
        case 'restore':
            await (0, restore_js_1.cmdRestore)(rest);
            break;
        case 'sync': {
            const sub = rest[0];
            await (0, sync_cli_js_1.cmdSync)(sub, rest.slice(1));
            break;
        }
        case 'root-entries':
            await cmdRootEntries(rest);
            break;
        case 'consolidate':
            await (0, consolidate_js_1.cmdConsolidate)(rest);
            break;
        case 'secret':
            await (0, secret_js_1.cmdSecret)(rest);
            break;
        case 'user': {
            const sub = rest[0];
            if (sub === 'init')
                await (0, user_js_1.cmdUserInit)();
            else if (sub === 'profile')
                await (0, user_js_1.cmdUserProfile)();
            else {
                console.error('Usage: tim user <init|profile>');
                process.exit(1);
            }
            break;
        }
        case 'update-skills':
            await (0, user_js_1.cmdUpdateSkills)();
            break;
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
  resolve-project       Print bound project from nearest .tim-project (--cwd, --walk-up, --format label|json|directive)
  resolve-session       Print project_ref for a TIM session (--session, --format label|directive|json)
  bind-project          Write/refresh .tim-project for a project (--label, --cwd, --session)
  new-project           Create a new TIM project + bind to dir (-p <path> -n <name> [--no-git] [--confirm])
  record-commit         Record git commit to project Commits section (--cwd, --hash, --message, --diff)
  hook session-start    Start a session (--session, --agent, --cwd, --harness)
  hook session-end      End a session and run checkpoint (--session)
  checkpoint            Manual checkpoint for a session (--session)
  rebalance             Rebalance exchange batches at boundaries (--session, --cwd)
  statusline            Status text or Hermes JSON (--cwd, --session, --format text|hermes)
  setup-hermes-statusline  Install Hermes TUI status bar (symlinks, config, cli patch) [--dry-run] [--skip-build]
  export [path]           Export to .hmem or markdown (--format hmem|text)
  import <path>           Import from .hmem (--dry-run, --deduplicate)
  migrate tags-to-types   Convert legacy #rule / #human tags to metadata.type (--dry-run, --sample-limit N)
  snapshot                 Snapshot the live TIM DB to /tmp/tim-snapshots/ (SQLite backup API)
  restore                  Restore TIM DB from a snapshot (--from, --list, --dry-run, --force)
  sync connect            Connect to hosted sync (use --register for new tenant)
  sync disconnect         Remove local sync configuration
  sync push               Push unacked staging to server
  sync pull               Pull remote changes
  sync status             Show sync configuration and health
  sync dev                Start local dev sync server (port 3100)
  user init               Create human profile scaffold (H0000)
  user profile            Show human profile tree summary
  update-skills           Copy TIM skills to detected AI hosts
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