import Database from 'better-sqlite3';
import { randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TenantRecord, TenantTier } from './quotas.js';
import type { QuotaUsage } from './quotas.js';

export interface RegistryStats {
  tenantCount: number;
  totalEntries: number;
  totalBytes: number;
}

export class TenantRegistry {
  private db: Database.Database;

  constructor(private dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(path.join(dataDir, 'tenants'), { recursive: true });
    this.db = new Database(path.join(dataDir, 'registry.db'));
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tenants (
        id TEXT PRIMARY KEY,
        token TEXT NOT NULL UNIQUE,
        tier TEXT NOT NULL DEFAULT 'free',
        created_at TEXT NOT NULL
      );
    `);
  }

  register(tier: TenantTier = 'free'): TenantRecord {
    const id = randomUUID();
    const token = randomBytes(32).toString('hex');
    const createdAt = new Date().toISOString();
    this.db.prepare(
      'INSERT INTO tenants (id, token, tier, created_at) VALUES (?, ?, ?, ?)',
    ).run(id, token, tier, createdAt);
    this.initTenantDb(id);
    return { id, token, tier, createdAt };
  }

  setTenantTier(tenantId: string, tier: TenantTier): boolean {
    const result = this.db.prepare('UPDATE tenants SET tier = ? WHERE id = ?').run(tier, tenantId);
    return result.changes > 0;
  }

  resolveToken(token: string): TenantRecord | null {
    const row = this.db.prepare(
      'SELECT id, token, tier, created_at FROM tenants WHERE token = ?',
    ).get(token) as { id: string; token: string; tier: TenantTier; created_at: string } | undefined;
    if (!row) return null;
    return { id: row.id, token: row.token, tier: row.tier, createdAt: row.created_at };
  }

  tenantDbPath(tenantId: string): string {
    return path.join(this.dataDir, 'tenants', `${tenantId}.db`);
  }

  private migrateTenantDbIfNeeded(db: Database.Database): void {
    const table = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='blobs'",
    ).get() as { sql: string } | undefined;
    if (!table?.sql?.includes('UNIQUE(file_id, client_proposed_id)')) {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_blobs_file_updated
        ON blobs(file_id, updated_at, id);
      `);
      return;
    }

    db.exec(`
      CREATE TABLE blobs_migrated (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id TEXT NOT NULL,
        client_proposed_id TEXT NOT NULL,
        data TEXT NOT NULL,
        device_id TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );
      INSERT INTO blobs_migrated (id, file_id, client_proposed_id, data, device_id, updated_at, deleted_at)
      SELECT id, file_id, client_proposed_id, data, device_id, updated_at, deleted_at FROM blobs;
      DROP TABLE blobs;
      ALTER TABLE blobs_migrated RENAME TO blobs;
      CREATE INDEX idx_blobs_file_updated ON blobs(file_id, updated_at, id);
    `);
  }

  private initTenantDb(tenantId: string): void {
    const db = new Database(this.tenantDbPath(tenantId));
    db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        id TEXT PRIMARY KEY,
        salt TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS blobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_id TEXT NOT NULL,
        client_proposed_id TEXT NOT NULL,
        data TEXT NOT NULL,
        device_id TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );
      CREATE TABLE IF NOT EXISTS idempotency (
        key TEXT PRIMARY KEY,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_blobs_file_updated
        ON blobs(file_id, updated_at, id);
    `);
    this.migrateTenantDbIfNeeded(db);
    db.close();
  }

  getTenantDb(tenantId: string): Database.Database {
    const p = this.tenantDbPath(tenantId);
    if (!fs.existsSync(p)) this.initTenantDb(tenantId);
    const db = new Database(p);
    this.migrateTenantDbIfNeeded(db);
    return db;
  }

  getUsage(tenantId: string): QuotaUsage {
    const db = this.getTenantDb(tenantId);
    try {
      const row = db.prepare(`
        SELECT COUNT(*) AS c, COALESCE(SUM(LENGTH(data)), 0) AS bytes
        FROM blobs b
        INNER JOIN (
          SELECT client_proposed_id, MAX(id) AS max_id
          FROM blobs
          WHERE deleted_at IS NULL
          GROUP BY client_proposed_id
        ) latest ON b.id = latest.max_id
      `).get() as { c: number; bytes: number };
      return { entryCount: row.c, totalBytes: row.bytes };
    } finally {
      db.close();
    }
  }

  aggregateStats(): RegistryStats {
    const tenants = this.db.prepare('SELECT id FROM tenants').all() as { id: string }[];
    let totalEntries = 0;
    let totalBytes = 0;
    for (const t of tenants) {
      const u = this.getUsage(t.id);
      totalEntries += u.entryCount;
      totalBytes += u.totalBytes;
    }
    return { tenantCount: tenants.length, totalEntries, totalBytes };
  }

  close(): void {
    this.db.close();
  }
}
