"use strict";
// TIM CLI — compact-error-log
//
// Rebuilds a bloated error_log (the 2026-09-03 EPIPE storm path) without a
// multi-million-row DELETE, then optionally VACUUMs. Requires exclusive
// maintenance, writer verification, and free-space preflight for VACUUM.
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
exports.VACUUM_HEADROOM_FACTOR = void 0;
exports.vacuumHasRoom = vacuumHasRoom;
exports.planCompactErrorLog = planCompactErrorLog;
exports.cmdCompactErrorLog = cmdCompactErrorLog;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const tim_core_1 = require("tim-core");
const args_js_1 = require("./args.js");
const tim_store_1 = require("tim-store");
const snapshot_js_1 = require("./snapshot.js");
const writers_js_1 = require("./writers.js");
/** VACUUM may need roughly the current file size in free space. */
exports.VACUUM_HEADROOM_FACTOR = 1.1;
function vacuumHasRoom(dbBytes, freeBytes) {
    return freeBytes >= dbBytes * exports.VACUUM_HEADROOM_FACTOR;
}
function planCompactErrorLog(opts) {
    const plan = [
        `acquire maintenance lock on ${opts.dbPath}`,
        'verify no tim-mcp writers',
        `rebuild error_log keeping newest ${opts.maxEntries} rows`,
    ];
    if (opts.vacuum) {
        if (opts.freeBytes === undefined) {
            return { ok: false, error: 'freeBytes required for VACUUM preflight' };
        }
        const dbBytes = fs.statSync(opts.dbPath).size;
        if (!vacuumHasRoom(dbBytes, opts.freeBytes)) {
            return {
                ok: false,
                error: `insufficient free space for VACUUM (need ~${Math.ceil(dbBytes * exports.VACUUM_HEADROOM_FACTOR)} bytes, have ${opts.freeBytes})`,
            };
        }
        plan.push(`VACUUM (${dbBytes} byte file)`);
    }
    return { ok: true, plan };
}
async function cmdCompactErrorLog(args) {
    const { flags } = (0, args_js_1.parseArgs)(args, { valueOptions: (0, args_js_1.valueOptionsFor)('compact-error-log') });
    const dbPath = flags.db || (0, snapshot_js_1.resolveDbPath)();
    const dryRun = flags['dry-run'] === 'true';
    const vacuum = flags.vacuum === 'true';
    const maxEntriesRaw = flags['max-entries'] !== undefined ? Number(flags['max-entries']) : 10_000;
    const maxEntries = Number.isFinite(maxEntriesRaw) && maxEntriesRaw > 0 ? maxEntriesRaw : 10_000;
    if (!fs.existsSync(dbPath)) {
        console.error(`compact-error-log: db not found: ${dbPath}`);
        process.exit(1);
    }
    let freeBytes;
    if (vacuum || dryRun) {
        try {
            freeBytes = (0, snapshot_js_1.readFreeBytes)(path.dirname(dbPath));
        }
        catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            console.error(`compact-error-log: cannot stat filesystem: ${message}`);
            process.exit(1);
        }
    }
    const planned = planCompactErrorLog({ dbPath, maxEntries, vacuum, freeBytes });
    if (!planned.ok) {
        console.error(`compact-error-log: ${planned.error}`);
        process.exit(1);
    }
    if (dryRun) {
        console.log(JSON.stringify({ ok: true, dryRun: true, db: dbPath, plan: planned.plan }));
        return;
    }
    let maintenance = null;
    const backupPath = `${dbPath}.pre-compact-${Date.now()}`;
    try {
        maintenance = (0, tim_core_1.acquireMaintenanceLock)({ dbPath, operation: 'compact-error-log' });
        try {
            (0, writers_js_1.requireNoWriters)('compact-error-log');
        }
        catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            console.error(`compact-error-log: ${message}`);
            process.exit(1);
        }
        fs.copyFileSync(dbPath, backupPath);
        let Database;
        try {
            Database = require('better-sqlite3');
        }
        catch (e) {
            console.error(`compact-error-log: better-sqlite3 not available: ${e.message}`);
            process.exit(1);
        }
        const db = new Database(dbPath);
        try {
            const result = (0, tim_store_1.compactErrorLog)(db, { maxEntries, vacuum });
            const integrity = db.pragma('integrity_check');
            const check = Array.isArray(integrity) ? integrity[0]?.integrity_check : integrity;
            if (check !== 'ok') {
                throw new Error(`integrity_check failed after compaction: ${String(check)}`);
            }
            console.log(JSON.stringify({ ok: true, db: dbPath, backup: backupPath, ...result }));
        }
        catch (e) {
            db.close();
            try {
                fs.copyFileSync(backupPath, dbPath);
            }
            catch (restoreErr) {
                const message = restoreErr instanceof Error ? restoreErr.message : String(restoreErr);
                console.error(`compact-error-log: rollback failed: ${message}`);
            }
            const message = e instanceof Error ? e.message : String(e);
            console.error(`compact-error-log: ${message}`);
            process.exit(1);
        }
        finally {
            try {
                db.close();
            }
            catch {
                // ignore
            }
        }
    }
    finally {
        maintenance?.release();
    }
}
//# sourceMappingURL=compact-error-log.js.map