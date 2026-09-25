import { parseGenerationCursor } from 'tim-core';
import type { TenantRegistry } from './tenant-registry.js';
import { createHash, randomUUID } from 'node:crypto';
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
): { id: string; salt: string; generation: string } | { conflict: true } {
  const db = registry.getTenantDb(tenantId);
  try {
    const existing = db.prepare('SELECT id FROM files WHERE id = ?').get(fileId);
    if (existing) return { conflict: true };
    const generation = randomUUID();
    db.prepare('INSERT INTO files (id, salt, created_at, generation) VALUES (?, ?, ?, ?)').run(
      fileId,
      salt,
      new Date().toISOString(), generation,
    );
    return { id: fileId, salt, generation };
  } finally {
    db.close();
  }
}

export function listFiles(registry: TenantRegistry, tenantId: string): { id: string; salt: string; generation: string }[] {
  const db = registry.getTenantDb(tenantId);
  try {
    return db.prepare('SELECT id, salt, generation FROM files').all() as { id: string; salt: string; generation: string }[];
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
  generation?: string,
): PushResult | { error: string; status: number } {
  const db = registry.getTenantDb(tenantId);
  try {
    return db.transaction(() => {
      const file = db.prepare('SELECT generation FROM files WHERE id=?').get(fileId) as { generation: string } | undefined;
      if (!file) {
        return { error: 'File not found', status: 404 };
      }
      if (generation !== undefined && generation !== file.generation) return { error: 'File generation mismatch', status: 409 };
      // Fixed property order makes object key ordering irrelevant, while array order remains significant.
      const requestHash = createHash('sha256').update(JSON.stringify([1,1,fileId,file.generation, blobs.map(b =>
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
      db.prepare('UPDATE files SET high_water=MAX(high_water,COALESCE((SELECT MAX(id) FROM blobs WHERE file_id=?),0)) WHERE id=?').run(fileId,fileId);
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


export function formatPullCursor(generation: string, id: number): string {
  return `${generation}|${id}`;
}

export function pullBlobs(
  registry: TenantRegistry, tenantId: string, fileId: string, cursor?: string,
  pageSize = PULL_PAGE_SIZE, generation?: string, deviceId = 'storage-test',
): { blobs: unknown[]; salt: string; generation: string; next_cursor: string; has_more: boolean }
  | { error: string; status: number } {
  const db = registry.getTenantDb(tenantId);
  try {
    return db.transaction(() => {
      const file = db.prepare('SELECT salt,generation,high_water FROM files WHERE id=?').get(fileId) as
        { salt: string; generation: string; high_water: number } | undefined;
      if (!file) return { error: 'File not found', status: 404 };
      if (generation !== undefined && generation !== file.generation) return { error: 'File generation mismatch', status: 409 };
      let id: number;
      try { id = cursor ? parseGenerationCursor(cursor,file.generation) : 0; }
      catch (err) { return { error: (err as Error).message, status: 409 }; }
      if (id > file.high_water) return { error: 'Future cursor', status: 409 };
      if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 1000) return { error: 'Invalid page size', status: 400 };
      const rows = db.prepare(`SELECT id,client_proposed_id,data,device_id,updated_at,deleted_at,
        entity_type,entity_key,lww_device,received_at FROM blobs WHERE file_id=? AND id>? ORDER BY id LIMIT ?`)
        .all(fileId,id,pageSize+1) as { id: number }[];
      const slice = rows.slice(0,pageSize);
      const next = slice.at(-1)?.id ?? id;
      db.prepare(`INSERT INTO device_cursors (file_id,generation,device_id,delivered_id,updated_at)
        VALUES (?,?,?,?,?) ON CONFLICT(file_id,generation,device_id) DO UPDATE SET
        delivered_id=MAX(delivered_id,excluded.delivered_id),updated_at=excluded.updated_at`)
        .run(fileId,file.generation,deviceId,next,new Date().toISOString());
      return { blobs: slice, salt: file.salt, generation: file.generation,
        next_cursor: formatPullCursor(file.generation,next), has_more: rows.length>pageSize };
    }).immediate();
  } finally { db.close(); }
}

export function acknowledgeCursor(
  registry: TenantRegistry, tenantId: string, fileId: string, generation: string,
  deviceId: string, cursor: string,
): { cursor: string; generation: string } | { error: string; status: number } {
  const db = registry.getTenantDb(tenantId);
  try {
    return db.transaction(() => {
      const file = db.prepare('SELECT generation,high_water FROM files WHERE id=?').get(fileId) as
        { generation: string; high_water: number } | undefined;
      if (!file) return { error: 'File not found', status: 404 };
      if (generation !== file.generation) return { error: 'File generation mismatch', status: 409 };
      let id: number;
      try { id = parseGenerationCursor(cursor,generation); }
      catch (err) { return { error: (err as Error).message, status: 409 }; }
      const device = db.prepare('SELECT applied_id,delivered_id FROM device_cursors WHERE file_id=? AND generation=? AND device_id=?')
        .get(fileId,generation,deviceId) as { applied_id: number; delivered_id: number } | undefined;
      if (!device || id>device.delivered_id || id>file.high_water) return { error: 'ACK exceeds delivered cursor', status: 409 };
      db.prepare('UPDATE device_cursors SET applied_id=MAX(applied_id,?),updated_at=? WHERE file_id=? AND generation=? AND device_id=?')
        .run(id,new Date().toISOString(),fileId,generation,deviceId);
      return { cursor: formatPullCursor(generation,Math.max(id,device.applied_id)), generation };
    }).immediate();
  } finally { db.close(); }
}
