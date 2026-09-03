"use strict";
// TIM CLI — compact-error-log
//
// Rebuilds a bloated error_log (the 2026-09-03 EPIPE storm path) without a
// multi-million-row DELETE, then optionally VACUUMs. Refuses while any
// tim-mcp writer still holds the database.
Object.defineProperty(exports, "__esModule", { value: true });
exports.cmdCompactErrorLog = cmdCompactErrorLog;
const args_js_1 = require("./args.js");
const tim_store_1 = require("tim-store");
const snapshot_js_1 = require("./snapshot.js");
const restore_js_1 = require("./restore.js");
async function cmdCompactErrorLog(args) {
    const { flags } = (0, args_js_1.parseArgs)(args, { valueOptions: (0, args_js_1.valueOptionsFor)('compact-error-log') });
    const dbPath = flags.db || (0, snapshot_js_1.resolveDbPath)();
    const leftover = (0, restore_js_1.listTimMcpWriterPids)();
    if (!(0, restore_js_1.walSidecarsMayBeDropped)(leftover)) {
        console.error(`compact-error-log: writers still hold the DB: ${leftover.join(' ')}\n` +
            `stop MCP first (scripts/tim-mcp-stop.sh or scripts/tim-compact-error-log.sh).`);
        process.exit(1);
    }
    let Database;
    try {
        Database = require('better-sqlite3');
    }
    catch (e) {
        console.error(`compact-error-log: better-sqlite3 not available: ${e.message}`);
        process.exit(1);
    }
    const maxEntries = flags['max-entries'] !== undefined ? Number(flags['max-entries']) : 10_000;
    const db = new Database(dbPath);
    try {
        const result = (0, tim_store_1.compactErrorLog)(db, {
            maxEntries: Number.isFinite(maxEntries) && maxEntries > 0 ? maxEntries : 10_000,
            vacuum: flags.vacuum === 'true',
        });
        console.log(JSON.stringify({ ok: true, db: dbPath, ...result }));
    }
    finally {
        db.close();
    }
}
//# sourceMappingURL=compact-error-log.js.map