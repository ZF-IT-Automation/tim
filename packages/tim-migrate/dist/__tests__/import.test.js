"use strict";
// Import tests
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
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const tim_store_1 = require("tim-store");
const import_js_1 = require("../import.js");
const hmem_format_js_1 = require("../hmem-format.js");
let store;
let tmpDir;
(0, vitest_1.beforeEach)(() => {
    store = new tim_store_1.TimStore(':memory:');
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-import-test-'));
});
(0, vitest_1.afterEach)(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
});
function createV2Fixture(filePath) {
    const db = (0, hmem_format_js_1.createV2HmemDatabase)(filePath);
    const rootUid = '01ROOT00000000000000000001';
    const childUid = '01CHILD0000000000000000001';
    const otherUid = '01OTHER0000000000000000001';
    db.prepare(`
    INSERT INTO entries (uid, label, prefix, seq, level_1, created_at, updated_at,
      access_count, obsolete, favorite, irrelevant, pinned, tags)
    VALUES (?, 'P0001', 'P', 1, 'Imported root', '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z',
      0, 0, 1, 0, 0, '["#project"]')
  `).run(rootUid);
    db.prepare(`
    INSERT INTO entries (uid, label, prefix, seq, level_1, created_at, updated_at,
      access_count, obsolete, favorite, irrelevant, pinned, tags)
    VALUES (?, 'L0001', 'L', 1, 'Other root', '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z',
      0, 0, 0, 0, 0, '[]')
  `).run(otherUid);
    db.prepare(`
    INSERT INTO nodes (uid, root_uid, parent_uid, depth, seq, content, tags,
      created_at, updated_at, irrelevant)
    VALUES (?, ?, NULL, 2, 1, 'Imported child', '["#detail"]',
      '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z', 0)
  `).run(childUid, rootUid);
    db.prepare(`
    INSERT INTO links (src_uid, dst_uid, kind) VALUES (?, ?, 'relates')
  `).run(rootUid, otherUid);
    db.close();
    return { rootUid, childUid };
}
function createOldFixture(filePath) {
    const db = new better_sqlite3_1.default(filePath);
    db.exec(`
    CREATE TABLE memories (
      id TEXT PRIMARY KEY,
      prefix TEXT NOT NULL,
      seq INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      level_1 TEXT NOT NULL,
      level_2 TEXT,
      level_3 TEXT,
      level_4 TEXT,
      level_5 TEXT,
      last_accessed TEXT,
      links TEXT,
      obsolete INTEGER DEFAULT 0,
      favorite INTEGER DEFAULT 0,
      irrelevant INTEGER DEFAULT 0,
      pinned INTEGER DEFAULT 0,
      updated_at TEXT
    );
  `);
    db.prepare(`
    INSERT INTO memories (id, prefix, seq, created_at, level_1, level_2, links, favorite)
    VALUES ('P0042', 'P', 42, '2026-01-01T00:00:00Z', 'Old root', 'Old child', '["L0001"]', 1)
  `).run();
    db.prepare(`
    INSERT INTO memories (id, prefix, seq, created_at, level_1)
    VALUES ('L0001', 'L', 1, '2026-01-01T00:00:00Z', 'Link target')
  `).run();
    db.close();
}
(0, vitest_1.describe)('tim_import', () => {
    (0, vitest_1.it)('imports v2 hmem with entries, nodes, and links', () => {
        const filePath = path.join(tmpDir, 'v2.hmem');
        const { rootUid, childUid } = createV2Fixture(filePath);
        const report = (0, import_js_1.tim_import)(store, filePath);
        (0, vitest_1.expect)(report.format).toBe('v2');
        (0, vitest_1.expect)(report.entriesImported).toBe(2);
        (0, vitest_1.expect)(report.nodesImported).toBe(1);
        (0, vitest_1.expect)(report.edgesImported).toBe(1);
        const root = store.getDb().prepare('SELECT * FROM entries WHERE id = ?').get(rootUid);
        (0, vitest_1.expect)(root.content).toBe('Imported root');
        const meta = JSON.parse(root.metadata);
        (0, vitest_1.expect)(meta.label).toBe('P0001');
        (0, vitest_1.expect)(meta.hmemUid).toBe(rootUid);
        const child = store.getDb().prepare('SELECT * FROM entries WHERE id = ?').get(childUid);
        (0, vitest_1.expect)(child.parent_id).toBe(rootUid);
        (0, vitest_1.expect)(child.content).toBe('Imported child');
    });
    (0, vitest_1.it)('imports old hmem format with level hierarchy and links', () => {
        const filePath = path.join(tmpDir, 'old.hmem');
        createOldFixture(filePath);
        const report = (0, import_js_1.tim_import)(store, filePath);
        (0, vitest_1.expect)(report.format).toBe('old');
        (0, vitest_1.expect)(report.entriesImported).toBe(2);
        (0, vitest_1.expect)(report.nodesImported).toBe(1);
        (0, vitest_1.expect)(report.edgesImported).toBe(1);
        const root = store.getDb().prepare("SELECT id FROM entries WHERE json_extract(metadata, '$.label') = 'P0042'").get();
        (0, vitest_1.expect)(root.id).toBe('P0042');
        const children = store.getDb().prepare('SELECT content FROM entries WHERE parent_id = ?').all(root.id);
        (0, vitest_1.expect)(children[0].content).toBe('Old child');
    });
    (0, vitest_1.it)('dry run reports counts without writing', async () => {
        const filePath = path.join(tmpDir, 'dry.hmem');
        createV2Fixture(filePath);
        const before = store.getDb().prepare('SELECT COUNT(*) as c FROM entries').get().c;
        const report = (0, import_js_1.tim_import)(store, filePath, { dryRun: true });
        (0, vitest_1.expect)(report.dryRun).toBe(true);
        (0, vitest_1.expect)(report.newCount).toBeGreaterThan(0);
        const after = store.getDb().prepare('SELECT COUNT(*) as c FROM entries').get().c;
        (0, vitest_1.expect)(after).toBe(before);
    });
    (0, vitest_1.it)('deduplicates by label and merges instead of creating duplicate roots', async () => {
        await store.write('Existing', {
            metadata: { label: 'P0001', prefix: 'P', seq: 1 },
        });
        const filePath = path.join(tmpDir, 'dedup.hmem');
        createV2Fixture(filePath);
        const report = (0, import_js_1.tim_import)(store, filePath, { deduplicate: true });
        (0, vitest_1.expect)(report.conflicts.some(c => c.label === 'P0001' && c.action === 'merged')).toBe(true);
        const roots = store.getDb().prepare("SELECT id FROM entries WHERE parent_id IS NULL AND json_extract(metadata, '$.label') = 'P0001'").all();
        (0, vitest_1.expect)(roots).toHaveLength(1);
    });
    (0, vitest_1.it)('remaps IDs on collision when deduplicate is false', async () => {
        const filePath = path.join(tmpDir, 'remap.hmem');
        const { rootUid } = createV2Fixture(filePath);
        await store.write('Pre-existing with same id', { id: rootUid });
        const report = (0, import_js_1.tim_import)(store, filePath, { deduplicate: false });
        (0, vitest_1.expect)(report.remapped).toBeGreaterThan(0);
        (0, vitest_1.expect)(report.conflicts.some(c => c.action === 'remapped')).toBe(true);
        const imported = store.getDb().prepare("SELECT id FROM entries WHERE json_extract(metadata, '$.label') = 'P0001'").get();
        (0, vitest_1.expect)(imported.id).not.toBe(rootUid);
    });
});
//# sourceMappingURL=import.test.js.map