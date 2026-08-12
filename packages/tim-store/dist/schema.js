"use strict";
// TIM Store Schema — v0.1.0-alpha
// SQLite table definitions and migrations.
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SchemaMigrationPendingError = exports.MIGRATIONS = void 0;
exports.getCurrentVersion = getCurrentVersion;
exports.isSchemaMigrationPendingError = isSchemaMigrationPendingError;
exports.runMigrations = runMigrations;
exports.createTriggers = createTriggers;
exports.setStagingEnabled = setStagingEnabled;
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
    {
        version: 11,
        sql: `
      -- Merge duplicate batch-summary nodes (highest seq_to wins) before unique index.
      UPDATE entries SET tombstoned_at = datetime('now'), irrelevant = 1
      WHERE id IN (
        SELECT e.id FROM entries e
        WHERE json_extract(e.metadata, '$.kind') = 'batch-summary'
          AND e.tombstoned_at IS NULL
          AND e.id NOT IN (
            SELECT keep_id FROM (
              SELECT id AS keep_id,
                ROW_NUMBER() OVER (
                  PARTITION BY parent_id,
                    CAST(json_extract(metadata, '$.batch_index') AS INTEGER)
                  ORDER BY CAST(json_extract(metadata, '$.seq_to') AS INTEGER) DESC,
                    rowid DESC
                ) AS rn
              FROM entries
              WHERE json_extract(metadata, '$.kind') = 'batch-summary'
                AND tombstoned_at IS NULL
            ) WHERE rn = 1
          )
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_batch_unique ON entries (
        parent_id,
        CAST(json_extract(metadata, '$.batch_index') AS INTEGER)
      )
      WHERE json_extract(metadata, '$.kind') = 'batch-summary'
        AND tombstoned_at IS NULL;
    `,
    },
    {
        version: 12,
        sql: `
      DROP INDEX IF EXISTS idx_batch_unique;
      CREATE UNIQUE INDEX idx_batch_unique ON entries (
        parent_id,
        CAST(json_extract(metadata, '$.batch_index') AS INTEGER)
      )
      WHERE json_extract(metadata, '$.kind') = 'batch-summary'
        AND tombstoned_at IS NULL
        AND irrelevant = 0;
    `,
    },
    {
        version: 13,
        sql: `
      -- One-time collapse of the duplicate staging records this table
      -- accumulated before the staging_collapse trigger existed. Every
      -- payload is a full snapshot and the merge is LWW, so for an unpushed
      -- key only the newest record can ever matter.
      DELETE FROM staging WHERE acked = 0 AND rowid NOT IN (
        SELECT rowid FROM (
          SELECT rowid, ROW_NUMBER() OVER (
            PARTITION BY key, entity_type
            ORDER BY lww_timestamp DESC, rowid DESC
          ) AS rn
          FROM staging WHERE acked = 0
        ) WHERE rn = 1
      );
    `,
    },
];
function getCurrentVersion() {
    return exports.MIGRATIONS[exports.MIGRATIONS.length - 1].version;
}
/**
 * Thrown when an existing schema is behind this build and the caller did not opt
 * in. Carries the versions so a consumer can render its own message; the `code`
 * tag is what cross-package callers should test — `instanceof` breaks if two
 * copies of tim-store end up loaded.
 */
