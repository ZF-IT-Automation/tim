"use strict";
// hmem format detection and v2 schema DDL
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
exports.detectHmemFormat = detectHmemFormat;
exports.inspectHmemFile = inspectHmemFile;
exports.inspectHmemManifest = inspectHmemManifest;
exports.createV2HmemDatabase = createV2HmemDatabase;
exports.parseLabel = parseLabel;
exports.formatLabel = formatLabel;
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
function detectHmemFormat(db) {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    const names = new Set(tables.map(t => t.name));
    if (names.has('entries')) {
        const cols = db.prepare('PRAGMA table_info(entries)').all()
            .map(c => c.name);
        if (cols.includes('uid') && cols.includes('label'))
            return 'v2';
    }
    if (names.has('memories')) {
        const cols = db.prepare('PRAGMA table_info(memories)').all()
            .map(c => c.name);
        if (cols.includes('prefix') && cols.includes('seq'))
            return 'old';
    }
    return 'unknown';
}
function inspectHmemFile(sourcePath) {
    try {
        const db = new better_sqlite3_1.default(sourcePath, { readonly: true });
        const format = detectHmemFormat(db);
        let entryCount = 0;
        if (format === 'v2') {
            entryCount = db.prepare('SELECT COUNT(*) as c FROM entries WHERE deleted_at IS NULL').get().c;
        }
        else if (format === 'old') {
            entryCount = db.prepare('SELECT COUNT(*) as c FROM memories').get().c;
        }
        db.close();
        return { format, entryCount };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { format: 'unknown', entryCount: 0, error: message };
    }
}
function titleFromContent(content) {
    return content.split(/\r?\n/, 1)[0]?.trim() || content.trim();
}
function inspectHmemManifest(sourcePath) {
    try {
        const db = new better_sqlite3_1.default(sourcePath, { readonly: true });
        try {
            const format = detectHmemFormat(db);
            if (format === 'v2') {
                const rows = db.prepare(`
          SELECT e.label, e.prefix, e.seq, e.level_1,
                 COUNT(n.uid) AS nodeCount
          FROM entries e
          LEFT JOIN nodes n ON n.root_uid = e.uid AND n.deleted_at IS NULL
          WHERE e.deleted_at IS NULL
          GROUP BY e.uid
          ORDER BY e.prefix ASC, e.seq ASC
        `).all();
                return {
                    format,
                    entryCount: rows.length,
                    labels: rows.map(row => ({
                        label: row.label,
                        prefix: row.prefix,
                        seq: row.seq,
                        title: titleFromContent(row.level_1),
                        nodeCount: row.nodeCount,
                    })),
                };
            }
            if (format === 'old') {
                const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
                    .map(t => t.name));
                const nodeCounts = new Map();
                if (tables.has('memory_nodes')) {
                    const rows = db.prepare(`
            SELECT root_id, COUNT(*) AS nodeCount
            FROM memory_nodes
            GROUP BY root_id
          `).all();
                    for (const row of rows)
                        nodeCounts.set(row.root_id, row.nodeCount);
                }
                const rows = db.prepare(`
          SELECT id, prefix, seq, level_1, level_2, level_3, level_4, level_5
          FROM memories
          ORDER BY prefix ASC, seq ASC
        `).all();
                return {
                    format,
                    entryCount: rows.length,
                    labels: rows.map(row => ({
                        label: row.id,
                        prefix: row.prefix,
                        seq: row.seq,
                        title: titleFromContent(row.level_1),
                        nodeCount: nodeCounts.get(row.id) ??
                            [row.level_2, row.level_3, row.level_4, row.level_5]
                                .filter(v => typeof v === 'string' && v.trim().length > 0).length,
                    })),
                };
            }
            return { format, entryCount: 0, labels: [] };
        }
        finally {
            db.close();
        }
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { format: 'unknown', entryCount: 0, labels: [], error: message };
    }
}
const V2_SCHEMA = `
CREATE TABLE entries (
  uid           TEXT PRIMARY KEY,
  label         TEXT NOT NULL,
  prefix        TEXT NOT NULL,
  seq           INTEGER NOT NULL,
  level_1       TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  access_count  INTEGER NOT NULL DEFAULT 0,
  last_accessed TEXT,
  obsolete      INTEGER NOT NULL DEFAULT 0,
  favorite      INTEGER NOT NULL DEFAULT 0,
  irrelevant    INTEGER NOT NULL DEFAULT 0,
  pinned        INTEGER NOT NULL DEFAULT 0,
  tags          TEXT,
  deleted_at    TEXT
);
CREATE UNIQUE INDEX idx_entries_label ON entries(label) WHERE deleted_at IS NULL;
CREATE INDEX idx_entries_prefix ON entries(prefix);

CREATE TABLE nodes (
  uid        TEXT PRIMARY KEY,
  root_uid   TEXT NOT NULL,
  parent_uid TEXT,
  depth      INTEGER NOT NULL,
  seq        INTEGER NOT NULL,
  content    TEXT NOT NULL,
  tags       TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  irrelevant INTEGER NOT NULL DEFAULT 0,
  deleted_at TEXT
);
CREATE INDEX idx_nodes_root ON nodes(root_uid);
CREATE INDEX idx_nodes_parent ON nodes(parent_uid);

CREATE TABLE links (
  src_uid TEXT NOT NULL,
  dst_uid TEXT NOT NULL,
  kind    TEXT,
  PRIMARY KEY (src_uid, dst_uid)
);

CREATE TABLE schema_version (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE VIRTUAL TABLE fts USING fts5(level_1, node_content, content='', contentless_delete=1, tokenize='unicode61');

CREATE TABLE fts_rowid_map (
  fts_rowid INTEGER PRIMARY KEY,
  root_uid  TEXT NOT NULL,
  node_uid  TEXT
);
CREATE INDEX idx_fts_rm_root ON fts_rowid_map(root_uid);
CREATE INDEX idx_fts_rm_node ON fts_rowid_map(node_uid);

CREATE TRIGGER fts_entry_ai AFTER INSERT ON entries BEGIN
  INSERT INTO fts(level_1, node_content) VALUES (coalesce(new.level_1, ''), '');
  INSERT INTO fts_rowid_map(fts_rowid, root_uid, node_uid) VALUES (last_insert_rowid(), new.uid, NULL);
END;
CREATE TRIGGER fts_node_ai AFTER INSERT ON nodes BEGIN
  INSERT INTO fts(level_1, node_content) VALUES ('', coalesce(new.content, ''));
  INSERT INTO fts_rowid_map(fts_rowid, root_uid, node_uid) VALUES (last_insert_rowid(), new.root_uid, new.uid);
END;
CREATE TRIGGER fts_entry_au AFTER UPDATE OF level_1 ON entries BEGIN
  DELETE FROM fts WHERE rowid = (SELECT fts_rowid FROM fts_rowid_map WHERE root_uid = old.uid AND node_uid IS NULL);
  INSERT INTO fts(level_1, node_content) VALUES (coalesce(new.level_1, ''), '');
  UPDATE fts_rowid_map SET fts_rowid = last_insert_rowid() WHERE root_uid = new.uid AND node_uid IS NULL;
END;
CREATE TRIGGER fts_node_au AFTER UPDATE OF content ON nodes BEGIN
  DELETE FROM fts WHERE rowid = (SELECT fts_rowid FROM fts_rowid_map WHERE node_uid = old.uid);
  INSERT INTO fts(level_1, node_content) VALUES ('', coalesce(new.content, ''));
  UPDATE fts_rowid_map SET fts_rowid = last_insert_rowid() WHERE node_uid = new.uid;
END;
CREATE TRIGGER fts_entry_bd BEFORE DELETE ON entries BEGIN
  DELETE FROM fts WHERE rowid = (SELECT fts_rowid FROM fts_rowid_map WHERE root_uid = old.uid AND node_uid IS NULL);
  DELETE FROM fts_rowid_map WHERE root_uid = old.uid;
END;
CREATE TRIGGER fts_node_bd BEFORE DELETE ON nodes BEGIN
  DELETE FROM fts WHERE rowid = (SELECT fts_rowid FROM fts_rowid_map WHERE node_uid = old.uid);
  DELETE FROM fts_rowid_map WHERE node_uid = old.uid;
END;
`;
function createV2HmemDatabase(targetPath) {
    if (fs.existsSync(targetPath)) {
        fs.unlinkSync(targetPath);
    }
    const dir = path.dirname(targetPath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    const db = new better_sqlite3_1.default(targetPath);
    db.exec(V2_SCHEMA);
    db.prepare("INSERT INTO schema_version (key, value) VALUES ('schema_major', '2')").run();
    return db;
}
function parseLabel(label) {
    const match = label.match(/^([A-Z])(\d{4})$/);
    if (!match)
        return null;
    return { prefix: match[1], seq: parseInt(match[2], 10) };
}
function formatLabel(prefix, seq) {
    return `${prefix}${seq.toString().padStart(4, '0')}`;
}
//# sourceMappingURL=hmem-format.js.map