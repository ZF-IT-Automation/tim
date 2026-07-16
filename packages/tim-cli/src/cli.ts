#!/usr/bin/env node
// TIM CLI — v0.1.0-alpha

import { TimStore, SessionManager, resolveProjectBindingLabel } from 'tim-store';
import { loadConfig, getTimDir, normalizeLegacyTypeTag, type TimConfigFile } from 'tim-core';
import {
  runCheckpoint,
  runSessionEnd,
  runSessionStart,
  findMarker,
  findMarkerOptionsFromEnv,
  buildLoadDirective,
  buildSessionDirective,
  validateMarkerAgainstStore,
  readMarker,
  writeMarker,
  rebalanceBatch,
  afterExchangeLogged,
  runPromptSubmit,
  runClaudeStop,
  type ProjectMarker,
} from 'tim-hooks';
import { buildTimMcpEntry, installMcpEntryForHosts } from './install.js';
import { cmdUserInit, cmdUserProfile, cmdUpdateSkills } from './user.js';
import { tim_export, tim_import, repairImportFlags, repairProjectKind, exportToMarkdown, migrateTagsToTypes } from 'tim-migrate';
import { cmdSync } from './sync-cli.js';
import { cmdSnapshot } from './snapshot.js';
import { cmdRestore } from './restore.js';
import { requiresSnapshot } from './safety.js';
import { runStatusline } from './statusline.js';
import { cmdRecordCommit } from './record-commit.js';
import { cmdNewProject } from './new-project.js';
import {
  auditHermesStatusline,
  cmdSetupHermesStatusline,
} from './hermes-statusline-install.js';
import { cmdConsolidate } from './consolidate.js';
import { cmdSecret } from './secret.js';
import { runReleaseCheck } from './release-check.js';
import { cmdMigrateFromHmem } from './migrate-from-hmem.js';
import { cmdSetupAgent } from './setup-agent.js';
import { NEW_PROJECT_ALIASES, hasBooleanFlag, parseArgs, valueOptionsFor } from './args.js';
import { promptSubmitEnvelope, readJsonStdin } from './claude-hook-io.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

function getDbPath(config: TimConfigFile): string {
  return process.env.TIM_DB_PATH || config.dbPath || path.join(os.homedir(), '.tim', 'tim.db');
}

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function buildStaleMarkerDirective(projectLabel: string, markerDir: string): string {
  return [
    `⚠️ Stale TIM project marker (.tim-project in ${markerDir}): ${projectLabel} does not exist in the configured TIM store.`,
    `ACTION: run tim bind-project --label <P00XX> --cwd "${markerDir}" to repair it, ` +
      `or remove ${path.join(markerDir, '.tim-project')} explicitly.`,
  ].join('\n');
}

const HELP_ALIASES: Readonly<Record<string, string>> = { h: 'help' };

function hasHelpFlag(args: string[], command: string, subcommand?: string): boolean {
  return hasBooleanFlag(args, 'help', {
    valueOptions: valueOptionsFor(command, subcommand),
    aliases: command === 'new-project' ? NEW_PROJECT_ALIASES : HELP_ALIASES,
  });
}

