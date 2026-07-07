"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.parentIsSecret = parentIsSecret;
exports.isSecret = isSecret;
exports.findSecretSource = findSecretSource;
exports.materializeSecretSubtreeSync = materializeSecretSubtreeSync;
exports.setSecretSubtree = setSecretSubtree;
exports.ensureSecretInheritance = ensureSecretInheritance;
function rowHasSecret(metadataJson) {
    try {
        const meta = JSON.parse(metadataJson);
        return meta.secret === true || Number(meta.secret) === 1;
    }
    catch {
        return false;
    }
}
/** Walk parent chain; true if any ancestor has metadata.secret=true. */
function parentIsSecret(db, parentId) {
    if (!parentId)
        return false;
    const visited = new Set();
    let current = parentId;
    while (current) {
        if (visited.has(current))
            return false;
        visited.add(current);
        const row = db
            .prepare('SELECT parent_id, metadata FROM entries WHERE id = ?')
            .get(current);
        if (!row)
            return false;
        if (rowHasSecret(row.metadata))
            return true;
        current = row.parent_id;
    }
    return false;
}
/** Own secret flag OR inherited via parent chain. */
function isSecret(db, id) {
    const row = db
        .prepare('SELECT metadata, parent_id FROM entries WHERE id = ?')
        .get(id);
    if (!row)
        return false;
    if (rowHasSecret(row.metadata))
        return true;
    return parentIsSecret(db, row.parent_id);
}
/** First ancestor (including self) with secret=true, or null. */
function findSecretSource(db, id) {
    const visited = new Set();
    let current = id;
    while (current) {
        if (visited.has(current))
            return null;
        visited.add(current);
        const row = db
            .prepare('SELECT parent_id, metadata FROM entries WHERE id = ?')
            .get(current);
        if (!row)
            return null;
        if (rowHasSecret(row.metadata))
            return current;
        current = row.parent_id;
    }
    return null;
}
function collectSubtreeIds(db, rootId) {
    const ids = [];
    const queue = [rootId];
    const visited = new Set();
    while (queue.length > 0) {
        const nodeId = queue.shift();
        if (visited.has(nodeId))
            continue;
        visited.add(nodeId);
        ids.push(nodeId);
        const children = db
            .prepare('SELECT id FROM entries WHERE parent_id = ? AND tombstoned_at IS NULL')
            .all(nodeId);
        for (const child of children)
            queue.push(child.id);
    }
    return ids;
}
/** Synchronous materialization for moveEntry transaction path. */
function materializeSecretSubtreeSync(db, rootId, deviceId = 'local') {
    let count = 0;
    const now = new Date().toISOString();
    const ts = Date.now();
    for (const nodeId of collectSubtreeIds(db, rootId)) {
        const row = db.prepare('SELECT * FROM entries WHERE id = ?').get(nodeId);
        if (!row)
            continue;
        const meta = JSON.parse(String(row.metadata));
        if (meta.secret === true)
            continue;
        meta.secret = true;
        const metadata = JSON.stringify(meta);
        db.prepare('UPDATE entries SET metadata = ?, updated_at = ?, lww_device = ? WHERE id = ?').run(metadata, now, deviceId, nodeId);
        const staged = { ...row, metadata, updated_at: now, lww_device: deviceId };
        db.prepare(`INSERT INTO staging (key, entity_type, operation, payload,
      lww_timestamp, lww_device, lww_confidence)
      VALUES (?, 'entry', 'upsert', ?, ?, ?, ?)`).run(nodeId, JSON.stringify(staged), ts, deviceId, Number(row.confidence ?? 1));
        count++;
    }
    return count;
}
/** BFS subtree; materialize secret via store.update() for sync staging. */
async function setSecretSubtree(store, id) {
    const db = store.getDb();
    let count = 0;
    for (const nodeId of collectSubtreeIds(db, id)) {
        const row = db
            .prepare('SELECT metadata FROM entries WHERE id = ?')
            .get(nodeId);
        if (!row || rowHasSecret(row.metadata))
            continue;
        await store.update(nodeId, { metadata: { secret: true } });
        count++;
    }
    return count;
}
/** After reparent: materialize secret on moved subtree when new parent is secret. */
async function ensureSecretInheritance(store, id, newParentId) {
    if (parentIsSecret(store.getDb(), newParentId)) {
        await setSecretSubtree(store, id);
    }
}
//# sourceMappingURL=secret.js.map