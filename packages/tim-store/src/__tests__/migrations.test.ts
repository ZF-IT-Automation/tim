import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import { runMigrations, MIGRATIONS } from '../schema.js';

function tmpDb(): string {
  return `/tmp/tim-mig-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
}

const cleanupPaths: string[] = [];
afterEach(() => {
  for (const p of cleanupPaths.splice(0)) {
    for (const suffix of ['', '-wal', '-shm']) {
      try { fs.unlinkSync(p + suffix); } catch { /* ignore */ }
    }
  }
});

describe('runMigrations', () => {
  it('a failing migration rolls back completely and stays retryable', () => {
    const dbPath = tmpDb();
    cleanupPaths.push(dbPath);
    const db = new Database(dbPath);

    const v1 = { version: 1, sql: 'CREATE TABLE t (id INTEGER PRIMARY KEY);' };
    // v2 does a real ALTER, then fails — the classic brick scenario.
    const v2bad = {
      version: 2,
      sql: 'ALTER TABLE t ADD COLUMN extra TEXT; INSERT INTO nonexistent VALUES (1);',
    };
    const v2good = { version: 2, sql: 'ALTER TABLE t ADD COLUMN extra TEXT;' };

    runMigrations(db, [v1]);
    expect(() => runMigrations(db, [v1, v2bad])).toThrow();

    // Version must still be 1 and the ALTER rolled back — retry must NOT
    // die with "duplicate column name".
    const version = (db.prepare('SELECT version FROM _schema_version').get() as { version: number }).version;
    expect(version).toBe(1);
    expect(() => runMigrations(db, [v1, v2good])).not.toThrow();
    const cols = (db.prepare('PRAGMA table_info(t)').all() as { name: string }[]).map(c => c.name);
    expect(cols).toContain('extra');
    db.close();
  });

  it('creates a backup file before migrating an existing DB', () => {
    const dbPath = tmpDb();
    cleanupPaths.push(dbPath);
    const db = new Database(dbPath);
    runMigrations(db); // fresh DB — full schema, no backup expected
    expect(fs.existsSync(`${dbPath}.pre-migration-v0.bak`)).toBe(false);

    // Simulate an upgrade: rewind version, add a fake future migration.
    db.prepare('UPDATE _schema_version SET version = ?').run(MIGRATIONS.length - 1);
    const future = {
      version: MIGRATIONS[MIGRATIONS.length - 1].version,
      sql: 'CREATE TABLE IF NOT EXISTS mig_probe (id INTEGER);',
    };
    runMigrations(db, [...MIGRATIONS.slice(0, -1), future]);

    const backupPath = `${dbPath}.pre-migration-v${MIGRATIONS.length - 1}.bak`;
    cleanupPaths.push(backupPath);
    expect(fs.existsSync(backupPath)).toBe(true);
    db.close();
  });

  it('skips backup on a fresh (version 0) DB', () => {
    const dbPath = tmpDb();
    cleanupPaths.push(dbPath);
    const db = new Database(dbPath);
    runMigrations(db);
    const backups = fs.readdirSync('/tmp').filter(f => f.startsWith(dbPath.split('/').pop()!) && f.includes('.bak'));
    expect(backups).toEqual([]);
    db.close();
  });
});
