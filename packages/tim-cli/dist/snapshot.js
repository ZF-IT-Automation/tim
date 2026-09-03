"use strict";
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
//   tim snapshot --max-bytes 8589934592   # also prune oldest until total size fits
//   tim snapshot --quiet                  # suppress non-error output
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
exports.SNAPSHOT_HEADROOM_BYTES = exports.DEFAULT_MAX_BYTES = void 0;
exports.parseSnapshotBudget = parseSnapshotBudget;
exports.snapshotHasRoom = snapshotHasRoom;
exports.makeRoomForSnapshot = makeRoomForSnapshot;
exports.resolveDbPath = resolveDbPath;
exports.pruneToMaxBytes = pruneToMaxBytes;
exports.runSnapshot = runSnapshot;
exports.cmdSnapshot = cmdSnapshot;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
const args_js_1 = require("./args.js");
const DEFAULT_SNAPSHOT_DIR = '/tmp/tim-snapshots';
const DEFAULT_PRUNE_HOURS = 48;
/** 48h of 2 GB snapshots every 30 min is ~192 GB. Cap on-host copies. */
exports.DEFAULT_MAX_BYTES = 8 * 1024 * 1024 * 1024;
/** Extra free space required beyond the source DB size before creating a snapshot. */
exports.SNAPSHOT_HEADROOM_BYTES = 64 * 1024 * 1024;
/**
 * Invalid or negative TIM_SNAPSHOT_MAX_BYTES used to become NaN, which
 * skipped prune (`maxBytes <= 0` is false for NaN). Fall back instead.
 */
function parseSnapshotBudget(raw, fallback) {
    if (raw === undefined || raw === '')
        return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0)
        return fallback;
    return n;
}
function snapshotHasRoom(opts) {
    const headroom = opts.headroomBytes ?? exports.SNAPSHOT_HEADROOM_BYTES;
    return opts.freeBytes >= opts.sourceBytes + headroom;
}
function readFreeBytes(dir) {
    const st = fs.statfsSync(dir);
    return Number(st.bavail) * Number(st.bsize);
}
/**
 * If the snapshot directory cannot hold another copy of the source DB,
 * prune oldest files first, then abort rather than filling the disk.
 */
function makeRoomForSnapshot(opts) {
    const log = opts.log ?? (() => { });
    let freeBytes = opts.freeBytes;
    const hasRoom = () => snapshotHasRoom({ sourceBytes: opts.sourceBytes, freeBytes });
    if (hasRoom())
        return { ok: true, pruned: 0, freeBytes };
    const sizeBefore = listSnapshots(opts.dir).reduce((sum, f) => {
        try {
            return sum + fs.statSync(f).size;
        }
        catch {
            return sum;
        }
    }, 0);
    let pruned = pruneOld(opts.dir, opts.pruneHours, log);
    pruned += pruneToMaxBytes(opts.dir, opts.maxBytes, log);
    const sizeAfterCap = listSnapshots(opts.dir).reduce((sum, f) => {
        try {
            return sum + fs.statSync(f).size;
        }
        catch {
            return sum;
        }
    }, 0);
    freeBytes += Math.max(0, sizeBefore - sizeAfterCap);
    const sized = () => listSnapshots(opts.dir)
        .map((f) => ({ path: f, mtime: fs.statSync(f).mtimeMs, size: fs.statSync(f).size }))
        .sort((a, b) => b.mtime - a.mtime);
    // Cap prune is not enough when the disk is full of other files: keep
    // dropping oldest snapshots (never the newest) until the new copy fits.
    for (let files = sized(); files.length > 1 && !hasRoom(); files = sized()) {
        const oldest = files[files.length - 1];
        try {
            fs.unlinkSync(oldest.path);
            freeBytes += oldest.size;
            pruned++;
        }
        catch {
            break;
        }
    }
    if (!hasRoom()) {
        return {
            ok: false,
            pruned,
            freeBytes,
            error: `not enough free disk for snapshot (need ${opts.sourceBytes + exports.SNAPSHOT_HEADROOM_BYTES} bytes, have ${freeBytes})`,
        };
    }
    return { ok: true, pruned, freeBytes };
}
function ts() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return (d.getFullYear().toString() +
        pad(d.getMonth() + 1) +
        pad(d.getDate()) +
        '-' +
        pad(d.getHours()) +
        pad(d.getMinutes()));
}
function resolveDbPath() {
    return (process.env.TIM_DB_PATH ||
        path.join(os.homedir(), '.tim', 'tim.db'));
}
function ensureDir(p) {
    if (!fs.existsSync(p))
        fs.mkdirSync(p, { recursive: true });
}
function listSnapshots(dir) {
    if (!fs.existsSync(dir))
        return [];
    return fs
        .readdirSync(dir)
        .filter((f) => /^tim-\d{8}-\d{4}\.db$/.test(f))
        .map((f) => path.join(dir, f));
}
function pruneOld(dir, maxAgeHours, log) {
    if (maxAgeHours <= 0)
        return 0;
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
        }
        catch {
            // ignore
        }
    }
    if (removed)
        log(`prune: removed ${removed} snapshot(s) older than ${maxAgeHours}h`);
    return removed;
}
/**
 * Delete oldest snapshots until total size is under maxBytes.
 * Always keeps the newest file, even if it alone exceeds the budget.
 */
