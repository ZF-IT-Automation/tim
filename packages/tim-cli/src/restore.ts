// TIM CLI — restore subcommand
//
// Restores ~/.tim/tim.db from a snapshot. The MCP server holds the live DB
// file handle, so restore REQUIRES stopping the server first (delegated to
// per-device bash scripts: tim-mcp-stop.sh / tim-mcp-start.sh).
//
// Usage:
//   tim restore                              # restore from latest.db
//   tim restore --from 20260615-0915         # restore from specific snapshot
//   tim restore --from /path/to/snap.db      # restore from arbitrary file
//   tim restore --dry-run                    # show plan, do not copy
//   tim restore --list                       # list available snapshots
//   tim restore --force                      # skip the "current db < 1h" safety
//
// The CLI emits a clear error if the per-device stop/start scripts are missing.

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { resolveDbPath } from './snapshot.js';
import { parseArgs, valueOptionsFor } from './args.js';

const DEFAULT_SNAPSHOT_DIR = '/tmp/tim-snapshots';
const MIN_AGE_MS = 3600 * 1000; // 1h safety: refuse restore if current db is younger
const STOP_SCRIPT_CANDIDATES = [
  '~/.hermes/scripts/tim-mcp-stop.sh',
  '~/bin/tim-mcp-stop.sh',
  '/usr/local/bin/tim-mcp-stop.sh',
];
const START_SCRIPT_CANDIDATES = [
  '~/.hermes/scripts/tim-mcp-start.sh',
  '~/bin/tim-mcp-start.sh',
  '/usr/local/bin/tim-mcp-start.sh',
];

