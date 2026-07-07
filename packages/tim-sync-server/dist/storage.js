"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createFile = createFile;
exports.listFiles = listFiles;
exports.pushBlobs = pushBlobs;
exports.pullBlobs = pullBlobs;
const quotas_js_1 = require("./quotas.js");
function createFile(registry, tenantId, fileId, salt) {
    const db = registry.getTenantDb(tenantId);
    try {
        const existing = db.prepare('SELECT id FROM files WHERE id = ?').get(fileId);
        if (existing)
            return { conflict: true };
        db.prepare('INSERT INTO files (id, salt, created_at) VALUES (?, ?, ?)').run(fileId, salt, new Date().toISOString());
        return { id: fileId, salt };
    }
    finally {
        db.close();
    }
}
function listFiles(registry, tenantId) {
    const db = registry.getTenantDb(tenantId);
    try {
        return db.prepare('SELECT id, salt FROM files').all();
    }
    finally {
        db.close();
    }
}
function pushBlobs(registry, tenantId, tier, fileId, idempotencyKey, blobs) {
    const db = registry.getTenantDb(tenantId);
    try {
        const file = db.prepare('SELECT id FROM files WHERE id = ?').get(fileId);
        if (!file)
            return { error: 'File not found', status: 404 };
        const seen = db.prepare('SELECT key FROM idempotency WHERE key = ?').get(idempotencyKey);
        if (seen)
            return { mappings: [] };
        const usage = registry.getUsage(tenantId);
        let newEntries = 0;
        let newBytes = 0;
        for (const b of blobs) {
            const existing = db.prepare('SELECT id, LENGTH(data) AS len FROM blobs WHERE file_id = ? AND client_proposed_id = ?').get(fileId, b.proposed_id);
            if (existing) {
                newBytes += Math.max(0, b.data.length - existing.len);
            }
            else {
                newEntries += 1;
                newBytes += b.data.length;
            }
        }
        const q = (0, quotas_js_1.quotaExceeded)(tier, usage, newEntries, newBytes);
        if (q.exceeded) {
            return { error: q.reason ?? 'Quota exceeded', status: 402 };
        }
        const mappings = [];
        const insert = db.prepare(`
      INSERT INTO blobs (file_id, client_proposed_id, data, device_id, updated_at, deleted_at)
      VALUES (?, ?, ?, ?, ?, NULL)
    `);
        const update = db.prepare(`
      UPDATE blobs SET data = ?, device_id = ?, updated_at = ?, deleted_at = NULL
      WHERE file_id = ? AND client_proposed_id = ?
    `);
        const tx = db.transaction(() => {
            for (const b of blobs) {
                const existing = db.prepare('SELECT id FROM blobs WHERE file_id = ? AND client_proposed_id = ?').get(fileId, b.proposed_id);
                if (existing) {
                    update.run(b.data, b.device_id, b.updated_at, fileId, b.proposed_id);
                    mappings.push({ proposed_id: b.proposed_id, final_id: existing.id });
                }
                else {
                    const r = insert.run(fileId, b.proposed_id, b.data, b.device_id, b.updated_at);
                    mappings.push({ proposed_id: b.proposed_id, final_id: Number(r.lastInsertRowid) });
                }
            }
            db.prepare('INSERT INTO idempotency (key, created_at) VALUES (?, ?)').run(idempotencyKey, new Date().toISOString());
        });
        tx();
        return { mappings };
    }
    finally {
        db.close();
    }
}
function pullBlobs(registry, tenantId, fileId, cursor) {
    const db = registry.getTenantDb(tenantId);
    try {
        const file = db.prepare('SELECT salt FROM files WHERE id = ?').get(fileId);
        if (!file)
            return { error: 'File not found', status: 404 };
        const startIdx = cursor ? parseInt(cursor, 10) : 0;
        const rows = db.prepare(`
      SELECT id, client_proposed_id, data, deleted_at, updated_at
      FROM blobs WHERE file_id = ?
      ORDER BY id ASC
    `).all(fileId);
        const slice = rows.slice(startIdx);
        return {
            blobs: slice.map(b => ({
                id: b.id,
                client_proposed_id: b.client_proposed_id,
                data: b.data,
                deleted_at: b.deleted_at,
                updated_at: b.updated_at,
            })),
            salt: file.salt,
            next_cursor: String(rows.length),
            has_more: false,
        };
    }
    finally {
        db.close();
    }
}
//# sourceMappingURL=storage.js.map