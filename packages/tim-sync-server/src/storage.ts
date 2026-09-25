import type Database from 'better-sqlite3';
import type { TenantRegistry } from './tenant-registry.js';
import { createHash } from 'node:crypto';
import { countUsageFromDb, quotaExceeded } from './quotas.js';
import type { TenantTier } from './quotas.js';

export const PULL_PAGE_SIZE = 100;

export interface PushBlobInput {
  entity_type?: 'entry' | 'edge';
  entity_key?: string;
  lww_device?: string;
  proposed_id: string;
  data: string;
  device_id: string;
  updated_at: string;
}

export function createFile(
  registry: TenantRegistry,
  tenantId: string,
  fileId: string,
  salt: string,
): { id: string; salt: string } | { conflict: true } {
  const db = registry.getTenantDb(tenantId);
  try {
    const existing = db.prepare('SELECT id FROM files WHERE id = ?').get(fileId);
    if (existing) return { conflict: true };
    db.prepare('INSERT INTO files (id, salt, created_at) VALUES (?, ?, ?)').run(
      fileId,
      salt,
      new Date().toISOString(),
    );
    return { id: fileId, salt };
  } finally {
    db.close();
  }
}

export function listFiles(registry: TenantRegistry, tenantId: string): { id: string; salt: string }[] {
  const db = registry.getTenantDb(tenantId);
  try {
    return db.prepare('SELECT id, salt FROM files').all() as { id: string; salt: string }[];
  } finally {
    db.close();
  }
}

type PushResult = { mappings: { proposed_id: string; final_id: number }[] };
class QuotaFailure extends Error {}

export function pushBlobs(
  registry: TenantRegistry,
  tenantId: string,
  tier: TenantTier,
  fileId: string,
  idempotencyKey: string,
  blobs: PushBlobInput[],
): PushResult | { error: string; status: number } {
  const db = registry.getTenantDb(tenantId);
  try {
    return db.transaction(() => {
      if (!db.prepare('SELECT id FROM files WHERE id=?').get(fileId)) {
        return { error: 'File not found', status: 404 };
      }
      // Fixed property order makes object key ordering irrelevant, while array order remains significant.
      const requestHash = createHash('sha256').update(JSON.stringify([fileId, blobs.map(b =>
        [b.proposed_id,b.entity_type,b.entity_key,b.data,b.device_id,b.updated_at,b.lww_device])])).digest('hex');
      const seen = db.prepare('SELECT request_hash,result_json FROM idempotency WHERE key=?')
        .get(idempotencyKey) as { request_hash: string | null; result_json: string | null } | undefined;
      if (seen) {
        if (seen.request_hash !== requestHash || !seen.result_json) {
          return { error: 'Idempotency key belongs to a different or unknown request', status: 409 };
        }
        return JSON.parse(seen.result_json) as PushResult;
      }
      const result: PushResult = { mappings: [] };
      const insert = db.prepare(`INSERT INTO blobs
        (file_id,client_proposed_id,data,device_id,updated_at,entity_type,entity_key,lww_device,received_at)
        VALUES (?,?,?,?,?,?,?,?,?)`);
      for (const b of blobs) {
        const r = insert.run(fileId,b.proposed_id,b.data,b.device_id,b.updated_at,
          b.entity_type ?? null,b.entity_key ?? null,b.lww_device ?? null,new Date().toISOString());
        result.mappings.push({ proposed_id: b.proposed_id, final_id: Number(r.lastInsertRowid) });
      }
      const quota = quotaExceeded(tier, countUsageFromDb(db), 0, 0);
      if (quota.exceeded) throw new QuotaFailure(quota.reason);
      db.prepare('INSERT INTO idempotency (key,created_at,request_hash,result_json) VALUES (?,?,?,?)')
        .run(idempotencyKey,new Date().toISOString(),requestHash,JSON.stringify(result));
      return result;
    }).immediate();
  } catch (err) {
    if (err instanceof QuotaFailure) return { error: err.message, status: 402 };
    throw err;
  } finally { db.close(); }
}

export function parsePullCursor(cursor?: string): { updatedAt: string; id: number } {
  if (!cursor) return { updatedAt: '1970-01-01T00:00:00.000Z', id: 0 };
  if (cursor.includes('|')) {
    const sep = cursor.lastIndexOf('|');
    const updatedAt = cursor.slice(0, sep);
    const id = parseInt(cursor.slice(sep + 1), 10);
    return { updatedAt, id: Number.isFinite(id) ? id : 0 };
  }
  // Legacy numeric index cursors — full resync from epoch
  if (/^\d+$/.test(cursor)) {
    return { updatedAt: '1970-01-01T00:00:00.000Z', id: 0 };
  }
  return { updatedAt: cursor, id: 0 };
}

export function formatPullCursor(updatedAt: string, id: number): string {
  return `${updatedAt}|${id}`;
}

export function pullBlobs(
  registry: TenantRegistry,
  tenantId: string,
  fileId: string,
  cursor?: string,
  pageSize = PULL_PAGE_SIZE,
): { blobs: unknown[]; salt?: string; next_cursor: string; has_more: boolean } | { error: string; status: number } {
  const db = registry.getTenantDb(tenantId);
  try {
    const file = db.prepare('SELECT salt FROM files WHERE id = ?').get(fileId) as { salt: string } | undefined;
    if (!file) return { error: 'File not found', status: 404 };

    // Page on the server-assigned monotonic id only. updated_at comes from
    // client clocks (LWW timestamps) — ordering on it lets a device with a
    // lagging clock insert blobs *behind* other devices' cursors, which are
    // then never delivered. Rows are append-only, so id order is complete.
    const { updatedAt, id } = parsePullCursor(cursor);
    const rows = db.prepare(`
      SELECT id, client_proposed_id, data, deleted_at, updated_at
      FROM blobs
      WHERE file_id = ? AND id > ?
      ORDER BY id ASC
      LIMIT ?
    `).all(fileId, id, pageSize + 1) as {
      id: number;
      client_proposed_id: string;
      data: string;
      deleted_at: string | null;
      updated_at: string;
    }[];

    const hasMore = rows.length > pageSize;
    const slice = hasMore ? rows.slice(0, pageSize) : rows;
    const last = slice[slice.length - 1];
    const nextCursor = last
      ? formatPullCursor(last.updated_at, last.id)
      : formatPullCursor(updatedAt, id);

    return {
      blobs: slice.map(b => ({
        id: b.id,
        client_proposed_id: b.client_proposed_id,
        data: b.data,
        deleted_at: b.deleted_at,
        updated_at: b.updated_at,
      })),
      salt: file.salt,
      next_cursor: nextCursor,
      has_more: hasMore,
    };
  } finally {
    db.close();
  }
}
