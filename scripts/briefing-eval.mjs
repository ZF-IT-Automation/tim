#!/usr/bin/env node
/**
 * Briefing scorecard harness — scores rendered session-start texts against GOALS.md.
 *
 * Usage:
 *   node scripts/briefing-eval.mjs --db <path> --project <label> [--dist <repo-root>] [--json] [--out <dir>]
 */

import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateAll, formatScorecard, formatProjectSummaryLine } from './briefing-eval-goals.mjs';

const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DIST = resolve(__dirname, '..');

class McpStdioClient {
  constructor({ serverPath, cwd, env, timeoutMs = 120_000 }) {
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
    this.ready = false;
    this.proc = spawn('node', [serverPath], {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc.stdout.on('data', (chunk) => this.onData(chunk.toString('utf8')));
    this.proc.stderr.on('data', () => {});
    this.proc.on('exit', () => {
      for (const [, reject] of this.pending) reject(new Error('MCP server exited'));
      this.pending.clear();
    });
  }

  onData(text) {
    this.buffer += text;
    let nl;
    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id != null && this.pending.has(msg.id)) {
          this.pending.get(msg.id)(msg);
          this.pending.delete(msg.id);
        }
      } catch {
        // ignore non-JSON noise
      }
    }
  }

  send(method, params) {
    const id = this.nextId++;
    const frame = `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout waiting for ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, (resp) => {
        clearTimeout(timer);
        resolve(resp);
      });
      this.proc.stdin.write(frame);
    });
  }

  async init() {
    if (this.ready) return;
    await this.send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'briefing-eval', version: '1.0.0' },
    });
    this.proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    this.ready = true;
  }

  async callTool(name, args = {}) {
    await this.init();
    const resp = await this.send('tools/call', { name, arguments: args });
    if (resp.error) throw new Error(resp.error.message ?? `tool ${name} failed`);
    const text = resp.result?.content?.find((c) => c.type === 'text')?.text ?? '';
    if (resp.result?.isError) throw new Error(text || `tool ${name} returned isError`);
    return text;
  }

  close() {
    this.proc.kill('SIGTERM');
  }
}

function parseArgs(argv) {
  const out = {
    db: null,
    project: null,
    dist: DEFAULT_DIST,
    json: false,
    out: null,
    selftest: false,
    allActive: false,
    days: 30,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--db') out.db = argv[++i];
    else if (a === '--project') out.project = argv[++i];
    else if (a === '--dist') out.dist = resolve(argv[++i]);
    else if (a === '--json') out.json = true;
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--selftest') out.selftest = true;
    else if (a === '--all-active') out.allActive = true;
    else if (a === '--days') out.days = Number(argv[++i]);
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function usage() {
  console.error(
    `Usage: node scripts/briefing-eval.mjs --db <path> --project <label> [--dist <repo-root>] [--json] [--out <dir>]\n` +
      `       node scripts/briefing-eval.mjs --db <path> --all-active [--days 30] [--dist <repo-root>]`,
  );
}

function copyDbToTemp(srcDb) {
  const dir = mkdtempSync(join(tmpdir(), 'briefing-eval-'));
  const dest = join(dir, 'tim.db');
  copyFileSync(srcDb, dest);
  if (existsSync(`${srcDb}-wal`)) copyFileSync(`${srcDb}-wal`, `${dest}-wal`);
  if (existsSync(`${srcDb}-shm`)) copyFileSync(`${srcDb}-shm`, `${dest}-shm`);
  return { dir, dbPath: dest };
}

function migrateTempDb(dist, dbPath, home) {
  const cli = join(dist, 'packages/tim-cli/dist/cli.js');
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    TIM_DB_PATH: dbPath,
    TIM_EMBEDDING_DISABLED: '1',
    HERMES_SKIP_DB_GUARD: '1',
  };
  const r = spawnSync(process.execPath, [cli, 'migrate-schema'], { env, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`migrate-schema failed: ${r.stderr || r.stdout}`);
  }
}

function cleanEnv(home, dbPath) {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: home,
    TIM_DB_PATH: dbPath,
    TIM_EMBEDDING_DISABLED: '1',
    HERMES_SKIP_DB_GUARD: '1',
    // Keep env minimal — no user TIM config leakage
    LANG: process.env.LANG ?? 'C.UTF-8',
  };
}

function toolTextFromResponse(text) {
  return text;
}

async function captureTexts({ dist, dbPath, home, project }) {
  const serverPath = join(dist, 'packages/tim-mcp/dist/server.js');
  const cliPath = join(dist, 'packages/tim-cli/dist/cli.js');
  if (!existsSync(serverPath)) {
    throw new Error(`MCP server not built at ${serverPath} — run npm run build in ${dist}`);
  }
  const env = cleanEnv(home, dbPath);
  // Each project gets its own marker dir; a fixed cwd rendered P0063's hook for every project.
  const HOOK_CWD = join(home, 'work', project);
  mkdirSync(HOOK_CWD, { recursive: true });
  writeFileSync(join(HOOK_CWD, '.tim-project'), JSON.stringify({ version: 3, project }));
  const client = new McpStdioClient({ serverPath, cwd: HOOK_CWD, env });

  try {
    const previewText = await client.callTool('tim_preview_briefing', {
      project,
      cwd: HOOK_CWD,
    });
    const loadText = await client.callTool('tim_load_project', {
      label: project,
      bind: false,
      cwd: HOOK_CWD,
    });
    const structureRaw = await client.callTool('tim_project_structure', { label: project });
    const structure = JSON.parse(structureRaw);

    const hookInput = JSON.stringify({
      cwd: HOOK_CWD,
      session_id: `briefing-eval-${Date.now()}`,
    });
    const hookRun = spawnSync(process.execPath, [cliPath, 'hook', 'claude-session-start'], {
      cwd: HOOK_CWD,
      input: hookInput,
      encoding: 'utf8',
      env,
    });
    let hookText = '';
    if (hookRun.stdout?.trim()) {
      try {
        const envelope = JSON.parse(hookRun.stdout);
        hookText = envelope?.hookSpecificOutput?.additionalContext ?? hookRun.stdout;
      } catch {
        hookText = hookRun.stdout;
      }
    }

    return {
      previewText: toolTextFromResponse(previewText),
      loadText: toolTextFromResponse(loadText),
      structure,
      hookText,
    };
  } finally {
    client.close();
  }
}

/** Read-only DB context for goals that need live data beyond rendered text. */
function parseMeta(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  return JSON.parse(raw);
}

function normalizeTitle(s) {
  return s
    .normalize('NFKC')
    .replace(/\u2013|\u2014/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

const SUBSTANTIVE_MIN_EXCHANGES = 3;

function parseSessionSubstance(raw) {
  if (raw === 'none' || raw === 'low' || raw === 'real') return raw;
  return undefined;
}

function isSubstantiveSession(exchangeCount, hasHandoffNote, substance) {
  if (hasHandoffNote) return true;
  if (substance === 'none') return false;
  if (substance === 'real') return true;
  return exchangeCount >= SUBSTANTIVE_MIN_EXCHANGES;
}

function sessionHasHandoffNote(db, sessionId) {
  const row = db.prepare(`
    SELECT 1
    FROM entries
    WHERE parent_id IN (
      SELECT id FROM entries
      WHERE parent_id = ? AND json_extract(metadata, '$.kind') = 'session-summary-root'
    )
    AND json_extract(metadata, '$.handoff_note') IS NOT NULL
    LIMIT 1
  `).get(sessionId);
  return Boolean(row);
}

/** Same SQL as TimStore.getProjectEntryStats (packages/tim-store/src/store.ts). */
function projectLastActivity(db, projectId) {
  const row = db.prepare(`
    WITH RECURSIVE descendants AS (
      SELECT id, created_at FROM entries
      WHERE parent_id = ?
        AND tombstoned_at IS NULL
        AND irrelevant = 0
      UNION ALL
      SELECT e.id, e.created_at FROM entries e
      INNER JOIN descendants d ON e.parent_id = d.id
      WHERE e.tombstoned_at IS NULL AND e.irrelevant = 0
    )
    SELECT MAX(created_at) AS last FROM descendants
  `).get(projectId);
  return row?.last ?? null;
}

/** Mirror TimStore.resolveProjectLabel + read(label) — ignore non-project rows sharing a label. */
function resolveProjectRow(db, projectLabel) {
  const q = projectLabel.trim();
  const roots = db.prepare(`
    SELECT id, updated_at, content, metadata, created_at
    FROM entries
    WHERE tombstoned_at IS NULL
      AND irrelevant = 0
      AND json_extract(metadata, '$.kind') = 'project'
      AND json_extract(metadata, '$.label') = ?
    ORDER BY created_at ASC
  `).all(q);
  if (roots.length === 1) return roots[0];
  const byId = db.prepare(`
    SELECT id, updated_at, content, metadata, created_at
    FROM entries
    WHERE tombstoned_at IS NULL
      AND irrelevant = 0
      AND id = ?
      AND json_extract(metadata, '$.kind') = 'project'
  `).get(q);
  if (byId) return byId;
  if (roots.length > 1) {
    throw new Error(`Ambiguous project label ${q}: ${roots.map((r) => r.id).join(', ')}`);
  }
  return null;
}

function listActiveProjects(db, days) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cutoffIso = cutoff.toISOString();
  const projects = db.prepare(`
    SELECT id, json_extract(metadata, '$.label') AS label
    FROM entries
    WHERE tombstoned_at IS NULL
      AND json_extract(metadata, '$.kind') = 'project'
      AND json_extract(metadata, '$.label') IS NOT NULL
    ORDER BY label
  `).all();
  const active = [];
  for (const p of projects) {
    const last = projectLastActivity(db, p.id);
    if (last && last >= cutoffIso) {
      active.push({ id: p.id, label: p.label });
    }
  }
  return active;
}

function loadDbContext(dbPath, projectLabel) {
  const db = new Database(dbPath, { readonly: true });

  const project = resolveProjectRow(db, projectLabel);
  if (!project) {
    db.close();
    throw new Error(`Project not found in DB: ${projectLabel}`);
  }

  // Match renderer: getProjectEntryStats uses MAX(created_at), not updated_at.
  const lastActivity = projectLastActivity(db, project.id);

  // Live test count heuristic from project content "(N tests)" or "N tests".
  const testsMatch =
    project.content?.match(/\((\d+)\s+tests?\)/i) ??
    project.content?.match(/\b(\d+)\s+tests?\b/i);
  const liveTestCount = testsMatch ? Number(testsMatch[1]) : null;

  // Session nodes under sessions-root (newest activity first).
  const sessions = db.prepare(`
    SELECT s.id, s.created_at, s.updated_at, s.metadata, s.content, s.title
    FROM entries s
    JOIN entries sr ON s.parent_id = sr.id
    WHERE sr.parent_id = ?
      AND json_extract(sr.metadata, '$.kind') = 'sessions-root'
      AND json_extract(s.metadata, '$.kind') = 'session'
      AND s.tombstoned_at IS NULL
    ORDER BY COALESCE(json_extract(s.metadata, '$.date'), s.created_at) DESC
  `).all(project.id);

  const newest = sessions[0];
  const newestMeta = newest ? parseMeta(newest.metadata) : {};
  const newestSessionDate = newest
    ? String(newestMeta.date ?? newest.created_at)
    : null;
  const newestSessionId = newest?.id ?? null;
  const newestSessionExchangeCount = Number(
    newestMeta.exchange_count ?? newestMeta.exchanges ?? 0,
  );
  const newestSessionHasHandoff = newest ? sessionHasHandoffNote(db, newest.id) : false;

  // Substantive predicate matches product (handoff / substance real / ≥3 exchanges).
  let newestSubstantiveSession = null;
  let newestSubstantiveSessionDate = null;
  // G4: Recent Sessions is ordered by activity, so recency = a substantive session's last exchange.
  let newestSubstantiveActivityDate = null;
  const lastExchangeStmt = db.prepare(`
    WITH RECURSIVE sub AS (
      SELECT id, created_at, metadata FROM entries WHERE parent_id = ? AND tombstoned_at IS NULL
      UNION ALL
      SELECT e.id, e.created_at, e.metadata FROM entries e
      INNER JOIN sub ON e.parent_id = sub.id WHERE e.tombstoned_at IS NULL
    )
    SELECT MAX(created_at) AS last FROM sub
    WHERE json_extract(metadata, '$.kind') = 'exchange'
      OR (json_extract(metadata, '$.kind') = 'checkpoint'
        AND json_extract((SELECT p.metadata FROM entries p WHERE p.id =
          (SELECT parent_id FROM entries c WHERE c.id = sub.id)), '$.handoff_note') IS NOT NULL)
  `);
  for (const s of sessions) {
    const meta = parseMeta(s.metadata);
    const exchanges = Number(meta.exchange_count ?? meta.exchanges ?? 0);
    const hasHandoff = sessionHasHandoffNote(db, s.id);
    const summaryRoot = db.prepare(`
      SELECT metadata
      FROM entries
      WHERE parent_id = ? AND json_extract(metadata, '$.kind') = 'session-summary-root'
      LIMIT 1
    `).get(s.id);
    const substance = parseSessionSubstance(
      summaryRoot ? parseMeta(summaryRoot.metadata).substance : undefined,
    );
    if (isSubstantiveSession(exchanges, hasHandoff, substance)) {
      const date = String(meta.date ?? s.created_at).slice(0, 10);
      const active = (lastExchangeStmt.get(s.id)?.last ?? date).slice(0, 10);
      if (!newestSubstantiveActivityDate || active > newestSubstantiveActivityDate) {
        newestSubstantiveActivityDate = active;
      }
      if (newestSubstantiveSession) continue;
      newestSubstantiveSessionDate = date;
      newestSubstantiveSession = {
        sessionId: s.id,
        label: date,
        summarySnippet: s.title ?? s.content?.slice(0, 80),
      };
      continue;
    }
  }

  // Handoff notes in last 30 days (metadata.handoff_note on summary-root descendants).
  const handoffRow = db.prepare(`
    SELECT json_extract(e.metadata, '$.handoff_note') AS note, e.updated_at
    FROM entries e
    JOIN entries s ON s.id = e.parent_id
    WHERE json_extract(e.metadata, '$.handoff_note') IS NOT NULL
      -- Date by the owning session, not e.updated_at: metadata writes (e.g. a
      -- substance backfill) bump updated_at on old summary roots.
      AND json_extract(s.metadata, '$.date') >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-30 days')
      AND e.id IN (
        WITH RECURSIVE tree(id) AS (
          SELECT id FROM entries WHERE id = ?
          UNION ALL
          SELECT c.id FROM entries c JOIN tree t ON c.parent_id = t.id WHERE c.tombstoned_at IS NULL
        )
        SELECT id FROM tree
      )
    ORDER BY json_extract(s.metadata, '$.date') DESC
    LIMIT 1
  `).get(project.id);
  const newestHandoffNote = handoffRow?.note ?? null;

  // Open tasks (any non-closed status, new or legacy metadata shape) in project subtree for G8 title lookup.
  const taskRows = db.prepare(`
    WITH RECURSIVE tree(id) AS (
      SELECT id FROM entries WHERE id = ?
      UNION ALL
      SELECT e.id FROM entries e JOIN tree t ON e.parent_id = t.id WHERE e.tombstoned_at IS NULL
    )
    SELECT e.title, e.updated_at
    FROM entries e
    JOIN tree t ON e.id = t.id
    WHERE COALESCE(json_extract(e.metadata, '$.task.status'), json_extract(e.metadata, '$.status'))
          NOT IN ('done', 'cancelled', 'closed', 'wontfix')
      AND (json_type(e.metadata, '$.task') IS NOT NULL OR json_extract(e.metadata, '$.type') = 'task')
  `).all(project.id);
  const openTasksByTitle = new Map(
    taskRows.map((r) => [normalizeTitle(r.title), r]),
  );

  // Same clock as the renderer (getProjectActiveDays): days with a real exchange.
  const activeDays = db.prepare(`
    WITH RECURSIVE sub AS (
      SELECT id FROM entries
      WHERE parent_id = ? AND json_extract(metadata, '$.kind') = 'sessions-root' AND tombstoned_at IS NULL
      UNION ALL
      SELECT e.id FROM entries e INNER JOIN sub ON e.parent_id = sub.id WHERE e.tombstoned_at IS NULL
    )
    SELECT DISTINCT substr(e.created_at, 1, 10) AS day
    FROM entries e INNER JOIN sub ON e.id = sub.id
    WHERE json_extract(e.metadata, '$.kind') = 'exchange'
      AND COALESCE(json_extract(e.metadata, '$.system_turn'), 0) != 1
  `).all(project.id).map((r) => r.day);

  db.close();
  return {
    activeDays,
    lastActivity,
    liveTestCount,
    sessionCount: sessions.length,
    newestSessionDate,
    newestSubstantiveSessionDate,
    newestSubstantiveActivityDate,
    newestSessionId,
    newestSessionExchangeCount,
    newestSessionHasHandoff,
    newestSubstantiveSession,
    newestHandoffNote,
    openTasksByTitle,
  };
}

function runSelftest() {
  const { strict: assert } = require('node:assert');
  const { evalG1, evalG6, evalS1 } = require('./briefing-eval-goals.mjs');

  const passLoad = [
    'P0063 — Demo',
    'Status: Active · 2026-09-20 · 10 tests',
    '',
    'TypeScript demo ## Project overview A real project.',
    '',
    '── Open work ──',
    '- [in_progress] Ship it',
  ].join('\n');
  assert.equal(evalG1(passLoad).pass, true);

  const failLoad = 'Empty\nNo dates here\n';
  assert.equal(evalG1(failLoad).pass, false);

  const contradict = 'already loaded — do NOT re-fetch. Call tim_load_project(label="P1")';
  assert.equal(evalG6(contradict).pass, false);
  const okDirective = 'ACTION: call tim_load_project(label="P1") now';
  assert.equal(evalG6(okDirective).pass, true);

  assert.equal(evalS1({ looseDirectChildren: [] }).pass, true);
  assert.equal(evalS1({ looseDirectChildren: [{ id: 'x' }] }).pass, false);

  console.log('selftest: ok');
}

async function scoreProject({ dist, dbPath, home, project }) {
  const texts = await captureTexts({ dist, dbPath, home, project });
  const dbCtx = loadDbContext(dbPath, project);
  const results = evaluateAll({
    previewText: texts.previewText,
    loadText: texts.loadText,
    hookText: texts.hookText,
    structure: texts.structure,
    db: dbCtx,
    now: new Date(),
  });
  return { texts, results };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    process.exit(0);
  }
  if (args.selftest) {
    runSelftest();
    process.exit(0);
  }
  if (!args.db || (!args.project && !args.allActive)) {
    usage();
    process.exit(1);
  }

  const workRoot = mkdtempSync(join(tmpdir(), 'briefing-eval-run-'));
  const home = join(workRoot, 'home');
  mkdirSync(home);

  let tmpDbDir = null;
  try {
    const copied = copyDbToTemp(resolve(args.db));
    tmpDbDir = copied.dir;
    migrateTempDb(args.dist, copied.dbPath, home);

    if (args.allActive) {
      const db = new Database(copied.dbPath, { readonly: true });
      const projects = listActiveProjects(db, args.days);
      db.close();
      for (const p of projects) {
        try {
          const { results } = await scoreProject({
            dist: args.dist,
            dbPath: copied.dbPath,
            home,
            project: p.label,
          });
          console.log(formatProjectSummaryLine(p.label, results));
        } catch (err) {
          console.log(`${p.label}  ERROR ${err instanceof Error ? err.message : err}`);
        }
      }
      process.exit(0);
    }

    const { texts, results } = await scoreProject({
      dist: args.dist,
      dbPath: copied.dbPath,
      home,
      project: args.project,
    });

    if (args.out) {
      mkdirSync(args.out, { recursive: true });
      writeFileSync(join(args.out, 'preview.txt'), texts.previewText);
      writeFileSync(join(args.out, 'load.txt'), texts.loadText);
      writeFileSync(join(args.out, 'hook.txt'), texts.hookText);
      writeFileSync(join(args.out, 'structure.json'), JSON.stringify(texts.structure, null, 2));
    }

    if (args.json) {
      console.log(JSON.stringify(results, null, 2));
    } else {
      console.log(formatScorecard(results));
    }
    process.exit(0);
  } catch (err) {
    console.error(`briefing-eval error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  } finally {
    if (tmpDbDir) rmSync(tmpDbDir, { recursive: true, force: true });
    rmSync(workRoot, { recursive: true, force: true });
  }
}

main();
