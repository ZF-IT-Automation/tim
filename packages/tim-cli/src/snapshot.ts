// TIM CLI — snapshot subcommand
//
// Creates a consistent SQLite backup of ~/.tim/tim.db using better-sqlite3's
// online backup API (which wraps sqlite3_backup_init/step/finish). This avoids
// WAL-torn pages that a raw `cp` would produce against a live WAL-mode DB.
//
// Usage:
//   tim snapshot                          # snapshot to /tmp/tim-snapshots/tim-YYYYMMDD-HHMM.db
//   tim snapshot --out /custom/path.db    # override destination
//   tim snapshot --no-symlink             # skip latest.db update
//   tim snapshot --prune-hours 48         # prune files older than 48h (0 = skip)
//   tim snapshot --quiet                  # suppress non-error output

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const DEFAULT_SNAPSHOT_DIR = '/tmp/tim-snapshots';
const DEFAULT_PRUNE_HOURS = 48;

function ts(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return (
    d.getFullYear().toString() +
    pad(d.getMonth() + 1) +
    pad(d.getDate()) +
    '-' +
    pad(d.getHours()) +
    pad(d.getMinutes())
  );
}

function parseFlags(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    const v = args[i + 1];
    if (v && !v.startsWith('--')) {
      out[k] = v;
      i++;
    } else {
      out[k] = 'true';
    }
  }
  return out;
}

export function resolveDbPath(): string {
  return (
    process.env.TIM_DB_PATH ||
    path.join(os.homedir(), '.tim', 'tim.db')
  );
}

function ensureDir(p: string) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function listSnapshots(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /^tim-\d{8}-\d{4}\.db$/.test(f))
    .map((f) => path.join(dir, f));
}

function pruneOld(dir: string, maxAgeHours: number, log: (s: string) => void): number {
  if (maxAgeHours <= 0) return 0;
  const cutoff = Date.now() - maxAgeHours * 3600 * 1000;
  const files = listSnapshots(dir);
  let removed = 0;
  for (const f of files) {
    try {
      const st = fs.statSync(f);
      if (st.mtimeMs < cutoff) {
        fs.unlinkSync(f);
        removed++;
      }
    } catch {
      // ignore
    }
  }
  if (removed) log(`prune: removed ${removed} snapshot(s) older than ${maxAgeHours}h`);
  return removed;
}

/**
 * Run a hot SQLite backup using the online backup API.
 * Returns { ok, error?, bytes, durationMs }.
 */
export async function runSnapshot(opts: {
  dbPath?: string;
  snapshotDir?: string;
  pruneHours?: number;
  noSymlink?: boolean;
  quiet?: boolean;
} = {}): Promise<{
  ok: boolean;
  target?: string;
  bytes?: number;
  durationMs?: number;
  error?: string;
  pruned?: number;
}> {
  const start = Date.now();
  const log = (s: string) => {
    if (!opts.quiet) console.log(s);
  };

  const dbPath = opts.dbPath ?? resolveDbPath();
  const snapshotDir = opts.snapshotDir ?? DEFAULT_SNAPSHOT_DIR;
  const pruneHours = opts.pruneHours ?? DEFAULT_PRUNE_HOURS;

  if (!fs.existsSync(dbPath)) {
    return { ok: false, error: `db not found: ${dbPath}` };
  }

  ensureDir(snapshotDir);

  const target = path.join(snapshotDir, `tim-${ts()}.db`);
  const targetTmp = target + '.partial';

  let Database: any;
  try {
    // Dynamic import to avoid hard dep if better-sqlite3 missing
    Database = require('better-sqlite3');
  } catch (e: any) {
    return { ok: false, error: `better-sqlite3 not available: ${e.message}` };
  }

  let srcDb: any;
  try {
    // Open source readonly. This avoids the "database file has been opened
    // by another process" warning that the live MCP writer would trigger
    // (SQLITE_BUSY) on a non-readonly connection.
    srcDb = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch (e: any) {
    return { ok: false, error: `cannot open source db: ${e.message}` };
  }

  try {
    // Atomic write: backup to .partial, then rename.
    // better-sqlite3's `backup()` blocks the writer for the duration but is
    // internally consistent — no torn pages even if MCP server is active.
    await srcDb.backup(targetTmp);

    // Verify the backup is a valid SQLite file (header magic).
    const fd = fs.openSync(targetTmp, 'r');
    const buf = Buffer.alloc(16);
    fs.readSync(fd, buf, 0, 16, 0);
    fs.closeSync(fd);
    if (buf.toString('utf8', 0, 15) !== 'SQLite format 3') {
      fs.unlinkSync(targetTmp);
      return { ok: false, error: 'backup verification failed: not a SQLite file' };
    }

    fs.renameSync(targetTmp, target);

    if (!opts.noSymlink) {
      const latest = path.join(snapshotDir, 'latest.db');
      try {
        if (fs.existsSync(latest) || fs.lstatSync(latest).isSymbolicLink()) {
          fs.unlinkSync(latest);
        }
      } catch {
        // ignore
      }
      fs.symlinkSync(path.basename(target), latest);
    }

    const bytes = fs.statSync(target).size;
    const pruned = pruneOld(snapshotDir, pruneHours, log);
    const durationMs = Date.now() - start;
    log(`snapshot: ${target} (${bytes} bytes, ${durationMs}ms)`);
    return { ok: true, target, bytes, durationMs, pruned };
  } catch (e: any) {
    // Clean up partial if it exists
    if (fs.existsSync(targetTmp)) {
      try { fs.unlinkSync(targetTmp); } catch { /* ignore */ }
    }
    return { ok: false, error: `backup failed: ${e.message}` };
  } finally {
    try { srcDb.close(); } catch { /* ignore */ }
  }
}

export async function cmdSnapshot(args: string[]): Promise<void> {
  const flags = parseFlags(args);
  const result = await runSnapshot({
    dbPath: flags.db || undefined,
    snapshotDir: flags.out ? path.dirname(flags.out) : undefined,
    pruneHours: flags['prune-hours'] !== undefined ? Number(flags['prune-hours']) : undefined,
    noSymlink: flags['no-symlink'] === 'true',
    quiet: flags.quiet === 'true',
  });

  if (!result.ok) {
    console.error(`snapshot: ${result.error}`);
    process.exit(1);
  }

  if (!flags.quiet) {
    console.log(JSON.stringify(result, null, 2));
  }
}
