"use strict";
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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const vitest_1 = require("vitest");
const fs = __importStar(require("node:fs"));
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const store_js_1 = require("../store.js");
const schema_js_1 = require("../schema.js");
(0, vitest_1.describe)('reconcileMetadataTypes', () => {
    let dbPath;
    let store;
    let db;
    (0, vitest_1.beforeEach)(() => {
        dbPath = path.join(os.tmpdir(), `tim-reconcile-${Date.now()}.db`);
        db = new better_sqlite3_1.default(dbPath);
        (0, schema_js_1.runMigrations)(db);
        store = new store_js_1.TimStore(dbPath);
    });
    (0, vitest_1.afterEach)(() => {
        store.close();
        if (fs.existsSync(dbPath))
            fs.unlinkSync(dbPath);
    });
    function insertBadEntry(id, metadata) {
        const now = new Date().toISOString();
        db.prepare(`INSERT INTO entries
      (id, parent_id, title, content, content_type, depth, confidence, created_at,
       accessed_at, decay_rate, visibility, tags, irrelevant, favorite, tombstoned_at, metadata)
      VALUES (?, NULL, ?, '', 'text', 1, 1, ?, ?, 0, 1, '[]', 0, 0, NULL, ?)`).run(id, `Entry ${id}`, now, now, metadata);
    }
    (0, vitest_1.it)('coerces legacy task metadata on reconcile', async () => {
        insertBadEntry('BAD001', JSON.stringify({ task: 1, status: 'done' }));
        insertBadEntry('BAD002', JSON.stringify({ task: 'true', status: 'todo' }));
        insertBadEntry('BAD003', JSON.stringify({ task: 1 }));
        (0, vitest_1.expect)(store.findEntriesWithNonBooleanTask()).toHaveLength(3);
        const result = await store.reconcileMetadataTypes();
        (0, vitest_1.expect)(result).toEqual({ found: 3, updated: 3, skipped: 0 });
        for (const id of ['BAD001', 'BAD002', 'BAD003']) {
            const row = db.prepare('SELECT metadata FROM entries WHERE id = ?').get(id);
            const meta = JSON.parse(row.metadata);
            (0, vitest_1.expect)(meta.task).toBe(true);
            (0, vitest_1.expect)(typeof meta.task).toBe('boolean');
        }
        (0, vitest_1.expect)(store.findEntriesWithNonBooleanTask()).toHaveLength(0);
    });
    (0, vitest_1.it)('dry-run does not write', async () => {
        insertBadEntry('DRY001', JSON.stringify({ task: 1 }));
        const result = await store.reconcileMetadataTypes({ dryRun: true });
        (0, vitest_1.expect)(result).toEqual({ found: 1, updated: 1, skipped: 0 });
        const row = db.prepare('SELECT metadata FROM entries WHERE id = ?').get('DRY001');
        (0, vitest_1.expect)(JSON.parse(row.metadata).task).toBe(1);
    });
});
//# sourceMappingURL=reconcile.test.js.map