class SchemaMigrationPendingError extends Error {
    from;
    to;
    pending;
    code = 'SCHEMA_MIGRATION_PENDING';
    constructor(from, to, pending, message) {
        super(message);
        this.from = from;
        this.to = to;
        this.pending = pending;
        this.name = 'SchemaMigrationPendingError';
    }
}
exports.SchemaMigrationPendingError = SchemaMigrationPendingError;
function isSchemaMigrationPendingError(error) {
    return (typeof error === 'object' &&
        error !== null &&
        error.code === 'SCHEMA_MIGRATION_PENDING');
}
function runMigrations(db, migrations = exports.MIGRATIONS, options = {}) {
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    db.pragma('foreign_keys = ON');
    db.exec(`CREATE TABLE IF NOT EXISTS _schema_version (version INTEGER NOT NULL)`);
    const current = db.prepare('SELECT version FROM _schema_version').get();
    const currentVersion = current?.version ?? 0;
    const pending = migrations.filter(m => m.version > currentVersion);
    if (pending.length === 0)
        return null;
    const expectedVersion = migrations[migrations.length - 1].version;
    // Bootstrap (version 0 / fresh / :memory:) always migrates. Pending upgrades
    // on an existing schema require an explicit opt-in.
    if (currentVersion > 0 && options.allowMigrations !== true) {
        const n = pending.length;
        const noun = n === 1 ? 'migration' : 'migrations';
        throw new SchemaMigrationPendingError(currentVersion, expectedVersion, pending.map(m => m.version), `Schema is at v${currentVersion}, this build expects v${expectedVersion}. ` +
            `Run "tim migrate-schema" to apply ${n} pending ${noun}.`);
    }
    const from = currentVersion;
    const backupPath = migrationBackupPath(db, currentVersion);
    backupBeforeMigration(db, currentVersion);
    const applied = [];
    try {
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
            applied.push(migration.version);
        }
    }
    catch (error) {
        if (applied.length > 0) {
            logSchemaMigration(db, { from, to: applied.at(-1), applied });
        }
        throw error;
    }
    const to = applied[applied.length - 1];
    logSchemaMigration(db, { from, to, applied });
    return { from, to, applied, backupPath };
}
function migrationBackupPath(db, fromVersion) {
    if (fromVersion === 0)
        return null;
    const dbPath = db.name;
    if (!dbPath || dbPath === ':memory:')
        return null;
    if (process.env.TIM_SKIP_MIGRATION_BACKUP === '1')
        return null;
    return `${dbPath}.pre-migration-v${fromVersion}.bak`;
}
/** Record an applied migration in error_log (tool=schema_migration). Spec chose this table. */
function logSchemaMigration(db, info) {
    try {
        const dbPath = db.memory ? ':memory:' : db.name;
        db.prepare(`
      INSERT INTO error_log (timestamp, tool, args_json, error, stack, session_id)
      VALUES (?, 'schema_migration', ?, '', NULL, NULL)
    `).run(new Date().toISOString(), JSON.stringify({ from: info.from, to: info.to, applied: info.applied, db: dbPath }));
    }
    catch {
        // Never let migration logging itself brick a successful migrate.
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
    // FTS5 sync triggers — skip secret entries (metadata.secret=true)
    db.exec(`
    DROP TRIGGER IF EXISTS entries_ai;
    DROP TRIGGER IF EXISTS entries_ad;
    DROP TRIGGER IF EXISTS entries_au;
    DROP TRIGGER IF EXISTS entries_au_del;
    DROP TRIGGER IF EXISTS entries_au_ins;

    CREATE TRIGGER entries_ai AFTER INSERT ON entries
    WHEN json_extract(new.metadata,'$.secret') IS NULL OR json_extract(new.metadata,'$.secret')=0
    BEGIN
      INSERT INTO fts_entries(rowid, title, content, tags)
      VALUES (new.rowid, new.title, new.content, new.tags);
    END;

    CREATE TRIGGER entries_ad AFTER DELETE ON entries
    WHEN json_extract(old.metadata,'$.secret') IS NULL OR json_extract(old.metadata,'$.secret')=0
    BEGIN
      INSERT INTO fts_entries(fts_entries, rowid, title, content, tags)
      VALUES ('delete', old.rowid, old.title, old.content, old.tags);
    END;

    CREATE TRIGGER entries_au AFTER UPDATE ON entries BEGIN
      INSERT INTO fts_entries(fts_entries, rowid, title, content, tags)
      SELECT 'delete', old.rowid, old.title, old.content, old.tags
      WHERE json_extract(old.metadata,'$.secret') IS NULL OR json_extract(old.metadata,'$.secret')=0;
      INSERT INTO fts_entries(rowid, title, content, tags)
      SELECT new.rowid, new.title, new.content, new.tags
      WHERE json_extract(new.metadata,'$.secret') IS NULL OR json_extract(new.metadata,'$.secret')=0;
    END;
  `);
    // Keep at most one unpushed staging record per object. The payload is a
    // full snapshot and the merge is last-writer-wins, so an older unacked
    // record for the same key is dead weight the moment a newer one is staged.
    // Acked records are left alone (gcStaging collects those), and a record
    // that arrives out of order with an older timestamp evicts nothing.
    db.exec(`
    DROP TRIGGER IF EXISTS staging_collapse;

    CREATE TRIGGER staging_collapse AFTER INSERT ON staging BEGIN
      DELETE FROM staging
       WHERE key = new.key
         AND entity_type = new.entity_type
         AND acked = 0
         AND rowid <> new.rowid
         AND lww_timestamp <= new.lww_timestamp;
    END;
  `);
}
/**
 * Turn the sync outbox on or off for this database.
 *
 * Off is enforced by a trigger rather than by a flag at each write, because
 * thirteen call sites across four packages stage rows and every one of them
 * would have to remember the check. The trigger fires only for `acked = 0`, so
 * an inbound record being applied locally is never swallowed — only the outbox
 * inserts a local change writes for itself.
 *
 * The state is idempotent: a store that opens a database already in the wanted
 * state touches no schema at all.
 */
function setStagingEnabled(db, enabled) {
    const present = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'staging_disabled'").get() !== undefined;
    if (present === !enabled)
        return;
    if (enabled) {
        db.exec('DROP TRIGGER IF EXISTS staging_disabled;');
        return;
    }
    db.exec(`
    CREATE TRIGGER staging_disabled BEFORE INSERT ON staging
    WHEN new.acked = 0
    BEGIN
      SELECT RAISE(IGNORE);
    END;
  `);
}
//# sourceMappingURL=schema.js.map