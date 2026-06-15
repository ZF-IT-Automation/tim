"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getUnackedStaging = getUnackedStaging;
exports.ackStaging = ackStaging;
exports.recordFromPayload = recordFromPayload;
exports.applyRemoteEntry = applyRemoteEntry;
exports.applyRemoteEdge = applyRemoteEdge;
const tim_sync_1 = require("tim-sync");
const metadata_coerce_js_1 = require("./metadata-coerce.js");
function getUnackedStaging(db) {
    return db.prepare('SELECT * FROM staging WHERE acked = 0 ORDER BY rowid').all();
}
function ackStaging(db, keys) {
    if (keys.length === 0)
        return;
    const placeholders = keys.map(() => '?').join(',');
    db.prepare(`UPDATE staging SET acked = 1 WHERE key IN (${placeholders})`).run(...keys);
}
function recordFromPayload(key, entityType, operation, payload, lwwTimestamp, lwwDevice, confidence = 1.0) {
    return {
        key,
        entityType,
        operation,
        payload,
        lwwTimestamp,
        lwwDevice,
        lwwConfidence: confidence,
        acked: false,
    };
}
function applyRemoteEntry(db, payloadJson, lwwTimestamp, lwwDevice, deleted) {
    let entryId;
    try {
        entryId = JSON.parse(payloadJson).id;
    }
    catch {
        return false;
    }
    const remote = recordFromPayload(entryId, 'entry', deleted ? 'delete' : 'upsert', payloadJson, lwwTimestamp, lwwDevice);
    const existing = db.prepare('SELECT * FROM entries WHERE id = ?').get(entryId);
    if (existing) {
        const local = recordFromPayload(entryId, 'entry', existing.tombstoned_at ? 'delete' : 'upsert', JSON.stringify(existing), Date.parse(String(existing.accessed_at ?? existing.created_at)), 'local', Number(existing.confidence ?? 1));
        const { winner } = (0, tim_sync_1.resolveLWW)(local, remote);
        if (winner !== remote)
            return false;
    }
    else if (deleted) {
        return false;
    }
    if (deleted) {
        db.prepare('UPDATE entries SET tombstoned_at = ? WHERE id = ?').run(new Date(lwwTimestamp).toISOString(), entryId);
        return true;
    }
    const entry = JSON.parse(payloadJson);
    const coercedMetadata = JSON.stringify((0, metadata_coerce_js_1.parseAndCoerceMetadata)(entry.metadata));
    db.prepare(`INSERT OR REPLACE INTO entries
    (id, parent_id, title, content, content_type, depth, confidence, created_at,
     accessed_at, decay_rate, visibility, tags, irrelevant, favorite, tombstoned_at, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(entry.id, entry.parent_id ?? null, entry.title ?? '', entry.content, entry.content_type, entry.depth, entry.confidence, entry.created_at, entry.accessed_at, entry.decay_rate, entry.visibility, entry.tags, entry.irrelevant, entry.favorite ?? 0, entry.tombstoned_at, coercedMetadata);
    return true;
}
function applyRemoteEdge(db, payloadJson, lwwTimestamp, lwwDevice, deleted) {
    let edge;
    try {
        edge = JSON.parse(payloadJson);
    }
    catch {
        return false;
    }
    const compositeKey = `${edge.source_id}|${edge.target_id}|${edge.type}`;
    const remote = recordFromPayload(compositeKey, 'edge', deleted ? 'delete' : 'upsert', payloadJson, lwwTimestamp, lwwDevice);
    const existing = db.prepare('SELECT * FROM edges WHERE source_id = ? AND target_id = ? AND type = ?').get(edge.source_id, edge.target_id, edge.type);
    if (existing) {
        const local = recordFromPayload(compositeKey, 'edge', 'upsert', JSON.stringify(existing), lwwTimestamp, 'local');
        const { winner } = (0, tim_sync_1.resolveLWW)(local, remote);
        if (winner !== remote)
            return false;
    }
    else if (deleted) {
        return false;
    }
    if (deleted) {
        db.prepare('DELETE FROM edges WHERE id = ?').run(edge.id);
        return true;
    }
    db.prepare(`INSERT OR REPLACE INTO edges (id, source_id, target_id, type, weight, metadata)
    VALUES (?, ?, ?, ?, ?, ?)`).run(edge.id, edge.source_id, edge.target_id, edge.type, edge.weight, edge.metadata);
    return true;
}
//# sourceMappingURL=sync-methods.js.map