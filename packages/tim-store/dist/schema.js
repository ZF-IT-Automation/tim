"use strict";
// TIM Store Schema — v0.1.0-alpha
// SQLite table definitions and migrations.
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MIGRATIONS = void 0;
exports.getCurrentVersion = getCurrentVersion;
exports.runMigrations = runMigrations;
exports.createTriggers = createTriggers;
const node_fs_1 = __importDefault(require("node:fs"));
exports.MIGRATIONS = [
    {
        version: 1,
        sql: `
      CREATE TABLE IF NOT EXISTS entries (
        id TEXT PRIMARY KEY,
        parent_id TEXT,
        content TEXT NOT NULL,
        content_type TEXT NOT NULL DEFAULT 'text',
        depth INTEGER NOT NULL DEFAULT 1,
        confidence REAL NOT NULL DEFAULT 1.0,
        created_at TEXT NOT NULL,
        accessed_at TEXT NOT NULL,
        decay_rate REAL NOT NULL DEFAULT 0.0,
        visibility INTEGER NOT NULL DEFAULT 1,
        tags TEXT NOT NULL DEFAULT '[]',
        irrelevant INTEGER NOT NULL DEFAULT 0,
        tombstoned_at TEXT,
        metadata TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS edges (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'relates',
        weight REAL NOT NULL DEFAULT 1.0,
        metadata TEXT NOT NULL DEFAULT '{}',
        FOREIGN KEY (source_id) REFERENCES entries(id) ON DELETE CASCADE,
        FOREIGN KEY (target_id) REFERENCES entries(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS staging (
        rowid INTEGER PRIMARY KEY AUTOINCREMENT,
        key TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        operation TEXT NOT NULL,
        payload TEXT NOT NULL,
        lww_timestamp INTEGER NOT NULL,
        lww_device TEXT NOT NULL,
        lww_confidence REAL NOT NULL DEFAULT 1.0,
        acked INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS suppressed (
        pattern TEXT NOT NULL,
        reason TEXT,
        suppressed_at TEXT NOT NULL,
        suppressed_by TEXT NOT NULL,
        expires_at TEXT
      );

      CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        label TEXT NOT NULL UNIQUE,
        registered_at TEXT NOT NULL,
        visibility_mask INTEGER NOT NULL DEFAULT 1
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS fts_entries USING fts5(
        title, content, tags,
        content='entries', content_rowid='rowid'
      );

      CREATE INDEX IF NOT EXISTS idx_entries_parent ON entries(parent_id);
      CREATE INDEX IF NOT EXISTS idx_entries_accessed ON entries(accessed_at);
      CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id);
      CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);
      CREATE INDEX IF NOT EXISTS idx_staging_key ON staging(key);
      CREATE INDEX IF NOT EXISTS idx_staging_acked ON staging(acked, lww_timestamp);
    `
    },
    {
        version: 2,
        sql: `
      ALTER TABLE entries ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0;
    `
    },
    {
        version: 3,
        sql: `
      ALTER TABLE entries ADD COLUMN title TEXT NOT NULL DEFAULT '';

      UPDATE entries SET
        title = CASE
          WHEN instr(content, char(10)) > 0 THEN trim(substr(content, 1, instr(content, char(10)) - 1))
          ELSE trim(content)
        END,
        content = CASE
          WHEN instr(content, char(10)) > 0 THEN trim(substr(content, instr(content, char(10)) + 1))
          ELSE ''
        END;
    `
    },
    {
        version: 4,
        sql: `
      DROP TRIGGER IF EXISTS entries_ai;
      DROP TRIGGER IF EXISTS entries_ad;
      DROP TRIGGER IF EXISTS entries_au;
      DROP TABLE IF EXISTS fts_entries;

      CREATE VIRTUAL TABLE fts_entries USING fts5(
        title, content, tags,
        content='entries', content_rowid='rowid'
      );

      INSERT INTO fts_entries(rowid, title, content, tags)
      SELECT rowid, title, content, tags FROM entries;
    `
    },
    {
        version: 5,
        sql: `
      CREATE TABLE IF NOT EXISTS error_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        tool TEXT NOT NULL,
        args_json TEXT NOT NULL DEFAULT '{}',
        error TEXT NOT NULL DEFAULT '',
        stack TEXT,
        session_id TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_error_log_timestamp ON error_log(timestamp);
      CREATE INDEX IF NOT EXISTS idx_error_log_tool ON error_log(tool);
    `
    },
    {
        version: 6,
        sql: `
      CREATE INDEX IF NOT EXISTS idx_entries_meta_kind
        ON entries(json_extract(metadata, '$.kind'));

      CREATE INDEX IF NOT EXISTS idx_entries_meta_label
        ON entries(json_extract(metadata, '$.label'));

      CREATE INDEX IF NOT EXISTS idx_staging_lww
        ON staging(lww_timestamp);

      DELETE FROM staging WHERE acked = 1;
    `
    },
    {
        version: 7,
        sql: `
      ALTER TABLE entries ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';
      UPDATE entries SET updated_at = created_at;

      ALTER TABLE edges ADD COLUMN updated_at TEXT NOT NULL DEFAULT '';
      UPDATE edges SET updated_at = COALESCE(
        (SELECT datetime(s.lww_timestamp / 1000, 'unixepoch')
         FROM staging s
         WHERE s.entity_type = 'edge'
           AND s.key = (edges.source_id || '|' || edges.target_id || '|' || edges.type)
         ORDER BY s.lww_timestamp DESC
         LIMIT 1),
        datetime('now')
      );
    `
    },
    {
        version: 8,
        sql: `
      -- Device-local retrieval feedback. Deliberately NOT synced: usage is
      -- a per-device relevance signal, so no staging rows are ever written
      -- for it and it is excluded from export.
      CREATE TABLE IF NOT EXISTS entry_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entry_id TEXT NOT NULL,
        session_id TEXT,
        read_at TEXT NOT NULL,
        referenced INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_usage_entry ON entry_usage(entry_id, referenced);
      CREATE INDEX IF NOT EXISTS idx_usage_session ON entry_usage(session_id);
      CREATE INDEX IF NOT EXISTS idx_usage_read_at ON entry_usage(read_at);
    `
    },
    {
        version: 9,
        sql: `ALTER TABLE entries ADD COLUMN lww_device TEXT NOT NULL DEFAULT 'local';`,
    },
    {
        version: 10,
        sql: `
      -- Device-local embedding vectors. Each device computes its own;
      -- vectors are NEVER synced, staged, or exported (same contract
      -- as entry_usage in Plan 10).
      CREATE TABLE IF NOT EXISTS entry_vectors (
        entry_id TEXT PRIMARY KEY,
        model TEXT NOT NULL,
        vector BLOB NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_entry_vectors_model ON entry_vectors(model);
    `
    },
];
function getCurrentVersion() {
    return exports.MIGRATIONS[exports.MIGRATIONS.length - 1].version;
}
function runMigrations(db, migrations = exports.MIGRATIONS) {
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    db.pragma('foreign_keys = ON');
    db.exec(`CREATE TABLE IF NOT EXISTS _schema_version (version INTEGER NOT NULL)`);
    const current = db.prepare('SELECT version FROM _schema_version').get();
    const currentVersion = current?.version ?? 0;
    const pending = migrations.filter(m => m.version > currentVersion);
    if (pending.length === 0)
        return;
    backupBeforeMigration(db, currentVersion);
    for (const migration of pending) {
        // One transaction per migration: SQLite DDL is transactional, so a crash
        // or SQL error rolls back both the DDL and the version bump — the DB
        // stays at the previous version and the migration is safely retryable.
        db.transaction(() => {
            db.exec(migration.sql);
            const row = db.prepare('SELECT version FROM _schema_version').get();
            if (row) {
                db.prepare('UPDATE _schema_version SET version = ?').run(migration.version);
            }
            else {
                db.prepare('INSERT INTO _schema_version (version) VALUES (?)').run(migration.version);
            }
        })();
    }
}
function backupBeforeMigration(db, fromVersion) {
    // Fresh DB (version 0) has nothing to lose; in-memory DBs have no file.
    if (fromVersion === 0)
        return;
    const dbPath = db.name;
    if (!dbPath || dbPath === ':memory:')
        return;
    if (process.env.TIM_SKIP_MIGRATION_BACKUP === '1')
        return;
    const backupPath = `${dbPath}.pre-migration-v${fromVersion}.bak`;
    try {
        // Fold WAL into the main file so the copy is complete on its own.
        db.pragma('wal_checkpoint(TRUNCATE)');
        node_fs_1.default.copyFileSync(dbPath, backupPath);
    }
    catch (err) {
        throw new Error(`Pre-migration backup failed (${backupPath}): ${err.message}. ` +
            'Refusing to migrate without a backup. Set TIM_SKIP_MIGRATION_BACKUP=1 to override.');
    }
}
function createTriggers(db) {
    // FTS5 sync triggers — keep FTS index in sync with entries table
    db.exec(`
    CREATE TRIGGER IF NOT EXISTS entries_ai AFTER INSERT ON entries BEGIN
      INSERT INTO fts_entries(rowid, title, content, tags)
      VALUES (new.rowid, new.title, new.content, new.tags);
    END;

    CREATE TRIGGER IF NOT EXISTS entries_ad AFTER DELETE ON entries BEGIN
      INSERT INTO fts_entries(fts_entries, rowid, title, content, tags)
      VALUES ('delete', old.rowid, old.title, old.content, old.tags);
    END;

    CREATE TRIGGER IF NOT EXISTS entries_au AFTER UPDATE ON entries BEGIN
      INSERT INTO fts_entries(fts_entries, rowid, title, content, tags)
      VALUES ('delete', old.rowid, old.title, old.content, old.tags);
      INSERT INTO fts_entries(rowid, title, content, tags)
      VALUES (new.rowid, new.title, new.content, new.tags);
    END;
  `);
}
//# sourceMappingURL=schema.js.map