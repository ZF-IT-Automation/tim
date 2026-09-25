// TIM CLI — snapshot subcommand
//
// Creates a consistent SQLite backup of ~/.tim/tim.db using better-sqlite3's
// online backup API (which wraps sqlite3_backup_init/step/finish). This avoids
// WAL-torn pages that a raw `cp` would produce against a live WAL-mode DB.
//
// Usage:
//   tim snapshot                          # snapshot to ~/.tim/snapshots/tim-YYYYMMDD-HHMM.db
//   tim snapshot --out /custom/path.db    # override destination
//   tim snapshot --no-symlink             # skip latest.db update
//   tim snapshot --prune-hours 48         # prune files older than 48h (0 = skip)
//   tim snapshot --max-bytes 8589934592   # also prune oldest until total size fits
//   tim snapshot --quiet                  # suppress non-error output

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { parseArgs, valueOptionsFor } from './args.js';

/**
 * Beside the DB, not in /tmp: Ubuntu clears /tmp at boot (tmpfiles.d `D /tmp`),
 * which would take every rollback point with it exactly when one is needed.
 */
export function defaultSnapshotDir(): string {
  return path.join(os.homedir(), '.tim', 'snapshots');
}
const DEFAULT_PRUNE_HOURS = 48;
/** 48h of 2 GB snapshots every 30 min is ~192 GB. Cap on-host copies. */
export const DEFAULT_MAX_BYTES = 8 * 1024 * 1024 * 1024;
/** Extra free space required beyond the source DB size before creating a snapshot. */
export const SNAPSHOT_HEADROOM_BYTES = 64 * 1024 * 1024;

/**
 * Parse snapshot byte budget from env/CLI.
 * Missing config → documented default. Present but invalid → explicit error.
 */
export type SnapshotBudgetResult =
  | { ok: true; value: number }
  | { ok: false; error: string };

export function parseSnapshotBudgetStrict(raw: string): SnapshotBudgetResult {
  if (raw === '') {
    return { ok: false, error: 'snapshot budget is empty' };
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    return { ok: false, error: `invalid snapshot budget: ${raw}` };
  }
  return { ok: true, value: n };
}

export function parseSnapshotBudgetFromEnv(
  raw: string | undefined,
  fallback: number,
): SnapshotBudgetResult {
  if (raw === undefined) return { ok: true, value: fallback };
  return parseSnapshotBudgetStrict(raw);
}

