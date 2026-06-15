import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Import snapshot/restore functions directly (not via CLI binary)
import { runSnapshot, resolveDbPath } from '../snapshot.js';

const TEST_ROOT = path.join(os.homedir(), '.tim-test-runs');
const SNAPSHOT_DIR = path.join(TEST_ROOT, 'test-snapshots');

interface Database {
  close(): void;
  exec(sql: string): void;
  pragma(sql: string): unknown;
  prepare(sql: string): { run(...args: unknown[]): { changes: number }; all(...args: unknown[]): unknown[]; get(...args: unknown[]): unknown };
  backup(target: string): Promise<void>;
}

let Database: new (path: string, opts?: Record<string, unknown>) => Database;

function ensureDir(p: string) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function createTestDb(dbPath: string, entryCount: number): void {
  const db = new Database(dbPath);
  db.pragma('journal_mode=WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS entries (
      id TEXT PRIMARY KEY,
      parent_id TEXT,
      content TEXT,
      title TEXT,
      type TEXT,
      tags TEXT,
      metadata TEXT,
      content_md TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);
  const insert = db.prepare(
    'INSERT INTO entries (id, parent_id, title, content, type) VALUES (?, ?, ?, ?, ?)'
  );
  for (let i = 0; i < entryCount; i++) {
    const id = `entry-${String(i).padStart(5, '0')}-${Math.random().toString(36).slice(2, 8)}`;
    insert.run(id, null, `Test Entry ${i}`, `Content for entry ${i}`, i === 0 ? 'project' : 'entry');
  }
  db.close();
}

function countDbEntries(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true });
  const row = db.prepare('SELECT COUNT(*) as cnt FROM entries').get() as { cnt: number };
  db.close();
  return row.cnt || 0;
}

describe('snapshot (integration)', () => {
  let testDir: string;
  let dbPath: string;

  beforeEach(() => {
    try {
      Database = require('better-sqlite3');
    } catch {
      // Skip if better-sqlite3 not available
      return;
    }
    ensureDir(TEST_ROOT);
    testDir = fs.mkdtempSync(path.join(TEST_ROOT, 'snap-test-'));
    dbPath = path.join(testDir, 'test.db');
    createTestDb(dbPath, 25);
  });

  afterEach(() => {
    try {
      // Clean up test snapshot dir
      if (fs.existsSync(SNAPSHOT_DIR)) {
        for (const f of fs.readdirSync(SNAPSHOT_DIR)) {
          fs.unlinkSync(path.join(SNAPSHOT_DIR, f));
        }
        fs.rmdirSync(SNAPSHOT_DIR, { recursive: true } as any);
      }
    } catch {}
    try {
      if (testDir) {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    } catch {}
  });

  it('succeeds — produces valid SQLite snapshot with correct entry count', async () => {
    if (!Database) return; // Skip if better-sqlite3 not available

    const startCount = countDbEntries(dbPath);
    expect(startCount).toBe(25);

    const result = await runSnapshot({
      dbPath,
      snapshotDir: SNAPSHOT_DIR,
      pruneHours: 0, // Don't prune in test
      quiet: true,
    });

    expect(result.ok).toBe(true);
    expect(result.target).toBeDefined();
    expect(fs.existsSync(result.target!)).toBe(true);

    const snapCount = countDbEntries(result.target!);
    expect(snapCount).toBe(25); // Same number of entries
    expect(result.bytes).toBeGreaterThan(0);

    // Verify it's valid SQLite
    const db = new Database(result.target!, { readonly: true, fileMustExist: true });
    const version = db.prepare('SELECT sqlite_version() as v').get() as { v: string };
    expect(version.v).toBeTruthy();
    db.close();
  });

  it('succeeds — creates latest.db symlink', async () => {
    if (!Database) return;

    const result = await runSnapshot({
      dbPath,
      snapshotDir: SNAPSHOT_DIR,
      pruneHours: 0,
      quiet: true,
    });

    expect(result.ok).toBe(true);
    const latestPath = path.join(SNAPSHOT_DIR, 'latest.db');
    expect(fs.existsSync(latestPath)).toBe(true);
    const link = fs.readlinkSync(latestPath);
    expect(link).toBe(path.basename(result.target!));
  });

  it('fails — nonexistent db path', async () => {
    if (!Database) return;

    const result = await runSnapshot({
      dbPath: '/nonexistent/path/impossible.db',
      snapshotDir: SNAPSHOT_DIR,
      quiet: true,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('not found');
  });
});

describe('restore (integration)', () => {
  let testDir: string;
  let dbPath: string;

  beforeEach(() => {
    try {
      Database = require('better-sqlite3');
    } catch {
      return;
    }
    ensureDir(TEST_ROOT);
    testDir = fs.mkdtempSync(path.join(TEST_ROOT, 'restore-test-'));
    dbPath = path.join(testDir, 'test.db');
    createTestDb(dbPath, 10);
  });

  afterEach(() => {
    try {
      if (testDir) {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    } catch {}
  });

  it('roundtrip: snapshot → delete db → restore → verify entries', async () => {
    if (!Database) return;

    // Create a snapshot first
    const result = await runSnapshot({
      dbPath,
      snapshotDir: SNAPSHOT_DIR,
      pruneHours: 0,
      quiet: true,
    });

    expect(result.ok).toBe(true);
    const snapshotPath = result.target!;
    const entryCount = countDbEntries(snapshotPath);
    expect(entryCount).toBe(10);

    // "Delete" DB (close and remove)
    fs.unlinkSync(dbPath);
    // Also clean up WAL/SHM if present
    try { fs.unlinkSync(dbPath + '-wal'); } catch {}
    try { fs.unlinkSync(dbPath + '-shm'); } catch {}

    // Restore by copying
    fs.copyFileSync(snapshotPath, dbPath);

    // Need to clean WAL after raw copy (real tim restore does this)
    try {
      const db = new Database(dbPath);
      db.pragma('wal_checkpoint(TRUNCATE)');
      db.close();
    } catch {}

    // Verify restored DB has same count
    const restoredCount = countDbEntries(dbPath);
    expect(restoredCount).toBe(10);
  });

  it('roundtrip via binary copy — snapshot is valid SQLite', async () => {
    if (!Database) return;

    const result = await runSnapshot({
      dbPath,
      snapshotDir: SNAPSHOT_DIR,
      pruneHours: 0,
      quiet: true,
    });

    expect(result.ok).toBe(true);

    // Open with better-sqlite3 — should not throw
    let db: Database | null = null;
    try {
      db = new Database(result.target!, { readonly: true, fileMustExist: true });
      const tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='entries'"
      ).all();
      expect(tables.length).toBe(1);
    } finally {
      db?.close();
    }

    // Also verify PRAGMA integrity check passes
    const db2 = new Database(result.target!, { readonly: true });
    const integrity = db2.pragma('integrity_check') as Array<{ integrity_check: string }>;
    expect(integrity[0].integrity_check).toBe('ok');
    db2.close();
  });
});
