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
  readMarker,
  writeMarker,
  rebalanceBatch,
  afterExchangeLogged,
  type ProjectMarker,
} from 'tim-hooks';
import { installMcpForHosts } from './install.js';
import { cmdUserInit, cmdUserProfile, cmdUpdateSkills } from './user.js';
import { tim_export, tim_import, repairImportFlags, exportToMarkdown, migrateTagsToTypes } from 'tim-migrate';
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

function parseArgs(args: string[]): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        parsed[key] = next;
        i++;
      } else {
        parsed[key] = 'true';
      }
    }
  }
  return parsed;
}

function hasHelpFlag(args: string[]): boolean {
  return args.some(arg => arg === '-h' || arg === '--help');
}

function printCommandHelp(cmd: string): void {
  switch (cmd) {
    case 'init':
      console.log(`Usage: tim init`);
      return;
    case 'doctor':
      console.log(`Usage: tim doctor`);
      return;
    case 'stats':
      console.log(`Usage: tim stats`);
      return;
    case 'export':
      console.log(`Usage: tim export <path.hmem> [--format hmem|text]`);
      return;
    case 'import':
      console.log(
        `Usage: tim import <path.hmem> [--dry-run] [--deduplicate] [--repair-flags] [--no-snapshot-check]`,
      );
      return;
    case 'migrate-from-hmem':
      console.log(`Usage: tim migrate-from-hmem <path.hmem> [--deduplicate] [--no-deduplicate] [--dry-run]`);
      return;
    case 'record-commit':
      console.log(`Usage: tim record-commit --cwd <dir> --hash <sha> --message <msg> [--diff <path>]`);
      return;
    case 'checkpoint':
      console.log(`Usage: tim checkpoint --session <id>`);
      return;
    case 'rebalance':
      console.log(`Usage: tim rebalance --session <id>`);
      return;
    case 'statusline':
      console.log(`Usage: tim statusline [--cwd <dir>] [--session <id>] [--format text|hermes]`);
      return;
    case 'snapshot':
      console.log(`Usage: tim snapshot`);
      return;
    case 'restore':
      console.log(`Usage: tim restore [--from <path>] [--list] [--dry-run] [--force]`);
      return;
    case 'release-check':
      console.log(`Usage: tim release-check [--beta] [--json]`);
      return;
    case 'root-entries':
      console.log(`Usage: tim root-entries [--type <type>] [--tag <tag>] [--format json|content]`);
      return;
    default:
      return;
  }
}

async function cmdInit() {
  const timDir = getTimDir();
  ensureDir(timDir);

  const config = loadConfig();
  const dbPath = getDbPath(config);
  const store = new TimStore(dbPath);

  try {
    await store.registerAgent('Default Agent', 'default');
    console.log('✓ Agent registered: "default"');
  } catch {}

  const { installed, skipped } = installMcpForHosts(dbPath, true);
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
        tim: {
          command: 'npx',
          args: ['tim-mcp'],
          env: { TIM_DB_PATH: dbPath },
        },
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
  const flags = parseArgs(args);
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
  const flags = parseArgs(args);
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
  const flags = parseArgs(args);
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
  const flags = parseArgs(args.slice(1));
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
        console.error('Usage: tim hook <session-start|session-end|log> [options]');
        process.exit(1);
    }
  } finally {
    store.close();
  }
}

async function cmdRebalance(args: string[]) {
  const flags = parseArgs(args);
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
  const flags = parseArgs(args);
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
  const flags = parseArgs(args);
  const positional = args.filter(a => !a.startsWith('--'));
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
  const flags = parseArgs(args);
  const positional = args.filter(a => !a.startsWith('--'));
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
  const flags = parseArgs(args);
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

async function cmdRootEntries(args: string[]) {
  const flags = parseArgs(args);
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
  const flags = parseArgs(args);
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

  switch (cmd) {
    case 'init':
      if (hasHelpFlag(rest)) {
        printCommandHelp(cmd);
        break;
      }
      await cmdInit();
      break;
    case 'doctor':
      if (hasHelpFlag(rest)) {
        printCommandHelp(cmd);
        break;
      }
      await cmdDoctor();
      break;
    case 'stats':
      if (hasHelpFlag(rest)) {
        printCommandHelp(cmd);
        break;
      }
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
      if (hasHelpFlag(rest)) {
        printCommandHelp(cmd);
        break;
      }
      await cmdRecordCommit(rest);
      break;
    case 'hook':
      await cmdHook(rest);
      break;
    case 'checkpoint':
      if (hasHelpFlag(rest)) {
        printCommandHelp(cmd);
        break;
      }
      await cmdCheckpoint(rest);
      break;
    case 'rebalance':
      if (hasHelpFlag(rest)) {
        printCommandHelp(cmd);
        break;
      }
      await cmdRebalance(rest);
      break;
    case 'statusline': {
      const flags = parseArgs(rest);
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
      if (hasHelpFlag(rest)) {
        printCommandHelp(cmd);
        break;
      }
      await cmdExport(rest);
      break;
    case 'import':
      if (hasHelpFlag(rest)) {
        printCommandHelp(cmd);
        break;
      }
      await cmdImport(rest);
      break;
    case 'migrate-from-hmem':
      if (hasHelpFlag(rest)) {
        printCommandHelp(cmd);
        break;
      }
      await cmdMigrateFromHmem(rest);
      break;
    case 'migrate': {
      // Subcommand dispatch: `tim migrate <sub> [args...]`
      const sub = rest[0];
      if (sub === 'tags-to-types') {
        await cmdMigrateTagsToTypes(rest.slice(1));
      } else {
        console.error(
          `Usage: tim migrate <subcommand>\n` +
            `  tags-to-types   Convert legacy #rule / #human tags to metadata.type [--dry-run] [--sample-limit N]`,
        );
        process.exit(1);
      }
      break;
    }
    case 'snapshot':
      if (hasHelpFlag(rest)) {
        printCommandHelp(cmd);
        break;
      }
      await cmdSnapshot(rest);
      break;
    case 'restore':
      if (hasHelpFlag(rest)) {
        printCommandHelp(cmd);
        break;
      }
      await cmdRestore(rest);
      break;
    case 'release-check':
      if (hasHelpFlag(rest)) {
        printCommandHelp(cmd);
        break;
      }
      await cmdReleaseCheck(rest);
      break;
    case 'sync': {
      const sub = rest[0];
      await cmdSync(sub, rest.slice(1));
      break;
    }
    case 'root-entries':
      if (hasHelpFlag(rest)) {
        printCommandHelp(cmd);
        break;
      }
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
  migrate-from-hmem <path> Guided hmem→TIM migration with dry-run, snapshot, import, audit handoff
  migrate tags-to-types   Convert legacy #rule / #human tags to metadata.type (--dry-run, --sample-limit N)
  snapshot                 Snapshot the live TIM DB to /tmp/tim-snapshots/ (SQLite backup API)
  restore                  Restore TIM DB from a snapshot (--from, --list, --dry-run, --force)
  release-check           Verify release gates and smoke checks (--beta, --json, --skip-tests true)
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