function expandHome(p: string): string {
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function whichScript(candidates: string[]): string | null {
  for (const c of candidates) {
    const abs = expandHome(c);
    if (fs.existsSync(abs)) return abs;
  }
  return null;
}

function listSnapshots(dir: string): Array<{ path: string; mtime: number; size: number }> {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /^tim-\d{8}-\d{4}\.db$/.test(f))
    .map((f) => {
      const p = path.join(dir, f);
      const st = fs.statSync(p);
      return { path: p, mtime: st.mtimeMs, size: st.size };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

function resolveSource(flags: Record<string, string>): { source: string; isLatest: boolean; isAbsolute: boolean } {
  const from = flags.from;

  if (!from) {
    const latest = path.join(DEFAULT_SNAPSHOT_DIR, 'latest.db');
    if (!fs.existsSync(latest)) {
      throw new Error(`no --from given and no latest.db at ${latest}`);
    }
    return { source: latest, isLatest: true, isAbsolute: false };
  }

  // Absolute path
  if (from.startsWith('/') || from.startsWith('~/')) {
    const abs = expandHome(from);
    if (!fs.existsSync(abs)) {
      throw new Error(`snapshot file not found: ${abs}`);
    }
    return { source: abs, isLatest: false, isAbsolute: true };
  }

  // Treat as timestamp suffix: tim-YYYYMMDD-HHMM.db
  const candidates = listSnapshots(DEFAULT_SNAPSHOT_DIR);
  const match = candidates.find((c) => path.basename(c.path) === `tim-${from}.db`);
  if (!match) {
    throw new Error(
      `no snapshot matching "tim-${from}.db" in ${DEFAULT_SNAPSHOT_DIR}\n` +
        `use --list to see available snapshots`
    );
  }
  return { source: match.path, isLatest: false, isAbsolute: false };
}

function runScript(script: string, args: string[] = []): { ok: boolean; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(script, args, { encoding: 'utf8' });
    return { ok: true, stdout, stderr: '' };
  } catch (e: any) {
    return {
      ok: false,
      stdout: e.stdout?.toString() ?? '',
      stderr: (e.stderr?.toString() ?? e.message ?? '').toString(),
    };
  }
}

export async function cmdRestoreList(): Promise<void> {
  const dir = DEFAULT_SNAPSHOT_DIR;
  const snaps = listSnapshots(dir);
  if (snaps.length === 0) {
    console.log(`(no snapshots in ${dir})`);
    return;
  }
  console.log(`# Snapshots in ${dir}`);
  console.log('NAME                              SIZE       AGE');
  for (const s of snaps) {
    const name = path.basename(s.path);
    const ageMin = Math.floor((Date.now() - s.mtime) / 60000);
    const sizeKb = (s.size / 1024).toFixed(1).padStart(7);
    console.log(`${name}    ${sizeKb} KB   ${ageMin}m ago`);
  }
  const latest = path.join(dir, 'latest.db');
  if (fs.existsSync(latest)) {
    const target = fs.readlinkSync(latest);
    console.log(`\nlatest.db -> ${target}`);
  }
}

export async function cmdRestore(args: string[]): Promise<void> {
  const { flags } = parseArgs(args, { valueOptions: valueOptionsFor('restore') });

  if (flags.list === 'true') {
    await cmdRestoreList();
    return;
  }

  const dbPath = flags.db || resolveDbPath();
  const dryRun = flags['dry-run'] === 'true';
  const force = flags.force === 'true';

  let source: string;
  try {
    const r = resolveSource(flags);
    source = r.source;
  } catch (e: any) {
    console.error(`restore: ${e.message}`);
    process.exit(1);
  }

  // Validate source is SQLite
  if (fs.existsSync(source)) {
    const fd = fs.openSync(source, 'r');
    const buf = Buffer.alloc(16);
    fs.readSync(fd, buf, 0, 16, 0);
    fs.closeSync(fd);
    if (buf.toString('utf8', 0, 15) !== 'SQLite format 3') {
      console.error(`restore: source is not a valid SQLite file: ${source}`);
      process.exit(1);
    }
  }

  // Safety: refuse restore if current DB is < 1h old and not --force
  if (!force && fs.existsSync(dbPath)) {
    const st = fs.statSync(dbPath);
    const ageMs = Date.now() - st.mtimeMs;
    if (ageMs < MIN_AGE_MS) {
      const ageMin = Math.floor(ageMs / 60000);
      console.error(
        `restore: refusing to overwrite DB modified ${ageMin}m ago (safety threshold 60m)\n` +
          `current db: ${dbPath}\n` +
          `use --force to override (NOT recommended unless you know what you are doing)`
      );
      process.exit(2);
    }
  }

  const stopScript = whichScript(STOP_SCRIPT_CANDIDATES);
  const startScript = whichScript(START_SCRIPT_CANDIDATES);

  if (!stopScript) {
    console.error(
      `restore: tim-mcp-stop.sh not found in any known location.\n` +
        `Searched: ${STOP_SCRIPT_CANDIDATES.join(', ')}\n` +
        `Install a per-device stop script to enable restore.`
    );
    process.exit(1);
  }

  const preRestore = path.join(DEFAULT_SNAPSHOT_DIR, `pre-restore-${Date.now()}.db`);

  console.log(`# Restore plan`);
  console.log(`  source:    ${source}`);
  console.log(`  target:    ${dbPath}`);
  console.log(`  pre-restore safety copy: ${preRestore}`);
  console.log(`  stop script:  ${stopScript}`);
  console.log(`  start script: ${startScript ?? '(not found — manual restart required)'}`);

  if (dryRun) {
    console.log(`\n(dry-run: no changes made)`);
    return;
  }

  // 1. Take pre-restore safety copy of current db (if exists)
  if (fs.existsSync(dbPath)) {
    try {
      fs.copyFileSync(dbPath, preRestore);
      console.log(`✓ pre-restore safety copy written: ${preRestore}`);
    } catch (e: any) {
      console.error(`restore: cannot create safety copy: ${e.message}`);
      process.exit(1);
    }
  }

  // 2. Stop MCP server
  console.log(`→ stopping MCP server (${stopScript})...`);
  const stop = runScript(stopScript);
  if (!stop.ok) {
    console.error(`restore: stop script failed: ${stop.stderr || stop.stdout}`);
    process.exit(1);
  }
  console.log(`✓ MCP server stopped`);

  // 3. Copy snapshot → live DB
  try {
    fs.copyFileSync(source, dbPath);
    console.log(`✓ restored: ${source} → ${dbPath} (${fs.statSync(dbPath).size} bytes)`);
  } catch (e: any) {
    console.error(`restore: copy failed: ${e.message}`);
    if (startScript) runScript(startScript); // try to restart server
    process.exit(1);
  }

  // 4. PRAGMA wal_checkpoint(TRUNCATE) — clear stale WAL/SHM
  // We use a tiny node one-liner to run this without leaving better-sqlite3 here.
  try {
    const Database = require('better-sqlite3');
    const db = new Database(dbPath);
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
    console.log(`✓ WAL checkpointed (TRUNCATE)`);
  } catch (e: any) {
    console.warn(`warn: wal_checkpoint failed: ${e.message}`);
  }

  // 5. Start MCP server
  if (startScript) {
    console.log(`→ starting MCP server (${startScript})...`);
    const start = runScript(startScript);
    if (!start.ok) {
      console.error(`restore: start script failed: ${start.stderr || start.stdout}`);
      console.error(`(restored DB is on disk; you must restart the MCP server manually)`);
      process.exit(1);
    }
    console.log(`✓ MCP server started`);
  } else {
    console.warn(`warn: no tim-mcp-start.sh found — restart server manually`);
  }

  console.log(`\n# Restore complete`);
  console.log(`  from:    ${source}`);
  console.log(`  to:      ${dbPath}`);
  console.log(`  safety:  ${preRestore}`);
  console.log(`  size:    ${fs.statSync(dbPath).size} bytes`);
}
