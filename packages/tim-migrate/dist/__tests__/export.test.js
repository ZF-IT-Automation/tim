"use strict";
// Export tests
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
const export_js_1 = require("../export.js");
const import_js_1 = require("../import.js");
const hmem_format_js_1 = require("../hmem-format.js");
let store;
let tmpDir;
(0, vitest_1.beforeEach)(() => {
    store = new tim_store_1.TimStore(':memory:');
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-export-test-'));
});
(0, vitest_1.afterEach)(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
});
(0, vitest_1.describe)('tim_export', () => {
    (0, vitest_1.it)('exports hierarchical markdown with headings, tags, and related links', async () => {
        const root = await store.write('Project Alpha', {
            tags: ['#project'],
            metadata: { label: 'P0001', prefix: 'P', seq: 1 },
        });
        await store.write('Overview detail', { parentId: root.id });
        const other = await store.write('Related entry', {
            metadata: { label: 'L0002', prefix: 'L', seq: 2 },
        });
        await store.link(root.id, other.id, 'relates');
        const md = (0, export_js_1.exportToMarkdown)(store);
        (0, vitest_1.expect)(md).toContain('# Project Alpha #project');
        (0, vitest_1.expect)(md).toContain('## Overview detail');
        (0, vitest_1.expect)(md).toContain('Related: [L0002]');
        (0, vitest_1.expect)(md).toContain('Entries: 3');
    });
    (0, vitest_1.it)('exports to hmem v2 sqlite with entries, nodes, and links', async () => {
        const root = await store.write('Root content', {
            metadata: { label: 'P0001', prefix: 'P', seq: 1 },
        });
        const child = await store.write('Child content', { parentId: root.id });
        const target = await store.write('Target', {
            metadata: { label: 'L0001', prefix: 'L', seq: 1 },
        });
        await store.link(root.id, target.id, 'relates');
        const outPath = path.join(tmpDir, 'export.hmem');
        const result = (0, export_js_1.tim_export)(store, outPath, { format: 'hmem' });
        (0, vitest_1.expect)(result).toMatchObject({
            targetPath: outPath,
            entriesExported: 2,
            nodesExported: 1,
            linksExported: 1,
        });
        const db = new better_sqlite3_1.default(outPath, { readonly: true });
        (0, vitest_1.expect)((0, hmem_format_js_1.detectHmemFormat)(db)).toBe('v2');
        const entry = db.prepare('SELECT * FROM entries WHERE uid = ?').get(root.id);
        (0, vitest_1.expect)(entry.label).toBe('P0001');
        (0, vitest_1.expect)(entry.level_1).toBe('Root content');
        const node = db.prepare('SELECT * FROM nodes WHERE uid = ?').get(child.id);
        (0, vitest_1.expect)(node.root_uid).toBe(root.id);
        (0, vitest_1.expect)(node.content).toBe('Child content');
        const link = db.prepare('SELECT * FROM links WHERE src_uid = ?').get(root.id);
        (0, vitest_1.expect)(link.dst_uid).toBe(target.id);
        (0, vitest_1.expect)(link.kind).toBe('relates');
        db.close();
    });
    (0, vitest_1.it)('roundtrips export → import into fresh DB with identical structure', async () => {
        const root = await store.write('Roundtrip root', {
            metadata: { label: 'P0099', prefix: 'P', seq: 99 },
            tags: ['#test'],
        });
        const child = await store.write('Roundtrip child', {
            parentId: root.id,
            tags: ['#child'],
        });
        const other = await store.write('Other root', {
            metadata: { label: 'L0001', prefix: 'L', seq: 1 },
        });
        await store.link(root.id, other.id, 'implements');
        const outPath = path.join(tmpDir, 'roundtrip.hmem');
        (0, export_js_1.tim_export)(store, outPath, { format: 'hmem' });
        const freshPath = path.join(tmpDir, 'fresh.db');
        const fresh = new tim_store_1.TimStore(freshPath);
        try {
            const report = (0, import_js_1.tim_import)(fresh, outPath);
            (0, vitest_1.expect)(report.entriesImported).toBe(2);
            (0, vitest_1.expect)(report.nodesImported).toBe(1);
            (0, vitest_1.expect)(report.edgesImported).toBe(1);
            const importedRoot = await fresh.read(root.id);
            (0, vitest_1.expect)(importedRoot).not.toBeNull();
            (0, vitest_1.expect)(importedRoot.title).toBe('Roundtrip root');
            (0, vitest_1.expect)(importedRoot.metadata.label).toBe('P0099');
            (0, vitest_1.expect)(importedRoot.tags).toEqual(['#test']);
            const children = await fresh.getChildren(root.id);
            (0, vitest_1.expect)(children).toHaveLength(1);
            (0, vitest_1.expect)(children[0].title).toBe('Roundtrip child');
            (0, vitest_1.expect)(children[0].tags).toEqual(['#child']);
            const edges = await fresh.getEdges(root.id, 'outgoing');
            (0, vitest_1.expect)(edges).toHaveLength(1);
            (0, vitest_1.expect)(edges[0].type).toBe('implements');
            (0, vitest_1.expect)(edges[0].targetId).toBe(other.id);
        }
        finally {
            fresh.close();
        }
    });
    (0, vitest_1.it)('respects entryFilter and includes ancestors', async () => {
        const root = await store.write('Keep root', {
            metadata: { label: 'P0001', prefix: 'P', seq: 1 },
        });
        await store.write('Keep child', { parentId: root.id });
        await store.write('Skip root', {
            metadata: { label: 'P0002', prefix: 'P', seq: 2 },
        });
        const outPath = path.join(tmpDir, 'filtered.hmem');
        const result = (0, export_js_1.tim_export)(store, outPath, {
            format: 'hmem',
            entryFilter: e => e.metadata.label === 'P0001' ||
                e.parentId !== null && e.title === 'Keep child',
        });
        (0, vitest_1.expect)(result).toMatchObject({ entriesExported: 1, nodesExported: 1 });
        const db = new better_sqlite3_1.default(outPath, { readonly: true });
        const count = db.prepare('SELECT COUNT(*) as c FROM entries').get().c;
        (0, vitest_1.expect)(count).toBe(1);
        db.close();
    });
});
//# sourceMappingURL=export.test.js.map