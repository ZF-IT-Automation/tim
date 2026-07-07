"use strict";
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
exports.TenantRegistry = void 0;
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const node_crypto_1 = require("node:crypto");
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
class TenantRegistry {
    dataDir;
    db;
    constructor(dataDir) {
        this.dataDir = dataDir;
        fs.mkdirSync(dataDir, { recursive: true });
        fs.mkdirSync(path.join(dataDir, 'tenants'), { recursive: true });
        this.db = new better_sqlite3_1.default(path.join(dataDir, 'registry.db'));
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
    register(tier = 'free') {
        const id = (0, node_crypto_1.randomUUID)();
        const token = (0, node_crypto_1.randomBytes)(32).toString('hex');
        const createdAt = new Date().toISOString();
        this.db.prepare('INSERT INTO tenants (id, token, tier, created_at) VALUES (?, ?, ?, ?)').run(id, token, tier, createdAt);
        this.initTenantDb(id);
        return { id, token, tier, createdAt };
    }
    setTenantTier(tenantId, tier) {
        const result = this.db.prepare('UPDATE tenants SET tier = ? WHERE id = ?').run(tier, tenantId);
        return result.changes > 0;
    }
    resolveToken(token) {
        const row = this.db.prepare('SELECT id, token, tier, created_at FROM tenants WHERE token = ?').get(token);
        if (!row)
            return null;
        return { id: row.id, token: row.token, tier: row.tier, createdAt: row.created_at };
    }
    tenantDbPath(tenantId) {
        return path.join(this.dataDir, 'tenants', `${tenantId}.db`);
    }
    migrateTenantDbIfNeeded(db) {
        const table = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='blobs'").get();
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
    initTenantDb(tenantId) {
        const db = new better_sqlite3_1.default(this.tenantDbPath(tenantId));
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
    getTenantDb(tenantId) {
        const p = this.tenantDbPath(tenantId);
        if (!fs.existsSync(p))
            this.initTenantDb(tenantId);
        const db = new better_sqlite3_1.default(p);
        this.migrateTenantDbIfNeeded(db);
        return db;
    }
    getUsage(tenantId) {
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
      `).get();
            return { entryCount: row.c, totalBytes: row.bytes };
        }
        finally {
            db.close();
        }
    }
    aggregateStats() {
        const tenants = this.db.prepare('SELECT id FROM tenants').all();
        let totalEntries = 0;
        let totalBytes = 0;
        for (const t of tenants) {
            const u = this.getUsage(t.id);
            totalEntries += u.entryCount;
            totalBytes += u.totalBytes;
        }
        return { tenantCount: tenants.length, totalEntries, totalBytes };
    }
    close() {
        this.db.close();
    }
}
exports.TenantRegistry = TenantRegistry;
//# sourceMappingURL=tenant-registry.js.map