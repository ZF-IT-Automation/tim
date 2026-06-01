// TIM Store Schema — v0.1.0-alpha
// SQLite table definitions and migrations.

import Database from 'better-sqlite3';

export const MIGRATIONS: { version: number; sql: string }[] = [
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
  }
];

export function getCurrentVersion(): number {
  return MIGRATIONS[MIGRATIONS.length - 1].version;
}

export function runMigrations(db: Database.Database): void {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Create version table if not exists
  db.exec(`CREATE TABLE IF NOT EXISTS _schema_version (version INTEGER NOT NULL)`);

  const current = db.prepare('SELECT version FROM _schema_version').get() as
    { version: number } | undefined;
  const currentVersion = current?.version ?? 0;

  for (const migration of MIGRATIONS) {
    if (migration.version > currentVersion) {
      db.exec(migration.sql);
    }
  }

  // Update version
  if (current) {
    db.prepare('UPDATE _schema_version SET version = ?').run(getCurrentVersion());
  } else {
    db.prepare('INSERT INTO _schema_version (version) VALUES (?)').run(getCurrentVersion());
  }
}

export function createTriggers(db: Database.Database): void {
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