/** @deprecated Use parseSnapshotBudgetFromEnv / parseSnapshotBudgetStrict */
export function parseSnapshotBudget(raw: string | undefined, fallback: number): number {
  const result = parseSnapshotBudgetFromEnv(raw, fallback);
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

export function snapshotHasRoom(opts: {
  sourceBytes: number;
  freeBytes: number;
  headroomBytes?: number;
}): boolean {
  const headroom = opts.headroomBytes ?? SNAPSHOT_HEADROOM_BYTES;
  return opts.freeBytes >= opts.sourceBytes + headroom;
}

/** Online backup copies committed WAL frames; room checks must cover db+WAL. */
export function snapshotFootprintBytes(
  dbPath: string,
  io: {
    statDb?: (p: string) => { size: number };
    statWal?: (p: string) => { size: number };
  } = {},
): number {
  const statDb = io.statDb ?? ((p) => fs.statSync(p));
  const statWal = io.statWal ?? ((p) => fs.statSync(p));
  let bytes = statDb(dbPath).size;
  const walPath = `${dbPath}-wal`;
  try {
    bytes += statWal(walPath).size;
  } catch (e: unknown) {
    const code = (e as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') return bytes;
    throw e;
  }
  return bytes;
}

/** Returns free bytes on the filesystem hosting dir. Throws on statfs failure. */
export function readFreeBytes(dir: string): number {
  const st = fs.statfsSync(dir);
  return Number(st.bavail) * Number(st.bsize);
}

/**
 * If the snapshot directory cannot hold another copy of the source DB,
 * prune oldest files first, then abort rather than filling the disk.
 */
export function makeRoomForSnapshot(opts: {
  dir: string;
  sourceBytes: number;
  freeBytes: number;
  pruneHours: number;
  maxBytes: number;
  log?: (s: string) => void;
}): { ok: boolean; pruned: number; freeBytes: number; error?: string } {
  const log = opts.log ?? (() => {});
  let freeBytes = opts.freeBytes;
  const hasRoom = () => snapshotHasRoom({ sourceBytes: opts.sourceBytes, freeBytes });
  if (hasRoom()) return { ok: true, pruned: 0, freeBytes };

  // Age-prune happens after a successful backup. Doing it here deleted the
  // last valid copy on 2026-09-03 when cron had been off >48h and the new
  // snapshot then failed.
  const sizeBefore = listSnapshots(opts.dir).reduce((sum, f) => {
    try {
      return sum + fs.statSync(f).size;
    } catch {
      return sum;
    }
  }, 0);
  let pruned = pruneToMaxBytes(opts.dir, opts.maxBytes, log);

  const sizeAfterCap = listSnapshots(opts.dir).reduce((sum, f) => {
    try {
      return sum + fs.statSync(f).size;
    } catch {
      return sum;
    }
  }, 0);
  freeBytes += Math.max(0, sizeBefore - sizeAfterCap);

  const sized = () =>
    listSnapshots(opts.dir)
      .map((f) => ({ path: f, mtime: fs.statSync(f).mtimeMs, size: fs.statSync(f).size }))
      .sort((a, b) => b.mtime - a.mtime);

  // Cap prune is not enough when the disk is full of other files: keep
  // dropping oldest snapshots (never the newest) until the new copy fits.
  for (let files = sized(); files.length > 1 && !hasRoom(); files = sized()) {
    const oldest = files[files.length - 1]!;
    try {
      fs.unlinkSync(oldest.path);
      freeBytes += oldest.size;
      pruned++;
    } catch {
      break;
    }
  }

  if (!hasRoom()) {
    return {
      ok: false,
      pruned,
      freeBytes,
      error: `not enough free disk for snapshot (need ${opts.sourceBytes + SNAPSHOT_HEADROOM_BYTES} bytes, have ${freeBytes})`,
    };
  }
  return { ok: true, pruned, freeBytes };
}

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
  const files = listSnapshots(dir)
    .map((f) => ({ path: f, mtime: fs.statSync(f).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  let removed = 0;
  // Never delete the newest snapshot — a failed follow-up backup must not
  // leave the host with zero restore points.
  for (const f of files.slice(1)) {
    try {
      if (f.mtime < cutoff) {
        fs.unlinkSync(f.path);
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
 * Delete oldest snapshots until total size is under maxBytes.
 * Always keeps the newest file, even if it alone exceeds the budget.
 */
export function pruneToMaxBytes(
  dir: string,
  maxBytes: number,
  log: (s: string) => void = () => {},
): number {
  if (maxBytes <= 0) return 0;
  const files = listSnapshots(dir)
    .map((f) => ({ path: f, mtime: fs.statSync(f).mtimeMs, size: fs.statSync(f).size }))
    .sort((a, b) => b.mtime - a.mtime);
  if (files.length <= 1) return 0;

  let total = files.reduce((sum, f) => sum + f.size, 0);
  let removed = 0;
  for (let i = files.length - 1; i >= 1 && total > maxBytes; i--) {
    try {
      fs.unlinkSync(files[i]!.path);
      total -= files[i]!.size;
      removed++;
    } catch {
      // ignore
    }
  }
  if (removed) log(`prune: removed ${removed} snapshot(s) to stay under ${maxBytes} bytes`);
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
  maxBytes?: number;
  noSymlink?: boolean;
  quiet?: boolean;
  freeBytes?: number;
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
  const snapshotDir = opts.snapshotDir ?? defaultSnapshotDir();
  const pruneHours = opts.pruneHours ?? DEFAULT_PRUNE_HOURS;
  let maxBytes: number;
  if (opts.maxBytes !== undefined) {
    maxBytes = opts.maxBytes;
  } else {
    const budget = parseSnapshotBudgetFromEnv(
      process.env.TIM_SNAPSHOT_MAX_BYTES,
      DEFAULT_MAX_BYTES,
    );
    if (!budget.ok) {
      return { ok: false, error: budget.error };
    }
    maxBytes = budget.value;
  }

  if (!fs.existsSync(dbPath)) {
    return { ok: false, error: `db not found: ${dbPath}` };
  }

  ensureDir(snapshotDir);

  let sourceBytes: number;
  try {
    sourceBytes = snapshotFootprintBytes(dbPath);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `cannot stat database footprint: ${message}` };
  }

  let freeBytes = opts.freeBytes;
  if (freeBytes === undefined) {
    try {
      freeBytes = readFreeBytes(snapshotDir);
    } catch (e: unknown) {
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, error: `cannot stat filesystem capacity: ${message}` };
    }
  }
  const room = makeRoomForSnapshot({
    dir: snapshotDir,
    sourceBytes,
    freeBytes,
    pruneHours,
    maxBytes,
    log,
  });
  if (!room.ok) {
    return { ok: false, error: room.error, pruned: room.pruned };
  }

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
    const prunedAge = pruneOld(snapshotDir, pruneHours, log);
    const prunedBytes = pruneToMaxBytes(snapshotDir, maxBytes, log);
    const pruned = prunedAge + prunedBytes;
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
  const { flags } = parseArgs(args, { valueOptions: valueOptionsFor('snapshot') });

  let maxBytes: number | undefined;
  if (flags['max-bytes'] !== undefined) {
    const budget = parseSnapshotBudgetStrict(flags['max-bytes']);
    if (!budget.ok) {
      console.error(`snapshot: ${budget.error}`);
      process.exit(1);
    }
    maxBytes = budget.value;
  }

  const result = await runSnapshot({
    dbPath: flags.db || undefined,
    snapshotDir: flags.out ? path.dirname(flags.out) : undefined,
    pruneHours: flags['prune-hours'] !== undefined ? Number(flags['prune-hours']) : undefined,
    maxBytes,
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
