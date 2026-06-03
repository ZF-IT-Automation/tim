#!/usr/bin/env node
// TIM CLI — v0.1.0-alpha

import { TimStore, SessionManager, resolveProjectBindingLabel } from 'tim-store';
import { loadConfig, getTimDir, type TimConfigFile } from 'tim-core';
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
  type ProjectMarker,
} from 'tim-hooks';
import { tim_export, tim_import, exportToMarkdown } from 'tim-migrate';
import { cmdSync } from './sync-cli.js';
import { runStatusline } from './statusline.js';
import { cmdRecordCommit } from './record-commit.js';
import {
  auditHermesStatusline,
  cmdSetupHermesStatusline,
} from './hermes-statusline-install.js';
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
    JSON.stringify(mcpConfig, null, 2)
  );

  const health = await store.health();
  console.log(`✓ Database created: ${dbPath}`);
  console.log(`✓ MCP config written: ${timDir}/mcp.json`);
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

  const located = findMarker(cwd, findMarkerOptionsFromEnv());
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
        console.log(JSON.stringify({ count: entries.length }, null, 2));
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
    const summary = await runCheckpoint(store, sessionId);
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
    console.error('Usage: tim import <path.hmem> [--dry-run] [--deduplicate]');
    process.exit(1);
  }

  const config = loadConfig();
  const store = new TimStore(getDbPath(config));

  try {
    const report = tim_import(store, sourcePath, {
      dryRun: flags['dry-run'] === 'true',
      deduplicate: flags.deduplicate === 'true',
    });
    console.log(JSON.stringify(report, null, 2));
  } finally {
    store.close();
  }
}

async function cmdRootEntries(args: string[]) {
  const flags = parseArgs(args);
  const tag = flags.tag;

  const config = loadConfig();
  const store = new TimStore(getDbPath(config));

  try {
    const entries = store.getRootLevelEntries(tag);
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
      await cmdExport(rest);
      break;
    case 'import':
      await cmdImport(rest);
      break;
    case 'sync': {
      const sub = rest[0];
      await cmdSync(sub, rest.slice(1));
      break;
    }
    case 'root-entries':
      await cmdRootEntries(rest);
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
  resolve-project       Print bound project from nearest .tim-project (--cwd, --format label|json|directive)
  resolve-session       Print project_ref for a TIM session (--session, --format label|directive|json)
  bind-project          Write/refresh .tim-project for a project (--label, --cwd, --session)
  record-commit         Record git commit to project Commits section (--cwd, --hash, --message, --diff)
  hook session-start    Start a session (--session, --agent, --cwd, --harness)
  hook session-end      End a session and run checkpoint (--session)
  checkpoint            Manual checkpoint for a session (--session)
  rebalance             Rebalance exchange batches at boundaries (--session, --cwd)
  statusline            Status text or Hermes JSON (--cwd, --session, --format text|hermes)
  setup-hermes-statusline  Install Hermes TUI status bar (symlinks, config, cli patch) [--dry-run] [--skip-build]
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
