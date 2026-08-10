import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { TimStore } from '../store.js';
import { getCurrentVersion, MIGRATIONS, runMigrations } from '../schema.js';

const cleanupPaths: string[] = [];

// The repo's gitignored tmp/, resolved from this file rather than from cwd — and
// created first, because a fresh checkout does not carry an ignored directory.
const TEST_ROOT = path.resolve(import.meta.dirname, '../../../../tmp');

function tmpDb(): string {
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  const dir = fs.mkdtempSync(path.join(TEST_ROOT, 'mig-gate-'));
  const dbPath = path.join(dir, 't.db');
  cleanupPaths.push(dir);
  return dbPath;
}

afterEach(() => {
  for (const p of cleanupPaths.splice(0)) {
    fs.rmSync(p, { recursive: true, force: true });
  }
});

function readVersion(dbPath: string): number {
  const db = new Database(dbPath);
  const row = db.prepare('SELECT version FROM _schema_version').get() as
    | { version: number }
    | undefined;
  db.close();
  return row?.version ?? 0;
}

function rewindVersion(dbPath: string, version: number): void {
  const db = new Database(dbPath);
  db.prepare('UPDATE _schema_version SET version = ?').run(version);
  db.close();
}

describe('migration gate', () => {
  it('throws on pending upgrade when allowMigrations is unset, leaving version unchanged', () => {
    const dbPath = tmpDb();
    new TimStore(dbPath).close();
    const expected = getCurrentVersion();
    const rewindTo = expected - 2;
    rewindVersion(dbPath, rewindTo);

    expect(() => new TimStore(dbPath)).toThrow(
      new RegExp(
        `Schema is at v${rewindTo}, this build expects v${expected}\\. ` +
          `Run "tim migrate-schema" to apply 2 pending migrations\\.`,
      ),
    );
    expect(readVersion(dbPath)).toBe(rewindTo);
    expect(fs.existsSync(`${dbPath}.pre-migration-v${rewindTo}.bak`)).toBe(false);
  });

  it('migrates when allowMigrations is true', () => {
    const dbPath = tmpDb();
    new TimStore(dbPath).close();
    const expected = getCurrentVersion();
    const rewindTo = expected - 1;
    rewindVersion(dbPath, rewindTo);

    const store = new TimStore(dbPath, { allowMigrations: true });
    store.close();
    expect(readVersion(dbPath)).toBe(expected);
    expect(fs.existsSync(`${dbPath}.pre-migration-v${rewindTo}.bak`)).toBe(true);
  });

  it('bootstraps a version-0 database with allowMigrations unset', () => {
    const dbPath = tmpDb();
    const store = new TimStore(dbPath);
    store.close();
    expect(readVersion(dbPath)).toBe(getCurrentVersion());

    const mem = new TimStore(':memory:');
    mem.close();
  });

  it('writes one schema_migration error_log row with from/to when applying', () => {
    const dbPath = tmpDb();
    new TimStore(dbPath).close();
    const expected = getCurrentVersion();
    const rewindTo = expected - 1;
    rewindVersion(dbPath, rewindTo);

    const before = new Database(dbPath);
    const beforeCount = (
      before.prepare(`SELECT COUNT(*) as c FROM error_log WHERE tool = 'schema_migration'`).get() as {
        c: number;
      }
    ).c;
    before.close();

    new TimStore(dbPath, { allowMigrations: true }).close();

    const db = new Database(dbPath);
    const rows = db
      .prepare(
        `SELECT tool, args_json, error FROM error_log WHERE tool = 'schema_migration' ORDER BY id DESC`,
      )
      .all() as Array<{ tool: string; args_json: string; error: string }>;
    const afterCount = rows.length;
    db.close();

    expect(afterCount - beforeCount).toBe(1);
    expect(rows[0].error).toBe('');
    const args = JSON.parse(rows[0].args_json) as {
      from: number;
      to: number;
      applied: number[];
      db: string;
    };
    expect(args.from).toBe(rewindTo);
    expect(args.to).toBe(expected);
    expect(args.applied).toEqual([expected]);
    expect(args.db).toBe(dbPath);
  });

  it('logs migrations committed before a later migration fails', () => {
    const dbPath = tmpDb();
    new TimStore(dbPath).close();
    const db = new Database(dbPath);
    db.prepare("DELETE FROM error_log WHERE tool = 'schema_migration'").run();
    db.prepare('UPDATE _schema_version SET version = 11').run();

    expect(() => runMigrations(db, [
      { version: 12, sql: 'CREATE TABLE IF NOT EXISTS migration_probe (id INTEGER);' },
      { version: 13, sql: 'INSERT INTO nonexistent_table VALUES (1);' },
    ], { allowMigrations: true })).toThrow();

    const version = db.prepare('SELECT version FROM _schema_version').pluck().get();
    const row = db.prepare(
      "SELECT args_json FROM error_log WHERE tool = 'schema_migration'",
    ).get() as { args_json: string };
    db.close();

    expect(version).toBe(12);
    expect(JSON.parse(row.args_json)).toMatchObject({ from: 11, to: 12, applied: [12] });
  });

  it('runMigrations itself refuses pending upgrades without allowMigrations', () => {
    const dbPath = tmpDb();
    const db = new Database(dbPath);
    runMigrations(db, MIGRATIONS, { allowMigrations: true });
    db.prepare('UPDATE _schema_version SET version = ?').run(getCurrentVersion() - 1);
    expect(() => runMigrations(db)).toThrow(/tim migrate-schema/);
    const version = (
      db.prepare('SELECT version FROM _schema_version').get() as { version: number }
    ).version;
    expect(version).toBe(getCurrentVersion() - 1);
    db.close();
  });
});
