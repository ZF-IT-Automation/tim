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
exports.resolveDbPath = resolveDbPath;
exports.runSnapshot = runSnapshot;
exports.cmdSnapshot = cmdSnapshot;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const os = __importStar(require("os"));
const args_js_1 = require("./args.js");
const DEFAULT_SNAPSHOT_DIR = '/tmp/tim-snapshots';
const DEFAULT_PRUNE_HOURS = 48;
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
    if (!fs.existsSync(dbPath)) {
        return { ok: false, error: `db not found: ${dbPath}` };
    }
    ensureDir(snapshotDir);
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
        const pruned = pruneOld(snapshotDir, pruneHours, log);
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