"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PUSH_CHUNK = void 0;
exports.loadQueue = loadQueue;
exports.saveQueue = saveQueue;
exports.enqueue = enqueue;
exports.flushQueue = flushQueue;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const node_crypto_1 = require("node:crypto");
exports.PUSH_CHUNK = 500;
function loadQueue(path) {
    if (!(0, node_fs_1.existsSync)(path))
        return [];
    return JSON.parse((0, node_fs_1.readFileSync)(path, 'utf8'));
}
function save(path, q) {
    if (q.length === 0) {
        if ((0, node_fs_1.existsSync)(path))
            (0, node_fs_1.rmSync)(path);
        return;
    }
    const tmp = `${path}.tmp`;
    (0, node_fs_1.mkdirSync)((0, node_path_1.dirname)(path), { recursive: true });
    (0, node_fs_1.writeFileSync)(tmp, JSON.stringify(q));
    (0, node_fs_1.renameSync)(tmp, path);
}
function saveQueue(path, items) {
    save(path, items);
}
function enqueue(path, q, envelopes, blobs) {
    const created = [];
    for (let i = 0; i < blobs.length; i += exports.PUSH_CHUNK) {
        const item = {
            idempotency_key: (0, node_crypto_1.randomUUID)(),
            envelopes: envelopes.slice(i, i + exports.PUSH_CHUNK),
            blobs: blobs.slice(i, i + exports.PUSH_CHUNK),
            created_at: new Date().toISOString(),
            attempts: 0,
        };
        q.push(item);
        created.push(item);
    }
    save(path, q);
    return created;
}
async function flushQueue(path, q, send) {
    const sent = [];
    while (q.length > 0) {
        const item = q[0];
        try {
            await send(item);
            q.shift();
            sent.push(item);
            save(path, q);
        }
        catch {
            item.attempts += 1;
            save(path, q);
            return { ok: false, sent };
        }
    }
    return { ok: true, sent };
}
//# sourceMappingURL=queue.js.map