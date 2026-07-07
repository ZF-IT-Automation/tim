import type Database from 'better-sqlite3';
import type { TenantRegistry } from './tenant-registry.js';
import { quotaExceeded } from './quotas.js';
import type { TenantTier } from './quotas.js';

export const PULL_PAGE_SIZE = 100;

export interface PushBlobInput {
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

function countUsageFromDb(db: Database.Database): { entryCount: number; totalBytes: number } {
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
}

export function pushBlobs(
  registry: TenantRegistry,
  tenantId: string,
  tier: TenantTier,
  fileId: string,
  idempotencyKey: string,
  blobs: PushBlobInput[],
): { mappings: { proposed_id: string; final_id: number }[] } | { error: string; status: number } {
  const db = registry.getTenantDb(tenantId);
  try {
    const file = db.prepare('SELECT id FROM files WHERE id = ?').get(fileId);
    if (!file) return { error: 'File not found', status: 404 };

    const usage = countUsageFromDb(db);
    let newEntries = 0;
    let newBytes = 0;
    for (const b of blobs) {
      const existing = db.prepare(
        'SELECT id FROM blobs WHERE file_id = ? AND client_proposed_id = ? LIMIT 1',
      ).get(fileId, b.proposed_id);
      if (!existing) {
        newEntries += 1;
      }
      newBytes += b.data.length;
    }

    const q = quotaExceeded(tier, usage, newEntries, newBytes);
    if (q.exceeded) {
      return { error: q.reason ?? 'Quota exceeded', status: 402 };
    }

    const mappings: { proposed_id: string; final_id: number }[] = [];
    const insert = db.prepare(`
      INSERT INTO blobs (file_id, client_proposed_id, data, device_id, updated_at, deleted_at)
      VALUES (?, ?, ?, ?, ?, NULL)
    `);

    const tx = db.transaction(() => {
      const seen = db.prepare('SELECT key FROM idempotency WHERE key = ?').get(idempotencyKey);
      if (seen) return;

      for (const b of blobs) {
        const r = insert.run(fileId, b.proposed_id, b.data, b.device_id, b.updated_at);
        mappings.push({ proposed_id: b.proposed_id, final_id: Number(r.lastInsertRowid) });
      }
      db.prepare('INSERT INTO idempotency (key, created_at) VALUES (?, ?)').run(
        idempotencyKey,
        new Date().toISOString(),
      );
    });
    tx();

    const seenAfter = db.prepare('SELECT key FROM idempotency WHERE key = ?').get(idempotencyKey);
    if (!seenAfter) {
      return { mappings: [] };
    }
    return { mappings };
  } finally {
    db.close();
  }
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