function pruneToMaxBytes(dir, maxBytes, log = () => { }) {
    if (maxBytes <= 0)
        return 0;
    const files = listSnapshots(dir)
        .map((f) => ({ path: f, mtime: fs.statSync(f).mtimeMs, size: fs.statSync(f).size }))
        .sort((a, b) => b.mtime - a.mtime);
    if (files.length <= 1)
        return 0;
    let total = files.reduce((sum, f) => sum + f.size, 0);
    let removed = 0;
    for (let i = files.length - 1; i >= 1 && total > maxBytes; i--) {
        try {
            fs.unlinkSync(files[i].path);
            total -= files[i].size;
            removed++;
        }
        catch {
            // ignore
        }
    }
    if (removed)
        log(`prune: removed ${removed} snapshot(s) to stay under ${maxBytes} bytes`);
    return removed;
}
/**
 * Run a hot SQLite backup using the online backup API.
 * Returns { ok, error?, bytes, durationMs }.
 */
async function runSnapshot(opts = {}) {
    const start = Date.now();
    const log = (s) => {
        if (!opts.quiet)
            console.log(s);
    };
    const dbPath = opts.dbPath ?? resolveDbPath();
    const snapshotDir = opts.snapshotDir ?? DEFAULT_SNAPSHOT_DIR;
    const pruneHours = opts.pruneHours ?? DEFAULT_PRUNE_HOURS;
    const maxBytes = opts.maxBytes !== undefined
        ? opts.maxBytes
        : parseSnapshotBudget(process.env.TIM_SNAPSHOT_MAX_BYTES, exports.DEFAULT_MAX_BYTES);
    if (!fs.existsSync(dbPath)) {
        return { ok: false, error: `db not found: ${dbPath}` };
    }
    ensureDir(snapshotDir);
    const sourceBytes = fs.statSync(dbPath).size;
    let freeBytes = opts.freeBytes;
    if (freeBytes === undefined) {
        try {
            freeBytes = readFreeBytes(snapshotDir);
        }
        catch {
            freeBytes = Number.POSITIVE_INFINITY;
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
    let Database;
    try {
        // Dynamic import to avoid hard dep if better-sqlite3 missing
        Database = require('better-sqlite3');
    }
    catch (e) {
        return { ok: false, error: `better-sqlite3 not available: ${e.message}` };
    }
    let srcDb;
    try {
        // Open source readonly. This avoids the "database file has been opened
        // by another process" warning that the live MCP writer would trigger
        // (SQLITE_BUSY) on a non-readonly connection.
        srcDb = new Database(dbPath, { readonly: true, fileMustExist: true });
    }
    catch (e) {
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
            }
            catch {
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
    }
    catch (e) {
        // Clean up partial if it exists
        if (fs.existsSync(targetTmp)) {
            try {
                fs.unlinkSync(targetTmp);
            }
            catch { /* ignore */ }
        }
        return { ok: false, error: `backup failed: ${e.message}` };
    }
    finally {
        try {
            srcDb.close();
        }
        catch { /* ignore */ }
    }
}
async function cmdSnapshot(args) {
    const { flags } = (0, args_js_1.parseArgs)(args, { valueOptions: (0, args_js_1.valueOptionsFor)('snapshot') });
    const result = await runSnapshot({
        dbPath: flags.db || undefined,
        snapshotDir: flags.out ? path.dirname(flags.out) : undefined,
        pruneHours: flags['prune-hours'] !== undefined ? Number(flags['prune-hours']) : undefined,
        maxBytes: flags['max-bytes'] !== undefined
            ? parseSnapshotBudget(flags['max-bytes'], exports.DEFAULT_MAX_BYTES)
            : undefined,
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
//# sourceMappingURL=snapshot.js.map