const COMMAND_HELP: Record<string, string> = {
  init: 'Usage: tim init',
  doctor: 'Usage: tim doctor',
  stats: 'Usage: tim stats',
  'resolve-project':
    'Usage: tim resolve-project [--cwd <dir>] [--walk-up] [--format label|json|directive]',
  'resolve-session':
    'Usage: tim resolve-session --session <id> [--cwd <dir>] [--format label|directive|json]',
  'bind-project': 'Usage: tim bind-project --label <P00XX> [--cwd <dir>] [--session <id>]',
  'new-project':
    'Usage: tim new-project --path <dir> --name <string> [--no-git] [--confirm]',
  'record-commit':
    'Usage: tim record-commit [--cwd <dir>] [--project <label>] [--session <id>] [--hash <sha>] [--message <text>] [--diff <stat>] [--author <name>] [--date <iso>] [--branch <name>]',
  hook: 'Usage: tim hook <session-start|session-end|log|prompt-submit|claude-stop> [options]',
  'hook session-start':
    'Usage: tim hook session-start --session <id> [--agent <name>] [--cwd <path>] [--harness <name>] [--project <label>] [--tool <name>] [--model <name>] [--task-summary <text>]',
  'hook session-end': 'Usage: tim hook session-end --session <id>',
  'hook log':
    'Usage: tim hook log --session <id> --user <text> --agent <text> [--cwd <path>]',
  'hook prompt-submit': 'Usage: tim hook prompt-submit < Claude UserPromptSubmit JSON',
  'hook claude-stop': 'Usage: tim hook claude-stop < Claude Stop JSON',
  checkpoint: 'Usage: tim checkpoint --session <id> [--handoff-note <text>]',
  rebalance: 'Usage: tim rebalance --session <id> [--cwd <dir>]',
  statusline:
    'Usage: tim statusline [--cwd <dir>] [--session <id>] [--format text|hermes]',
  'setup-hermes-statusline':
    'Usage: tim setup-hermes-statusline [--dry-run] [--skip-build]',
  export: 'Usage: tim export [path.hmem] [--format hmem|text]',
  import:
    'Usage: tim import <path.hmem> [--dry-run] [--deduplicate] [--repair-flags] [--no-snapshot-check]',
  'migrate-from-hmem':
    'Usage: tim migrate-from-hmem <path.hmem> [--deduplicate] [--no-deduplicate] [--dry-run]',
  migrate: 'Usage: tim migrate <tags-to-types|project-kind> [options]',
  'migrate tags-to-types':
    'Usage: tim migrate tags-to-types [--dry-run] [--sample-limit <count>]',
  'migrate project-kind': 'Usage: tim migrate project-kind [--dry-run]',
  snapshot:
    'Usage: tim snapshot [--db <path>] [--out <path>] [--prune-hours <hours>] [--no-symlink] [--quiet]',
  restore:
    'Usage: tim restore [--from <path>] [--db <path>] [--list] [--dry-run] [--force]',
  'release-check': 'Usage: tim release-check [--beta] [--json] [--skip-tests <true|false>]',
  'setup-agent':
    'Usage: tim setup-agent --host claude|codex|cursor|hermes [--dry-run]',
  sync: 'Usage: tim sync <connect|disconnect|push|pull|status|dev> [options]',
  'sync connect':
    'Usage: tim sync connect [--server-url <url>] [--user-id <id>] [--token <token>] [--passphrase <text>] [--register] [--tier free|pro]',
  'sync disconnect': 'Usage: tim sync disconnect',
  'sync push': 'Usage: tim sync push [--passphrase <text>]',
  'sync pull': 'Usage: tim sync pull [--passphrase <text>]',
  'sync status': 'Usage: tim sync status',
  'sync dev': 'Usage: tim sync dev [--port <number>]',
  'root-entries':
    'Usage: tim root-entries [--type <type>] [--tag <tag>] [--format json|content]',
  consolidate: 'Usage: tim consolidate <find-duplicates|find-decay|run|status> [options]',
  'consolidate find-duplicates':
    'Usage: tim consolidate find-duplicates --project <P00XX> [--threshold <number>]',
  'consolidate find-decay':
    'Usage: tim consolidate find-decay --project <P00XX> [--access-days <days>] [--access-count <count>] [--verified-days <days>]',
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

function printCommandHelp(cmd: string, subcommand?: string): void {
  const normalizedCommand = cmd === '-v' ? '--version' : cmd;
  const subcommandKey =
    subcommand && subcommand !== '-h' && subcommand !== '--help'
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

function printRootHelp(): void {
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
  const timDir = getTimDir();
  const config = loadConfig();
  const dbPath = getDbPath(config);
  const mcpEntry = buildTimMcpEntry(dbPath);

  ensureDir(timDir);
  const store = new TimStore(dbPath);

  try {
    await store.registerAgent('Default Agent', 'default');
    console.log('✓ Agent registered: "default"');
  } catch {}

  const { installed, skipped } = installMcpEntryForHosts(mcpEntry, true);
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
    fs.writeFileSync(
      path.join(timDir, 'mcp.json'),
      JSON.stringify(mcpConfig, null, 2),
    );
    console.log(`✓ MCP config written: ${timDir}/mcp.json`);
  }

  const health = await store.health();
  console.log(`✓ Database created: ${dbPath}`);
  console.log(`✓ Health: ${health.totalEntries} entries, FTS5=${health.ftsIntegrity ? 'OK' : 'BROKEN'}`);
  console.log(`\nTIM ready. Connect your MCP client to ${timDir}/mcp.json`);

  store.close();
}

async function cmdDoctor() {
  const config = loadConfig();
  const store = new TimStore(getDbPath(config));
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
  if (stats.oldestEntry) console.log(`Oldest: ${stats.oldestEntry}`);
  if (stats.newestEntry) console.log(`Newest: ${stats.newestEntry}`);
  console.log(`Stale (>30d): ${stats.staleCount}`);
  if (health.issues.length) {
    console.log('\n⚠ Issues:');
    health.issues.forEach(i => console.log(`  - ${i}`));
  }
  console.log(`\nTop tags: ${stats.topTags.slice(0, 5).map(t => `${t.tag}(${t.count})`).join(', ') || 'none'}`);

  const hermesDir = path.join(os.homedir(), '.hermes');
  if (fs.existsSync(hermesDir)) {
    const { installed, issues } = auditHermesStatusline();
    if (installed) {
      console.log('\nHermes statusline: ✓ installed');
    } else {
      console.log('\nHermes statusline: ✗ not fully installed');
      issues.forEach(i => console.log(`  - ${i}`));
      console.log('  Fix: tim setup-hermes-statusline');
    }
  }

  store.close();
}

async function cmdStats() {
  const config = loadConfig();
  const store = new TimStore(getDbPath(config));
  const stats = await store.stats();
  console.log(JSON.stringify(stats, null, 2));
  store.close();
}

async function cmdResolveProject(args: string[]) {
  const { flags } = parseArgs(args, { valueOptions: valueOptionsFor('resolve-project') });
  const cwd = flags.cwd ?? process.cwd();
  const format = flags.format ?? 'label';

  const envOpts = findMarkerOptionsFromEnv() ?? {};
  const walkUp =
    flags['walk-up'] !== undefined ? flags['walk-up'] === 'true' : (envOpts.walkUp ?? false);
  const located = findMarker(cwd, { ...envOpts, walkUp });
  if (!located) return; // no marker (or corrupt nearest) → silent skip, exit 0

  const { marker, dir } = located;
  if (format === 'json') {
    console.log(JSON.stringify({ ...marker, dir }));
    return;
  }

  const config = loadConfig();
  const store = new TimStore(getDbPath(config));
  try {
    if (format === 'directive') {
      const validated = await validateMarkerAgainstStore(marker, store);
      if (!validated) {
        process.stdout.write(buildStaleMarkerDirective(marker.project, dir));
        return;
      }
      const binding = await resolveProjectBindingLabel(store, marker.project);
      process.stdout.write(buildLoadDirective(marker.project, dir, binding));
    } else {
      process.stdout.write(marker.project);
    }
  } finally {
    store.close();
  }
}

async function cmdResolveSession(args: string[]) {
  const { flags } = parseArgs(args, {
    valueOptions: valueOptionsFor('resolve-session'),
  });
  const sessionId = flags.session?.trim();
  if (!sessionId) {
    console.error('Usage: tim resolve-session --session <id> [--cwd <dir>] [--format label|directive|json]');
    process.exit(1);
  }
  const cwd = flags.cwd ?? process.cwd();
  const format = flags.format ?? 'label';

  const config = loadConfig();
  const store = new TimStore(getDbPath(config));
  try {
    const entry = await store.read(sessionId);
    if (!entry || entry.metadata.kind !== 'session') return;
    const projectRef =
      typeof entry.metadata.project_ref === 'string' ? entry.metadata.project_ref.trim() : '';
    if (!projectRef) return;

    if (format === 'json') {
      console.log(JSON.stringify({ sessionId, project: projectRef, cwd }));
    } else if (format === 'directive') {
      const binding = await resolveProjectBindingLabel(store, projectRef);
      process.stdout.write(buildSessionDirective(projectRef, cwd, binding));
    } else {
      process.stdout.write(projectRef);
    }
  } finally {
    store.close();
  }
}

async function cmdBindProject(args: string[]) {
  const { flags } = parseArgs(args, {
    valueOptions: valueOptionsFor('bind-project'),
  });
  const cwd = flags.cwd ?? process.cwd();
  const label = flags.label;
  if (!label) {
    console.error('Usage: tim bind-project --label <P00XX> [--cwd <dir>] [--session <id>]');
    process.exit(1);
  }
  const existing = readMarker(cwd);
  const marker: ProjectMarker = {
    project: label,
    session: flags.session ?? existing?.session ?? '',
    exchanges: existing?.exchanges ?? 0,
    batch_size: existing?.batch_size ?? 5,
    batches_summarized: existing?.batches_summarized ?? 0,
    version: 2,
  };
  writeMarker(cwd, marker);
  console.log(`Wrote .tim-project → ${label} at ${cwd}`);
}

async function cmdHook(args: string[]) {
  const sub = args[0];

  if (sub === 'prompt-submit') {
    try {
      const payload = await readJsonStdin();
      const prompt = typeof payload?.prompt === 'string' ? payload.prompt : '';
      const cwd = typeof payload?.cwd === 'string' ? payload.cwd : '';
      if (!prompt.trim() || !cwd.trim()) return;

      const config = loadConfig();
      if (config.hooks?.promptSubmit?.enabled === false) return;

      const store = new TimStore(getDbPath(config));
      let context: string | null = null;
      try {
        const marker = findMarker(cwd);
        const result = await runPromptSubmit(store, {
          prompt,
          projectLabel: marker?.marker.project,
        });
        context = result?.context ?? null;
      } finally {
        store.close();
      }

      if (context) {
        process.stdout.write(JSON.stringify(promptSubmitEnvelope(context)));
      }
    } catch {
      // Claude hooks fail soft: no context, diagnostics, or nonzero exit.
    }
    return;
  }

  if (sub === 'claude-stop') {
    try {
      const payload = await readJsonStdin();
      if (!payload) return;
      if (payload.stop_hook_active === true) return;

      const sessionId = typeof payload.session_id === 'string' ? payload.session_id : '';
      const transcriptPath =
        typeof payload.transcript_path === 'string' ? payload.transcript_path : '';
      const cwd = typeof payload.cwd === 'string' ? payload.cwd : '';
      if (!sessionId.trim() || !transcriptPath.trim() || !cwd.trim()) return;

      const marker = findMarker(cwd);
      if (!marker) return;

      const config = loadConfig();
      const store = new TimStore(getDbPath(config));
      try {
        await runClaudeStop(
          store,
          {
            session_id: sessionId,
            transcript_path: transcriptPath,
            cwd,
            stop_hook_active: payload.stop_hook_active === true,
          },
          { cwd },
        );
      } finally {
        store.close();
      }
    } catch {
      // Claude Stop hooks fail soft: never block the harness.
    }
    return;
  }

  const { flags } = parseArgs(args.slice(1), {
    valueOptions: valueOptionsFor('hook', sub),
  });
  const config = loadConfig();
  const store = new TimStore(getDbPath(config));

  try {
    switch (sub) {
      case 'session-start': {
        const sessionId = flags.session;
        const agentName = flags.agent ?? 'default';
        const cwd = flags.cwd ?? process.cwd();
        const harness = flags.harness ?? 'unknown';
        const projectId = flags.project;  // optional, auto-resolved from .tim-project
        const tool = flags.tool;
        const model = flags.model;
        const taskSummary = flags['task-summary'];

        if (!sessionId) {
          console.error('Usage: tim hook session-start --session <id> [--agent <name>] [--cwd <path>] [--harness <h>] [--project <label>] [--tool <name>] [--model <name>]');
          process.exit(1);
        }

        const result = await runSessionStart(store, {
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

        const summary = await runSessionEnd(store, sessionId, {
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
        const sessions = new SessionManager(store);
        const entries = await sessions.logExchange(sessionId, [
          { role: 'user', content: userText },
          { role: 'agent', content: agentText },
        ]);
        const cadence = await afterExchangeLogged(store, sessionId, flags.cwd || process.cwd());
        console.log(JSON.stringify({ count: entries.length, cadence }, null, 2));
        break;
      }

      default:
        console.error(`Unknown hook: ${sub ?? '(none)'}`);
        console.error('Usage: tim hook <session-start|session-end|log|prompt-submit|claude-stop> [options]');
        process.exit(1);
    }
  } finally {
    store.close();
  }
}

async function cmdRebalance(args: string[]) {
  const { flags } = parseArgs(args, { valueOptions: valueOptionsFor('rebalance') });
  const sessionId = flags.session;

  if (!sessionId) {
    console.error('Usage: tim rebalance --session <id>');
    process.exit(1);
  }

  const config = loadConfig();
  const store = new TimStore(getDbPath(config));

  try {
    const result = await rebalanceBatch(store, sessionId, {
      cwd: flags.cwd || process.cwd(),
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    store.close();
  }
}

async function cmdCheckpoint(args: string[]) {
  const { flags } = parseArgs(args, {
    valueOptions: valueOptionsFor('checkpoint'),
  });
  const sessionId = flags.session;

  if (!sessionId) {
    console.error('Usage: tim checkpoint --session <id>');
    process.exit(1);
  }

  const config = loadConfig();
  const store = new TimStore(getDbPath(config));

  try {
    const summary = await runCheckpoint(store, sessionId, {
      handoffNote: flags['handoff-note'],
    });
    console.log(JSON.stringify({ summary }, null, 2));
  } finally {
    store.close();
  }
}

async function cmdExport(args: string[]) {
  const { flags, positional } = parseArgs(args, { valueOptions: valueOptionsFor('export') });
  const targetPath = positional[0];
  const format = flags.format === 'text' ? 'text' : 'hmem';

  const config = loadConfig();
  const store = new TimStore(getDbPath(config));

  try {
    if (format === 'text') {
      const md = exportToMarkdown(store);
      process.stdout.write(md);
      return;
    }

    if (!targetPath) {
      console.error('Usage: tim export <path.hmem> [--format hmem|text]');
      process.exit(1);
    }

    const result = tim_export(store, targetPath, { format: 'hmem' });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    store.close();
  }
}

async function cmdImport(args: string[]) {
  const { flags, positional } = parseArgs(args);
  const sourcePath = positional[0];

  if (!sourcePath) {
    console.error(
      'Usage: tim import <path.hmem> [--dry-run] [--deduplicate] [--repair-flags] [--no-snapshot-check]',
    );
    process.exit(1);
  }

  if (
    requiresSnapshot(flags['repair-flags'] === 'true' ? 'repair-flags' : 'import', flags) &&
    flags['no-snapshot-check'] !== 'true'
  ) {
    console.error(
      'Refusing live import without snapshot acknowledgement. Run `tim snapshot` first or pass --no-snapshot-check.',
    );
    process.exit(1);
  }

  const config = loadConfig();
  const store = new TimStore(getDbPath(config));

  try {
    if (flags['repair-flags'] === 'true') {
      const report = repairImportFlags(store, sourcePath, {
        dryRun: flags['dry-run'] === 'true',
      });
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    const report = tim_import(store, sourcePath, {
      dryRun: flags['dry-run'] === 'true',
      deduplicate: flags.deduplicate === 'true',
    });
    console.log(JSON.stringify(report, null, 2));
  } finally {
    store.close();
  }
}

async function cmdMigrateTagsToTypes(args: string[]) {
  const { flags } = parseArgs(args, {
    valueOptions: valueOptionsFor('migrate', 'tags-to-types'),
  });
  const dryRun = flags['dry-run'] === 'true';
  const sampleLimit = flags['sample-limit'] ? parseInt(flags['sample-limit'], 10) : 20;

  const config = loadConfig();
  const store = new TimStore(getDbPath(config));

  try {
    const report = await migrateTagsToTypes(store, { dryRun, sampleLimit });
    console.log(JSON.stringify(report, null, 2));
    if (dryRun) {
      console.error(
        `\n[tim] migrate tags-to-types — DRY RUN. ${report.migrated} entries would be migrated.`,
      );
    } else {
      console.error(
        `\n[tim] migrate tags-to-types — ${report.migrated} migrated, ${report.skipped} skipped, ${report.errors.length} errors.`,
      );
    }
  } finally {
    store.close();
  }
}

async function cmdMigrateProjectKind(args: string[]) {
  const { flags } = parseArgs(args);
  const dryRun = flags['dry-run'] === 'true';

  const config = loadConfig();
  const store = new TimStore(getDbPath(config));

  try {
    const report = repairProjectKind(store, { dryRun });
    console.log(JSON.stringify(report, null, 2));
    if (dryRun) {
      console.error(
        `\n[tim] migrate project-kind — DRY RUN. ${report.repaired} of ${report.matched} P-roots would be repaired.`,
      );
    } else {
      console.error(
        `\n[tim] migrate project-kind — ${report.repaired} of ${report.matched} P-roots repaired.`,
      );
    }
  } finally {
    store.close();
  }
}

async function cmdRootEntries(args: string[]) {
  const { flags } = parseArgs(args, {
    valueOptions: valueOptionsFor('root-entries'),
  });
  const type = flags.type;
  const tag = flags.tag;

  // Backward-compat: --tag '#rule' still works (Phase 0 keeps the alias
  // for hooks and external scripts). When --tag is the only filter, log
  // a deprecation warning and route to the type-based query path.
  let resolvedType: string | undefined;
  let resolvedTag: string | undefined;
  if (type) {
    resolvedType = type;
    if (tag) {
      // Both flags → type wins, warn about the conflict.
      console.error(
        `[tim] root-entries: --type and --tag both passed; --type (${type}) takes precedence.`,
      );
    }
  } else if (tag) {
    const normalized = normalizeLegacyTypeTag(tag);
    if (normalized) {
      console.error(
        `[tim] root-entries: --tag '${tag}' is deprecated; use --type ${normalized} instead.`,
      );
      resolvedType = normalized;
    } else {
      // Not a known type tag → fall back to legacy JSON-LIKE matching
      // so external scripts that pass arbitrary tags keep working.
      console.error(
        `[tim] root-entries: --tag '${tag}' is deprecated and not a known metadata type. ` +
          `Falling back to legacy tag-LIKE match.`,
      );
      resolvedTag = tag;
    }
  }

  const config = loadConfig();
  const store = new TimStore(getDbPath(config));

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
  } finally {
    store.close();
  }
}

async function cmdReleaseCheck(args: string[]) {
  const { flags } = parseArgs(args, { valueOptions: valueOptionsFor('release-check') });
  const summary = await runReleaseCheck({
    beta: flags.beta === 'true',
    skipTests: flags['skip-tests'] === 'true',
  });

  if (flags.json === 'true') {
    console.log(JSON.stringify(summary, null, 2));
  } else {
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
      await cmdNewProject(rest);
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
    case 'statusline': {
      const { flags } = parseArgs(rest, {
        valueOptions: valueOptionsFor('statusline'),
      });
      await runStatusline({
        cwd: flags.cwd,
        sessionId: flags.session,
        format: flags.format === 'hermes' ? 'hermes' : 'text',
      });
      break;
    }
    case 'setup-hermes-statusline':
      await cmdSetupHermesStatusline(rest);
      break;
    case 'export':
      await cmdExport(rest);
      break;
    case 'import':
      await cmdImport(rest);
      break;
    case 'migrate-from-hmem':
      await cmdMigrateFromHmem(rest);
      break;
    case 'migrate': {
      // Subcommand dispatch: `tim migrate <sub> [args...]`
      const sub = rest[0];
      if (sub === 'tags-to-types') {
        await cmdMigrateTagsToTypes(rest.slice(1));
      } else if (sub === 'project-kind') {
        await cmdMigrateProjectKind(rest.slice(1));
      } else {
        console.error(
          `Usage: tim migrate <subcommand>\n` +
            `  tags-to-types   Convert legacy #rule / #human tags to metadata.type [--dry-run] [--sample-limit N]\n` +
            `  project-kind    Backfill metadata.kind=project on imported P-prefix roots [--dry-run]`,
        );
        process.exit(1);
      }
      break;
    }
    case 'snapshot':
      await cmdSnapshot(rest);
      break;
    case 'restore':
      await cmdRestore(rest);
      break;
    case 'release-check':
      await cmdReleaseCheck(rest);
      break;
    case 'setup-agent':
      await cmdSetupAgent(rest);
      break;
    case 'sync': {
      const sub = rest[0];
      await cmdSync(sub, rest.slice(1));
      break;
    }
    case 'root-entries':
      await cmdRootEntries(rest);
      break;
    case 'consolidate':
      await cmdConsolidate(rest);
      break;
    case 'secret':
      await cmdSecret(rest);
      break;
    case 'user': {
      const sub = rest[0];
      if (sub === 'init') await cmdUserInit();
      else if (sub === 'profile') await cmdUserProfile();
      else {
        console.error('Usage: tim user <init|profile>');
        process.exit(1);
      }
      break;
    }
    case 'update-skills':
      await cmdUpdateSkills();
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
