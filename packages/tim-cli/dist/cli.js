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
const safety_js_1 = require("./safety.js");
const statusline_js_1 = require("./statusline.js");
const record_commit_js_1 = require("./record-commit.js");
const new_project_js_1 = require("./new-project.js");
const hermes_statusline_install_js_1 = require("./hermes-statusline-install.js");
const consolidate_js_1 = require("./consolidate.js");
const secret_js_1 = require("./secret.js");
const release_check_js_1 = require("./release-check.js");
const migrate_from_hmem_js_1 = require("./migrate-from-hmem.js");
const setup_agent_js_1 = require("./setup-agent.js");
const args_js_1 = require("./args.js");
const claude_hook_io_js_1 = require("./claude-hook-io.js");
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
function buildStaleMarkerDirective(projectLabel, markerDir) {
    return [
        `⚠️ Stale TIM project marker (.tim-project in ${markerDir}): ${projectLabel} does not exist in the configured TIM store.`,
        `ACTION: run tim bind-project --label <P00XX> --cwd "${markerDir}" to repair it, ` +
            `or remove ${path.join(markerDir, '.tim-project')} explicitly.`,
    ].join('\n');
}
const HELP_ALIASES = { h: 'help' };
function hasHelpFlag(args, command, subcommand) {
    return (0, args_js_1.hasBooleanFlag)(args, 'help', {
        valueOptions: (0, args_js_1.valueOptionsFor)(command, subcommand),
        aliases: command === 'new-project' ? args_js_1.NEW_PROJECT_ALIASES : HELP_ALIASES,
    });
}
const COMMAND_HELP = {
    init: 'Usage: tim init',
    doctor: 'Usage: tim doctor',
    stats: 'Usage: tim stats',
    'resolve-project': 'Usage: tim resolve-project [--cwd <dir>] [--walk-up] [--format label|json|directive]',
    'resolve-session': 'Usage: tim resolve-session --session <id> [--cwd <dir>] [--format label|directive|json]',
    'bind-project': 'Usage: tim bind-project --label <P00XX> [--cwd <dir>] [--session <id>]',
    'new-project': 'Usage: tim new-project --path <dir> --name <string> [--no-git] [--confirm]',
    'record-commit': 'Usage: tim record-commit [--cwd <dir>] [--project <label>] [--session <id>] [--hash <sha>] [--message <text>] [--diff <stat>] [--author <name>] [--date <iso>] [--branch <name>]',
    hook: 'Usage: tim hook <session-start|session-end|log|prompt-submit|claude-stop> [options]',
    'hook session-start': 'Usage: tim hook session-start --session <id> [--agent <name>] [--cwd <path>] [--harness <name>] [--project <label>] [--tool <name>] [--model <name>] [--task-summary <text>]',
    'hook session-end': 'Usage: tim hook session-end --session <id>',
    'hook log': 'Usage: tim hook log --session <id> --user <text> --agent <text> [--cwd <path>]',
    'hook prompt-submit': 'Usage: tim hook prompt-submit < Claude UserPromptSubmit JSON',
    'hook claude-stop': 'Usage: tim hook claude-stop < Claude Stop JSON',
    checkpoint: 'Usage: tim checkpoint --session <id> [--handoff-note <text>]',
    rebalance: 'Usage: tim rebalance --session <id> [--cwd <dir>]',
    statusline: 'Usage: tim statusline [--cwd <dir>] [--session <id>] [--format text|hermes]',
    'setup-hermes-statusline': 'Usage: tim setup-hermes-statusline [--dry-run] [--skip-build]',
    export: 'Usage: tim export [path.hmem] [--format hmem|text]',
    import: 'Usage: tim import <path.hmem> [--dry-run] [--deduplicate] [--repair-flags] [--no-snapshot-check]',
    'migrate-from-hmem': 'Usage: tim migrate-from-hmem <path.hmem> [--deduplicate] [--no-deduplicate] [--dry-run]',
    migrate: 'Usage: tim migrate <tags-to-types|project-kind> [options]',
    'migrate tags-to-types': 'Usage: tim migrate tags-to-types [--dry-run] [--sample-limit <count>]',
    'migrate project-kind': 'Usage: tim migrate project-kind [--dry-run]',
    snapshot: 'Usage: tim snapshot [--db <path>] [--out <path>] [--prune-hours <hours>] [--no-symlink] [--quiet]',
    restore: 'Usage: tim restore [--from <path>] [--db <path>] [--list] [--dry-run] [--force]',
    'release-check': 'Usage: tim release-check [--beta] [--json] [--skip-tests <true|false>]',
    'setup-agent': 'Usage: tim setup-agent --host claude|codex|cursor|hermes [--dry-run]',
    sync: 'Usage: tim sync <connect|disconnect|push|pull|status|dev> [options]',
    'sync connect': 'Usage: tim sync connect [--server-url <url>] [--user-id <id>] [--token <token>] [--passphrase <text>] [--register] [--tier free|pro]',
    'sync disconnect': 'Usage: tim sync disconnect',
    'sync push': 'Usage: tim sync push [--passphrase <text>]',
    'sync pull': 'Usage: tim sync pull [--passphrase <text>]',
    'sync status': 'Usage: tim sync status',
    'sync dev': 'Usage: tim sync dev [--port <number>]',
    'root-entries': 'Usage: tim root-entries [--type <type>] [--tag <tag>] [--format json|content]',
    consolidate: 'Usage: tim consolidate <find-duplicates|find-decay|run|status> [options]',
    'consolidate find-duplicates': 'Usage: tim consolidate find-duplicates --project <P00XX> [--threshold <number>]',
    'consolidate find-decay': 'Usage: tim consolidate find-decay --project <P00XX> [--access-days <days>] [--access-count <count>] [--verified-days <days>]',
    'consolidate run': 'Usage: tim consolidate run --project <P00XX>',
    'consolidate status': 'Usage: tim consolidate status --project <P00XX>',
    secret: 'Usage: tim secret <set|status|list> [args]',
    'secret set': 'Usage: tim secret set <id>',
    'secret status': 'Usage: tim secret status <id>',
    'secret list': 'Usage: tim secret list',
    user: 'Usage: tim user <init|profile>',
    'user init': 'Usage: tim user init',
    'user profile': 'Usage: tim user profile',
    'update-skills': 'Usage: tim update-skills',
    '--version': 'Usage: tim --version',
};
function printCommandHelp(cmd, subcommand) {
    const normalizedCommand = cmd === '-v' ? '--version' : cmd;
    const subcommandKey = subcommand && subcommand !== '-h' && subcommand !== '--help'
        ? `${normalizedCommand} ${subcommand}`
        : normalizedCommand;
    const help = COMMAND_HELP[subcommandKey] ?? COMMAND_HELP[normalizedCommand];
    if (help) {
        console.log(help);
        return;
    }
    console.log(`Unknown command: ${normalizedCommand}\n`);
    printRootHelp();
}
function printRootHelp() {
    console.log(`TIM — Theoretically Infinite Memory

Usage: tim <command>

Commands:
  init                     Initialize TIM
  doctor                   Run diagnostics
  stats                    Show memory statistics
  resolve-project          Resolve the nearest project marker
  resolve-session          Resolve a session's project
  bind-project             Bind a directory to a project
  new-project              Create and bind a TIM project
  record-commit            Record a git commit
  hook                     Run session lifecycle hooks
  checkpoint               Create a manual checkpoint
  rebalance                Rebalance exchange batches
  statusline               Print status text or Hermes JSON
  setup-hermes-statusline  Install the Hermes status bar
  export                   Export TIM memory
  import                   Import TIM memory
  migrate-from-hmem        Run guided hmem migration
  migrate                  Run metadata migrations
  snapshot                 Snapshot the TIM database
  restore                  Restore the TIM database
  release-check            Run release verification
  setup-agent              Install TIM for an agent host
  sync                     Manage hosted sync
  root-entries             List root entries
  consolidate              Run memory consolidation
  secret                   Manage secret entry metadata
  user                     Manage the human profile
  update-skills            Copy TIM skills to detected hosts

Options:
  -h, --help               Show help
  -v, --version            Show version`);
}
async function cmdInit() {
    const timDir = (0, tim_core_1.getTimDir)();
    const config = (0, tim_core_1.loadConfig)();
    const dbPath = getDbPath(config);
    const mcpEntry = (0, install_js_1.buildTimMcpEntry)(dbPath);
    ensureDir(timDir);
    const store = new tim_store_1.TimStore(dbPath);
    try {
        await store.registerAgent('Default Agent', 'default');
        console.log('✓ Agent registered: "default"');
    }
    catch { }
    const { installed, skipped } = (0, install_js_1.installMcpEntryForHosts)(mcpEntry, true);
    if (installed.length > 0) {
        for (const i of installed) {
            console.log(`✓ MCP config: ${i.tool} → ${i.path}`);
        }
    }
    for (const s of skipped) {
        console.error(`⚠ Skipped ${s.tool} (${s.path}): ${s.reason}`);
    }
    if (installed.length === 0) {
        const mcpConfig = {
            mcpServers: {
                tim: mcpEntry,
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
    console.log(`Status: ${health.status}`);
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
    const { flags } = (0, args_js_1.parseArgs)(args, { valueOptions: (0, args_js_1.valueOptionsFor)('resolve-project') });
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
            const validated = await (0, tim_hooks_1.validateMarkerAgainstStore)(marker, store);
            if (!validated) {
                process.stdout.write(buildStaleMarkerDirective(marker.project, dir));
                return;
            }
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
    const { flags } = (0, args_js_1.parseArgs)(args, {
        valueOptions: (0, args_js_1.valueOptionsFor)('resolve-session'),
    });
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
    const { flags } = (0, args_js_1.parseArgs)(args, {
        valueOptions: (0, args_js_1.valueOptionsFor)('bind-project'),
    });
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
    if (sub === 'prompt-submit') {
        try {
            const payload = await (0, claude_hook_io_js_1.readJsonStdin)();
            const prompt = typeof payload?.prompt === 'string' ? payload.prompt : '';
            const cwdRaw = typeof payload?.cwd === 'string' ? payload.cwd : '';
            const cwd = cwdRaw.trim();
            if (!prompt.trim() || !cwd)
                return;
            const config = (0, tim_core_1.loadConfig)();
            if (config.hooks?.promptSubmit?.enabled === false)
                return;
            const store = new tim_store_1.TimStore(getDbPath(config));
            let context = null;
            try {
                const marker = (0, tim_hooks_1.findMarker)(cwd);
                const result = await (0, tim_hooks_1.runPromptSubmit)(store, {
                    prompt,
                    projectLabel: marker?.marker.project,
                });
                context = result?.context ?? null;
            }
            finally {
                store.close();
            }
            if (context) {
                process.stdout.write(JSON.stringify((0, claude_hook_io_js_1.promptSubmitEnvelope)(context)));
            }
        }
        catch {
            // Claude hooks fail soft: no context, diagnostics, or nonzero exit.
        }
        return;
    }
    if (sub === 'claude-stop') {
        try {
            const payload = await (0, claude_hook_io_js_1.readJsonStdin)();
            if (!payload)
                return;
            if (payload.stop_hook_active === true)
                return;
            const sessionId = typeof payload.session_id === 'string' ? payload.session_id.trim() : '';
            const transcriptPath = typeof payload.transcript_path === 'string' ? payload.transcript_path.trim() : '';
            const cwd = typeof payload.cwd === 'string' ? payload.cwd.trim() : '';
            if (!sessionId || !transcriptPath || !cwd)
                return;
            const marker = (0, tim_hooks_1.findMarker)(cwd);
            if (!marker)
                return;
            const config = (0, tim_core_1.loadConfig)();
            const store = new tim_store_1.TimStore(getDbPath(config));
            try {
                await (0, tim_hooks_1.runClaudeStop)(store, {
                    session_id: sessionId,
                    transcript_path: transcriptPath,
                    cwd,
                    stop_hook_active: payload.stop_hook_active === true,
                }, { cwd });
            }
            finally {
                store.close();
            }
        }
        catch {
            // Claude Stop hooks fail soft: never block the harness.
        }
        return;
    }
    const { flags } = (0, args_js_1.parseArgs)(args.slice(1), {
        valueOptions: (0, args_js_1.valueOptionsFor)('hook', sub),
    });
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
                console.error('Usage: tim hook <session-start|session-end|log|prompt-submit|claude-stop> [options]');
                process.exit(1);
        }
    }
    finally {
        store.close();
    }
}
async function cmdRebalance(args) {
    const { flags } = (0, args_js_1.parseArgs)(args, { valueOptions: (0, args_js_1.valueOptionsFor)('rebalance') });
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
    const { flags } = (0, args_js_1.parseArgs)(args, {
        valueOptions: (0, args_js_1.valueOptionsFor)('checkpoint'),
    });
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
    const { flags, positional } = (0, args_js_1.parseArgs)(args, { valueOptions: (0, args_js_1.valueOptionsFor)('export') });
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
    const { flags, positional } = (0, args_js_1.parseArgs)(args);
    const sourcePath = positional[0];
    if (!sourcePath) {
        console.error('Usage: tim import <path.hmem> [--dry-run] [--deduplicate] [--repair-flags] [--no-snapshot-check]');
        process.exit(1);
    }
    if ((0, safety_js_1.requiresSnapshot)(flags['repair-flags'] === 'true' ? 'repair-flags' : 'import', flags) &&
        flags['no-snapshot-check'] !== 'true') {
        console.error('Refusing live import without snapshot acknowledgement. Run `tim snapshot` first or pass --no-snapshot-check.');
        process.exit(1);
    }
    const config = (0, tim_core_1.loadConfig)();
    const store = new tim_store_1.TimStore(getDbPath(config));
    try {
        if (flags['repair-flags'] === 'true') {
            const report = (0, tim_migrate_1.repairImportFlags)(store, sourcePath, {
                dryRun: flags['dry-run'] === 'true',
            });
            console.log(JSON.stringify(report, null, 2));
            return;
        }
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
    const { flags } = (0, args_js_1.parseArgs)(args, {
        valueOptions: (0, args_js_1.valueOptionsFor)('migrate', 'tags-to-types'),
    });
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
async function cmdMigrateProjectKind(args) {
    const { flags } = (0, args_js_1.parseArgs)(args);
    const dryRun = flags['dry-run'] === 'true';
    const config = (0, tim_core_1.loadConfig)();
    const store = new tim_store_1.TimStore(getDbPath(config));
    try {
        const report = (0, tim_migrate_1.repairProjectKind)(store, { dryRun });
        console.log(JSON.stringify(report, null, 2));
        if (dryRun) {
            console.error(`\n[tim] migrate project-kind — DRY RUN. ${report.repaired} of ${report.matched} P-roots would be repaired.`);
        }
        else {
            console.error(`\n[tim] migrate project-kind — ${report.repaired} of ${report.matched} P-roots repaired.`);
        }
    }
    finally {
        store.close();
    }
}
async function cmdRootEntries(args) {
    const { flags } = (0, args_js_1.parseArgs)(args, {
        valueOptions: (0, args_js_1.valueOptionsFor)('root-entries'),
    });
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
async function cmdReleaseCheck(args) {
    const { flags } = (0, args_js_1.parseArgs)(args, { valueOptions: (0, args_js_1.valueOptionsFor)('release-check') });
    const summary = await (0, release_check_js_1.runReleaseCheck)({
        beta: flags.beta === 'true',
        skipTests: flags['skip-tests'] === 'true',
    });
    if (flags.json === 'true') {
        console.log(JSON.stringify(summary, null, 2));
    }
    else {
        console.log(`Release check: ${summary.status}`);
        if (summary.blockers.length) {
            for (const blocker of summary.blockers) {
                console.log(`- ${blocker}`);
            }
        }
        for (const result of summary.results) {
            console.log(`${result.ok ? '✓' : '✗'} ${result.id}: ${result.detail}`);
        }
    }
    if (summary.status === 'BLOCKER') {
        process.exit(1);
    }
}
async function main() {
    const cmd = process.argv[2] || 'init';
    const rest = process.argv.slice(3);
    if (hasHelpFlag(rest, cmd, rest[0])) {
        printCommandHelp(cmd, rest[0]);
        return;
    }
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
            const { flags } = (0, args_js_1.parseArgs)(rest, {
                valueOptions: (0, args_js_1.valueOptionsFor)('statusline'),
            });
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
        case 'migrate-from-hmem':
            await (0, migrate_from_hmem_js_1.cmdMigrateFromHmem)(rest);
            break;
        case 'migrate': {
            // Subcommand dispatch: `tim migrate <sub> [args...]`
            const sub = rest[0];
            if (sub === 'tags-to-types') {
                await cmdMigrateTagsToTypes(rest.slice(1));
            }
            else if (sub === 'project-kind') {
                await cmdMigrateProjectKind(rest.slice(1));
            }
            else {
                console.error(`Usage: tim migrate <subcommand>\n` +
                    `  tags-to-types   Convert legacy #rule / #human tags to metadata.type [--dry-run] [--sample-limit N]\n` +
                    `  project-kind    Backfill metadata.kind=project on imported P-prefix roots [--dry-run]`);
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
        case 'release-check':
            await cmdReleaseCheck(rest);
            break;
        case 'setup-agent':
            await (0, setup_agent_js_1.cmdSetupAgent)(rest);
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
            printRootHelp();
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