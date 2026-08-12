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
const summarizer_health_js_1 = require("./summarizer-health.js");
const harness_db_audit_js_1 = require("./harness-db-audit.js");
const project_schema_repair_js_1 = require("./project-schema-repair.js");
const secret_js_1 = require("./secret.js");
const release_check_js_1 = require("./release-check.js");
const migrate_from_hmem_js_1 = require("./migrate-from-hmem.js");
const setup_agent_js_1 = require("./setup-agent.js");
const viewer_js_1 = require("./viewer.js");
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
function buildMigrationPendingDirective(gateMessage) {
    return [
        `⚠️ TIM is not available in this session: the store's schema is behind this build.`,
        gateMessage,
        `ACTION: tell the user to run "tim migrate-schema" (it backs the database up first). ` +
            `Until then every TIM tool call will fail with the same message.`,
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
    doctor: 'Usage: tim doctor [--bind] [--repair-schema] [--project <P00XX>]',
    stats: 'Usage: tim stats',
    'resolve-project': 'Usage: tim resolve-project [--cwd <dir>] [--walk-up] [--format label|json|directive]',
    'resolve-session': 'Usage: tim resolve-session --session <id> [--cwd <dir>] [--format label|directive|json]',
    'bind-project': 'Usage: tim bind-project --label <P00XX> [--cwd <dir>]',
    'new-project': 'Usage: tim new-project --path <dir> --name <string> [--no-git] [--confirm]',
    'record-commit': 'Usage: tim record-commit [--cwd <dir>] [--project <label>] [--session <id>] [--hash <sha>] [--message <text>] [--diff <stat>] [--author <name>] [--date <iso>] [--branch <name>]',
    hook: 'Usage: tim hook <session-start|session-end|log|prompt-submit|claude-session-start|claude-session-end|claude-stop|cursor-stop|codex-notify> [options]',
    'hook session-start': 'Usage: tim hook session-start --session <id> [--agent <name>] [--cwd <path>] [--harness <name>] [--project <label>] [--tool <name>] [--model <name>] [--task-summary <text>]',
    'hook session-end': 'Usage: tim hook session-end --session <id>',
    'hook log': 'Usage: tim hook log --session <id> --user <text> --agent <text> [--cwd <path>]',
    'hook prompt-submit': 'Usage: tim hook prompt-submit < Claude UserPromptSubmit JSON',
    'hook claude-session-start': 'Usage: tim hook claude-session-start < Claude SessionStart JSON',
    'hook claude-session-end': 'Usage: tim hook claude-session-end < Claude SessionEnd JSON',
    'hook claude-stop': 'Usage: tim hook claude-stop < Claude Stop JSON',
    'hook cursor-stop': 'Usage: tim hook cursor-stop < Cursor stop/sessionEnd JSON',
    'hook codex-notify': "Usage: tim hook codex-notify '<Codex agent-turn-complete JSON>'",
    checkpoint: 'Usage: tim checkpoint --session <id> [--handoff-note <text>]',
    rebalance: 'Usage: tim rebalance --session <id> [--cwd <dir>]',
    statusline: 'Usage: tim statusline [--cwd <dir>] [--session <id>] [--format text|hermes]',
    'setup-hermes-statusline': 'Usage: tim setup-hermes-statusline [--dry-run] [--skip-build]',
    export: 'Usage: tim export [path.hmem] [--format hmem|text]',
    import: 'Usage: tim import <path.hmem> [--dry-run] [--deduplicate] [--repair-flags] [--no-snapshot-check]',
    'migrate-from-hmem': 'Usage: tim migrate-from-hmem <path.hmem> [--deduplicate] [--no-deduplicate] [--dry-run]',
    'migrate-schema': 'Usage: tim migrate-schema',
    migrate: 'Usage: tim migrate <tags-to-types|project-kind|retire-deprecated-tags> [options]',
    'migrate tags-to-types': 'Usage: tim migrate tags-to-types [--dry-run] [--sample-limit <count>]',
    'migrate project-kind': 'Usage: tim migrate project-kind [--dry-run]',
    'migrate retire-deprecated-tags': 'Usage: tim migrate retire-deprecated-tags [--dry-run] [--sample-limit <count>]',
    'reap-checkpoints': 'Usage: tim reap-checkpoints',
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
    viewer: 'Usage: tim viewer [--port <number>] [--host 127.0.0.1] [--db <path>] [--show-secrets]',
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
  hook session-start       Start a new session
  hook session-end         End a session and run checkpoint
  hook log                 Log a single exchange to a session
  checkpoint               Create a manual checkpoint
  rebalance                Rebalance exchange batches
  statusline               Print status text or Hermes JSON
  setup-hermes-statusline  Install the Hermes status bar
  export                   Export TIM memory
  import                   Import TIM memory
  migrate-from-hmem        Run guided hmem migration
  migrate-schema           Apply pending database schema migrations
  migrate                  Run metadata migrations
  reap-checkpoints         Reap checkpoints whose session already has a summarizer rollup
  snapshot                 Snapshot the TIM database
  restore                  Restore the TIM database
  release-check            Run release verification
  setup-agent              Install TIM for an agent host
  sync connect             Connect to o9k-sync server
  sync disconnect          Remove local sync configuration
  sync push                Push unacked staging to server
  sync pull                Pull remote changes
  sync status              Show sync configuration and health
  sync dev                 Start local dev sync server (port 3100)
  user init                Create the human profile scaffold
  user profile             Show the human profile tree summary
  update-skills            Copy TIM skills to detected hosts
  root-entries             List root entries
  consolidate              Run memory consolidation
  secret                   Manage secret entry metadata
  viewer                   Browse the entry tree in a local read-only web UI
  --help                   Show this help`);
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
async function cmdDoctor(args = []) {
    const { flags } = (0, args_js_1.parseArgs)(args, { valueOptions: (0, args_js_1.valueOptionsFor)('doctor') });
    const doBind = flags.bind === 'true';
    const doRepairSchema = flags['repair-schema'] === 'true';
    const projectFilter = flags.project;
    const config = (0, tim_core_1.loadConfig)();
    const store = new tim_store_1.TimStore(getDbPath(config));
    const health = await store.health();
    const stats = await store.stats();
    const agents = await store.getAgents();
    const bindingReport = await (0, tim_hooks_1.collectBindingReport)(store);
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
    const lastSchemaMigration = store.getDb().prepare(`
    SELECT timestamp, args_json FROM error_log
    WHERE tool = 'schema_migration'
    ORDER BY id DESC LIMIT 1
  `).get();
    if (lastSchemaMigration) {
        try {
            const args = JSON.parse(lastSchemaMigration.args_json);
            // Stored as UTC ISO; doctor is read by a human at their own clock.
            const when = new Date(lastSchemaMigration.timestamp)
                .toLocaleString('sv-SE', { dateStyle: 'short', timeStyle: 'short' });
            console.log(`schema moved ${args.from} → ${args.to} at ${when}`);
        }
        catch {
            // Malformed log row — skip; absence of a clean line is fine.
        }
    }
    if (health.issues.length) {
        console.log('\n⚠ Issues:');
        health.issues.forEach(i => console.log(`  - ${i}`));
    }
    console.log(`\nTop tags: ${stats.topTags.slice(0, 5).map(t => `${t.tag}(${t.count})`).join(', ') || 'none'}`);
    const errorStats = new tim_store_1.ErrorLogger(store.getDb()).getStats({ hours: 24, limit: 5 });
    console.log(`\nErrors (24h): ${errorStats.totalErrors} | Rate: ${errorStats.errorRate}/h`);
    errorStats.alerts.forEach(a => console.log(`  ⚠ ${a}`));
    // Zod validation errors are pretty-printed JSON; flattened they stay scannable.
    errorStats.topErrors.forEach(e => console.log(`  ${e.count}x ${e.error.replace(/\s+/g, ' ').slice(0, 120)}`));
    console.log('\nBindings:');
    if (bindingReport.projects.length === 0 && bindingReport.stalePaths.length === 0) {
        console.log('  (none)');
    }
    else {
        for (const finding of bindingReport.projects) {
            console.log((0, tim_hooks_1.formatBindingFindingLine)(finding));
        }
        for (const stale of bindingReport.stalePaths) {
            console.log((0, tim_hooks_1.formatStalePathLine)(stale));
        }
    }
    if (doBind) {
        const outcomes = await (0, tim_hooks_1.bindUnboundBindings)(store, bindingReport.projects);
        console.log('\nBind:');
        if (outcomes.length === 0) {
            console.log('  (none)');
        }
        else {
            for (const outcome of outcomes) {
                console.log((0, tim_hooks_1.formatBindOutcomeLine)(outcome));
            }
        }
    }
    const summarizer = await (0, summarizer_health_js_1.auditSummarizerHealth)(store, config);
    console.log('\nSummarizer:');
    if (summarizer.healthy) {
        console.log(`  ✓ chain: ${summarizer.firstEntry} (+${summarizer.chainLength - 1} fallback(s))`);
    }
    else {
        console.log(summarizer.chainLength === 0
            ? '  ✗ no chain configured'
            : `  ⚠ chain: ${summarizer.firstEntry} (+${summarizer.chainLength - 1} fallback(s))`);
        summarizer.issues.forEach(i => console.log(`  - ${i}`));
    }
    // Projects created before the schema became authoritative are missing sections.
    // Report always; only change the DB behind the explicit --repair-schema opt-in.
    const schemaReport = await (0, project_schema_repair_js_1.collectProjectSchemaReport)(store, projectFilter);
    console.log('\nProject schema:');
    if (schemaReport.length === 0) {
        console.log('  (none)');
    }
    else {
        const incomplete = schemaReport.filter(project_schema_repair_js_1.needsSchemaRepair);
        for (const finding of schemaReport) {
            console.log((0, project_schema_repair_js_1.formatProjectSchemaFindingLine)(finding));
        }
        if (incomplete.length > 0 && !doRepairSchema) {
            console.log(`  Fix: tim doctor --repair-schema${projectFilter ? ` --project ${projectFilter}` : ''} ` +
                '(adds missing sections only; custom sections are kept)');
        }
    }
    if (doRepairSchema) {
        const outcomes = await (0, project_schema_repair_js_1.repairProjectSchemas)(store, schemaReport);
        console.log('\nSchema repair:');
        if (outcomes.length === 0) {
            console.log('  (nothing to add)');
        }
        else {
            for (const outcome of outcomes) {
                console.log((0, project_schema_repair_js_1.formatProjectSchemaOutcomeLine)(outcome));
            }
        }
    }
    const harnessDb = (0, harness_db_audit_js_1.auditHarnessDbPaths)(getDbPath(config));
    if (harnessDb.length > 0) {
        const wrong = harnessDb.filter(f => !f.matches);
        console.log('\nHarness DB paths:');
        if (wrong.length === 0) {
            console.log(`  ✓ ${harnessDb.length} config(s) point at this DB`);
        }
        else {
            for (const finding of wrong) {
                console.log(`  ✗ ${finding.configPath} → ${finding.configured}`);
            }
            console.log('  Agents using these read and write a different database than the one above.');
        }
    }
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
/**
 * Marker at `cwd` → full session-start directive. Shared by `resolve-project
 * --format directive` and the `hook claude-session-start` entry point. Returns null
 * when there is no marker (callers stay silent and exit 0).
 */
async function buildStartDirectiveForCwd(cwd, walkUp) {
    // A briefing injected into a summarizer child ends up in the text being summarized.
    if ((0, tim_hooks_1.isSummarizerChild)())
        return null;
    const envOpts = (0, tim_hooks_1.findMarkerOptionsFromEnv)() ?? {};
    const located = (0, tim_hooks_1.findMarker)(cwd, { ...envOpts, walkUp: walkUp ?? envOpts.walkUp ?? false });
    if (!located)
        return null;
    const { marker, dir } = located;
    const config = (0, tim_core_1.loadConfig)();
    let store;
    try {
        store = new tim_store_1.TimStore(getDbPath(config));
    }
    catch (error) {
        // The migration gate refuses on purpose and its message carries the fix. Every
        // caller of this function swallows throws (hooks fail soft, the shell script
        // drops stderr), so the one deliberate refusal has to come back as directive
        // content instead. Anything else keeps failing soft.
        if ((0, tim_store_1.isSchemaMigrationPendingError)(error))
            return buildMigrationPendingDirective(error.message);
        throw error;
    }
    try {
        const validated = await (0, tim_hooks_1.validateMarkerAgainstStore)(marker, store);
        let projectLabel = validated?.project ?? null;
        if (!projectLabel) {
            const recovered = await (0, tim_hooks_1.repairPhantomProjectBinding)(store, dir);
            if (recovered) {
                (0, tim_hooks_1.writeMarker)(dir, { project: recovered });
                projectLabel = recovered;
            }
        }
        if (!projectLabel)
            return buildStaleMarkerDirective(marker.project, dir);
        const binding = await (0, tim_store_1.resolveProjectBindingLabel)(store, projectLabel);
        // The directive must carry substance, not just an instruction — a model that
        // never calls tim_load_project still gets briefed. Failure stays silent so a
        // start hook is never blocked by a briefing problem.
        //
        // No past work: this is an automatic path. The previous session was chosen by
        // recency alone, so it was noise whenever the new session was about something
        // else. `/tim-continue` renders it on demand, `/tim-resume-topic` by topic.
        const briefing = await (0, tim_hooks_1.collectDirectiveBriefing)(store, projectLabel, (0, tim_hooks_1.getBriefingMaxTokens)(config), false).catch(() => undefined);
        return (0, tim_hooks_1.buildLoadDirective)(projectLabel, dir, binding, briefing);
    }
    finally {
        store.close();
    }
}
async function cmdResolveProject(args) {
    const { flags } = (0, args_js_1.parseArgs)(args, { valueOptions: (0, args_js_1.valueOptionsFor)('resolve-project') });
    const cwd = flags.cwd ?? process.cwd();
    const format = flags.format ?? 'label';
    const envOpts = (0, tim_hooks_1.findMarkerOptionsFromEnv)() ?? {};
    const walkUp = flags['walk-up'] !== undefined ? flags['walk-up'] === 'true' : (envOpts.walkUp ?? false);
    if (format === 'directive') {
        const directive = await buildStartDirectiveForCwd(cwd, walkUp);
        if (directive)
            process.stdout.write(directive);
        return; // no marker → silent skip, exit 0
    }
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
        const validated = await (0, tim_hooks_1.validateMarkerAgainstStore)(marker, store);
        let projectLabel = validated?.project ?? null;
        if (!projectLabel) {
            const recovered = await (0, tim_hooks_1.repairPhantomProjectBinding)(store, dir);
            if (recovered) {
                (0, tim_hooks_1.writeMarker)(dir, { project: recovered });
                projectLabel = recovered;
            }
        }
        if (!projectLabel) {
            // Phantom and unrepaired — do not echo as a live binding.
            process.stdout.write(`${marker.project}?`);
        }
        else {
            process.stdout.write(projectLabel);
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
            // Automatic path as well — structure and open work only, see above.
            const briefing = await (0, tim_hooks_1.collectDirectiveBriefing)(store, projectRef, (0, tim_hooks_1.getBriefingMaxTokens)(config), false).catch(() => undefined);
            process.stdout.write((0, tim_hooks_1.buildSessionDirective)(projectRef, cwd, binding, briefing));
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
        console.error('Usage: tim bind-project --label <P00XX> [--cwd <dir>]');
        process.exit(1);
    }
    const config = (0, tim_core_1.loadConfig)();
    const store = new tim_store_1.TimStore(getDbPath(config));
    try {
        const result = await (0, tim_hooks_1.recoverProjectBinding)(store, {
            label,
            path: cwd,
        });
        console.log(result.alreadyBound
            ? `Already bound .tim-project → ${result.label} at ${result.projectPath}`
            : `Wrote .tim-project → ${result.label} at ${result.projectPath}`);
    }
    finally {
        store.close();
    }
}
async function cmdHook(args) {
    // Agent CLIs the summarizer runs are hook-registered sessions of their own. Logging
    // their turns would store the summarizer's prompt as a user exchange and spawn a
    // fresh summarizer off it — so every hook no-ops inside the summarizer process tree.
    if ((0, tim_hooks_1.isSummarizerChild)())
        return;
    const sub = args[0];
    if (sub === 'claude-session-start') {
        try {
            const payload = await (0, claude_hook_io_js_1.readJsonStdin)();
            const cwd = typeof payload?.cwd === 'string' ? payload.cwd.trim() : '';
            if (!cwd)
                return;
            // Walk up: Claude reports the workspace root, but sessions often start in a
            // subdirectory of the marked repo.
            const directive = await buildStartDirectiveForCwd(cwd, true);
            if (directive) {
                process.stdout.write(JSON.stringify((0, claude_hook_io_js_1.sessionStartEnvelope)(directive)));
            }
        }
        catch {
            // Claude hooks fail soft: no context, diagnostics, or nonzero exit.
        }
        return;
    }
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
    if (sub === 'claude-session-end') {
        try {
            const payload = await (0, claude_hook_io_js_1.readJsonStdin)();
            if (!payload)
                return;
            const config = (0, tim_core_1.loadConfig)();
            const store = new tim_store_1.TimStore(getDbPath(config));
            try {
                await (0, tim_hooks_1.runHarnessSessionEnd)(store, payload, { hooksConfig: config.hooks });
            }
            finally {
                store.close();
            }
        }
        catch {
            // Claude hooks fail soft: never block the harness on the way out.
        }
        return;
    }
    // One branch for both harnesses: cursor-agent also runs the Stop hook out of
    // ~/.claude/settings.json, so the identity has to come from the payload rather
    // than from which command name was invoked.
    if (sub === 'claude-stop' || sub === 'cursor-stop') {
        try {
            const payload = await (0, claude_hook_io_js_1.readJsonStdin)();
            if (!payload)
                return;
            if (payload.stop_hook_active === true)
                return;
            const sessionId = typeof payload.session_id === 'string' ? payload.session_id.trim() : '';
            const transcriptPath = typeof payload.transcript_path === 'string' ? payload.transcript_path.trim() : '';
            // Cursor payloads carry no cwd — the workspace arrives as workspace_roots.
            const roots = Array.isArray(payload.workspace_roots) ? payload.workspace_roots : [];
            const cwd = typeof payload.cwd === 'string' && payload.cwd.trim()
                ? payload.cwd.trim()
                : typeof roots[0] === 'string' ? roots[0].trim() : '';
            if (!sessionId || !transcriptPath || !cwd)
                return;
            const agent = typeof payload.cursor_version === 'string'
                ? { agentName: 'cursor', harness: 'cursor' }
                : undefined;
            const marker = (0, tim_hooks_1.findMarker)(cwd);
            if (!marker)
                return;
            const config = (0, tim_core_1.loadConfig)();
            const store = new tim_store_1.TimStore(getDbPath(config));
            try {
                const result = await (0, tim_hooks_1.runClaudeStop)(store, {
                    session_id: sessionId,
                    transcript_path: transcriptPath,
                    cwd,
                    stop_hook_active: payload.stop_hook_active === true,
                }, { cwd, agent });
                // This hook is the only writer of exchanges for Claude Code, so it is also the
                // only place that learns a batch just filled. Without this the summarizer is
                // never spawned and every session-summary-root stays empty. The spawn is
                // detached and gated on pending >= batch_size, so most turns do nothing.
                if (result.logged) {
                    await (0, tim_hooks_1.maybeSpawnSummarizer)(store, cwd, { sessionId });
                }
                // Cursor's sessionEnd is the same signal Claude's SessionEnd carries, so
                // it gets the same checkpoint. It rides this command instead of a second
                // hook entry because the checkpoint has to run after the exchange it
                // summarizes — two entries on one event would race, and a checkpoint that
                // loses sees no exchanges and silently skips. Under `cursor-agent -p`
                // sessionEnd is also the only turn-end signal, which is why the exchange
                // is logged above before this runs.
                if (payload.hook_event_name === 'sessionEnd') {
                    await (0, tim_hooks_1.runHarnessSessionEnd)(store, { session_id: sessionId, cwd }, { hooksConfig: config.hooks });
                }
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
    if (sub === 'codex-notify') {
        try {
            const payload = (0, tim_hooks_1.parseCodexNotifyArgs)(args);
            if (!payload)
                return;
            const cwd = typeof payload.cwd === 'string' ? payload.cwd.trim() : '';
            if (!cwd)
                return;
            const marker = (0, tim_hooks_1.findMarker)(cwd);
            if (!marker)
                return;
            const config = (0, tim_core_1.loadConfig)();
            const store = new tim_store_1.TimStore(getDbPath(config));
            try {
                const result = await (0, tim_hooks_1.runCodexNotify)(store, payload, { cwd });
                // Same reason as claude-stop: this is the only writer of Codex exchanges,
                // so it is also the only place that learns a batch just filled.
                if (result.logged) {
                    const sessionId = String(payload['thread-id'] ?? '').trim();
                    if (sessionId)
                        await (0, tim_hooks_1.maybeSpawnSummarizer)(store, cwd, { sessionId });
                }
            }
            finally {
                store.close();
            }
        }
        catch {
            // Codex notify fails soft: never block the harness.
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
                console.error('Usage: tim hook <session-start|session-end|log|prompt-submit|claude-session-start|claude-session-end|claude-stop|cursor-stop|codex-notify> [options]');
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
        const session = await store.read(sessionId);
        const cwd = typeof session?.metadata.cwd === 'string' && session.metadata.cwd.trim()
            ? session.metadata.cwd.trim()
            : process.cwd();
        const summary = await (0, tim_hooks_1.runCheckpointWithSummarizerSpawn)(store, sessionId, cwd, {
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
async function cmdMigrateRetireDeprecatedTags(args) {
    const { flags } = (0, args_js_1.parseArgs)(args, {
        valueOptions: (0, args_js_1.valueOptionsFor)('migrate', 'retire-deprecated-tags'),
    });
    const dryRun = flags['dry-run'] === 'true';
    const sampleLimit = flags['sample-limit'] ? parseInt(flags['sample-limit'], 10) : 20;
    const config = (0, tim_core_1.loadConfig)();
    const store = new tim_store_1.TimStore(getDbPath(config));
    try {
        const report = await (0, tim_migrate_1.migrateRetireDeprecatedTags)(store, { dryRun, sampleLimit });
        console.log(JSON.stringify(report, null, 2));
        if (dryRun) {
            console.error(`\n[tim] migrate retire-deprecated-tags — DRY RUN. ${report.migrated} entries would be cleaned.`);
        }
        else {
            console.error(`\n[tim] migrate retire-deprecated-tags — ${report.migrated} cleaned, ${report.skipped} skipped, ${report.errors.length} errors.`);
        }
    }
    finally {
        store.close();
    }
}
async function cmdReapCheckpoints() {
    const config = (0, tim_core_1.loadConfig)();
    const store = new tim_store_1.TimStore(getDbPath(config));
    try {
        const checkpointsReaped = await new tim_store_1.SessionManager(store).reapCoveredCheckpoints();
        console.log(JSON.stringify({ checkpointsReaped }, null, 2));
        console.error(`\n[tim] reap-checkpoints — ${checkpointsReaped} checkpoint(s) reaped.`);
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
async function cmdMigrateSchema() {
    const config = (0, tim_core_1.loadConfig)();
    const dbPath = getDbPath(config);
    const store = new tim_store_1.TimStore(dbPath, { allowMigrations: true });
    const result = store.lastMigration;
    if (!result) {
        console.log(`Schema already at v${(0, tim_store_1.getCurrentVersion)()}. Nothing to migrate.`);
    }
    else {
        const n = result.applied.length;
        const noun = n === 1 ? 'migration' : 'migrations';
        console.log(`Migrated schema v${result.from} → v${result.to} (${n} ${noun}).`);
        console.log(`Backup: ${result.backupPath ?? '(none)'}`);
    }
    store.close();
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
            await cmdDoctor(rest);
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
        case 'migrate-schema':
            await cmdMigrateSchema();
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
            else if (sub === 'retire-deprecated-tags') {
                await cmdMigrateRetireDeprecatedTags(rest.slice(1));
            }
            else {
                console.error(`Usage: tim migrate <subcommand>\n` +
                    `  tags-to-types           Convert legacy #rule / #human tags to metadata.type [--dry-run] [--sample-limit N]\n` +
                    `  project-kind            Backfill metadata.kind=project on imported P-prefix roots [--dry-run]\n` +
                    `  retire-deprecated-tags  Strip every deprecated tag (structural, status, priority) from existing rows [--dry-run]`);
                process.exit(1);
            }
            break;
        }
        case 'reap-checkpoints':
            await cmdReapCheckpoints();
            break;
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
        case 'viewer':
            await (0, viewer_js_1.cmdViewer)(rest);
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