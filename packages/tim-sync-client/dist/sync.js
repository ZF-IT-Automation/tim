"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SECRET_PLACEHOLDER_TITLE = void 0;
exports.isSecretPlaceholderPayload = isSecretPlaceholderPayload;
exports.encryptSecretPayload = encryptSecretPayload;
exports.decryptSecretPayload = decryptSecretPayload;
exports.pushCycle = pushCycle;
exports.pullCycle = pullCycle;
exports.runPush = runPush;
exports.runPull = runPull;
exports.buildSyncContext = buildSyncContext;
const tim_store_1 = require("tim-store");
const tim_core_1 = require("tim-core");
const client_js_1 = require("./client.js");
const crypto_js_1 = require("./crypto.js");
const envelope_js_1 = require("./envelope.js");
const config_js_1 = require("./config.js");
const queue_js_1 = require("./queue.js");
function makeEncrypt(passphrase, salt) {
    const key = (0, crypto_js_1.deriveKey)(passphrase, salt);
    return (data) => (0, crypto_js_1.encrypt)(data, key);
}
function makeDecrypt(passphrase, salt) {
    const key = (0, crypto_js_1.deriveKey)(passphrase, salt);
    return (data) => (0, crypto_js_1.decrypt)(data, key);
}
function makeSecretEncrypt(secretPassphrase, salt) {
    const key = (0, crypto_js_1.deriveKey)(secretPassphrase, salt);
    return (data) => (0, crypto_js_1.encrypt)(data, key);
}
function makeSecretDecrypt(secretPassphrase, salt) {
    const key = (0, crypto_js_1.deriveKey)(secretPassphrase, salt);
    return (data) => (0, crypto_js_1.decrypt)(data, key);
}
function parsePayloadMetadata(metadata) {
    if (typeof metadata === 'string') {
        try {
            return JSON.parse(metadata);
        }
        catch {
            return {};
        }
    }
    if (metadata && typeof metadata === 'object') {
        return metadata;
    }
    return {};
}
function payloadIsSecret(payloadJson) {
    try {
        const payload = JSON.parse(payloadJson);
        return parsePayloadMetadata(payload.metadata).secret === true;
    }
    catch {
        return false;
    }
}
exports.SECRET_PLACEHOLDER_TITLE = '🔒 [secret]';
function isSecretPlaceholderPayload(payloadJson) {
    try {
        const payload = JSON.parse(payloadJson);
        return (payload.title === exports.SECRET_PLACEHOLDER_TITLE &&
            payload.content === '' &&
            parsePayloadMetadata(payload.metadata).secret === true);
    }
    catch {
        return false;
    }
}
function encryptSecretPayload(payloadJson, secretEncrypt) {
    const payload = JSON.parse(payloadJson);
    const metaRaw = payload.metadata;
    const rawMetadata = typeof payload.metadata_raw === 'string'
        ? payload.metadata_raw
        : typeof metaRaw === 'string'
            ? metaRaw
            : JSON.stringify(metaRaw ?? {});
    const encMeta = secretEncrypt(rawMetadata);
    const encryptedMetadata = JSON.stringify({ secret: true, _enc: encMeta });
    const encrypted = {
        ...payload,
        title: secretEncrypt(String(payload.title ?? '')),
        content: secretEncrypt(String(payload.content ?? '')),
        metadata: encryptedMetadata,
        metadata_raw: encryptedMetadata,
    };
    return JSON.stringify(encrypted);
}
function decryptSecretPayload(payloadJson, secretDecrypt) {
    const payload = JSON.parse(payloadJson);
    if (!secretDecrypt) {
        const metaRaw = payload.metadata;
        let enc;
        if (typeof metaRaw === 'string') {
            try {
                enc = JSON.parse(metaRaw)._enc;
            }
            catch {
                enc = undefined;
            }
        }
        else if (metaRaw && typeof metaRaw === 'object') {
            enc = metaRaw._enc;
        }
        const placeholderMetadata = JSON.stringify(enc !== undefined ? { secret: true, _enc: enc } : { secret: true });
        const placeholder = {
            ...payload,
            title: '🔒 [secret]',
            content: '',
            metadata: placeholderMetadata,
            metadata_raw: placeholderMetadata,
        };
        return JSON.stringify(placeholder);
    }
    const metaRaw = payload.metadata;
    let encBlob;
    if (typeof metaRaw === 'string') {
        encBlob = JSON.parse(metaRaw)._enc;
    }
    else if (metaRaw && typeof metaRaw === 'object') {
        encBlob = metaRaw._enc;
    }
    const fullMetadata = encBlob ? secretDecrypt(encBlob) : JSON.stringify({ secret: true });
    const decrypted = {
        ...payload,
        title: secretDecrypt(String(payload.title ?? '')),
        content: secretDecrypt(String(payload.content ?? '')),
        metadata: fullMetadata,
        metadata_raw: fullMetadata,
    };
    return JSON.stringify(decrypted);
}
function transformEnvelopeForPush(env, secretEncrypt) {
    if (!secretEncrypt || env.type !== 'entry' || env.deleted || !payloadIsSecret(env.payload)) {
        return env;
    }
    return {
        ...env,
        payload: encryptSecretPayload(env.payload, secretEncrypt),
        is_encrypted: true,
    };
}
function transformEnvelopeForPull(env, secretDecrypt) {
    if (!env.is_encrypted || env.type !== 'entry') {
        return env;
    }
    return {
        ...env,
        payload: decryptSecretPayload(env.payload, secretDecrypt),
    };
}
async function pushCycle(client, store, state, deviceId, encryptFn, secretEncrypt) {
    const db = store.getDb();
    const allRows = (0, tim_store_1.getUnackedStaging)(db);
    const placeholderKeys = [];
    const rows = allRows.filter((row) => {
        if (row.entity_type === 'entry' && isSecretPlaceholderPayload(row.payload)) {
            placeholderKeys.push(row.key);
            return false;
        }
        return true;
    });
    const qPath = (0, config_js_1.getQueuePath)(state.fileId);
    let queue = (0, queue_js_1.loadQueue)(qPath);
    if (rows.length > 0) {
        const envelopes = rows
            .map(envelope_js_1.stagingToEnvelope)
            .map((e) => transformEnvelopeForPush(e, secretEncrypt));
        const blobs = envelopes.map((e) => ({
            proposed_id: e.key,
            data: encryptFn(JSON.stringify(e)),
            device_id: deviceId,
            updated_at: e.lww,
        }));
        (0, queue_js_1.enqueue)(qPath, queue, envelopes, blobs);
        queue = (0, queue_js_1.loadQueue)(qPath);
    }
    const { ok, sent } = await (0, queue_js_1.flushQueue)(qPath, queue, async (item) => {
        await client.push({
            file_id: state.fileId,
            idempotency_key: item.idempotency_key,
            client_schema_major: 1,
            blobs: item.blobs,
        });
    });
    const keysToAck = [...placeholderKeys];
    let pushedCount = 0;
    for (const item of sent) {
        for (const e of item.envelopes) {
            keysToAck.push(e.key);
            pushedCount++;
        }
    }
    if (keysToAck.length > 0)
        (0, tim_store_1.ackStaging)(db, keysToAck);
    state.lastPush = new Date().toISOString();
    (0, config_js_1.saveSyncState)(state);
    return { pushed: pushedCount, queued: !ok };
}
async function pullCycle(client, store, state, decryptFn, secretDecrypt) {
    const db = store.getDb();
    let cursor = state.cursor ?? undefined;
    let pulled = 0;
    let conflicts = 0;
    let res;
    do {
        res = await client.pull(state.fileId, cursor, 1);
        if (res.salt && !state.fileId) {
            // salt refresh handled by caller config
        }
        for (const blob of res.blobs) {
            let env = JSON.parse(decryptFn(blob.data));
            env = transformEnvelopeForPull(env, secretDecrypt);
            const remote = (0, envelope_js_1.envelopeToStaging)(env, blob.client_proposed_id ?? 'remote');
            if (env.type === 'entry') {
                const existing = db.prepare('SELECT * FROM entries WHERE id = ?').get(env.key);
                if (existing) {
                    const localRecord = {
                        key: env.key,
                        entityType: 'entry',
                        operation: existing.tombstoned_at ? 'delete' : 'upsert',
                        payload: JSON.stringify(existing),
                        lwwTimestamp: Date.parse(String(existing.accessed_at ?? existing.created_at)),
                        lwwDevice: 'local',
                        lwwConfidence: Number(existing.confidence ?? 1),
                        acked: true,
                    };
                    const resolution = (0, tim_core_1.resolveLWW)(localRecord, remote);
                    if (resolution.winner !== remote)
                        conflicts++;
                }
                const applied = (0, tim_store_1.applyRemoteEntry)(db, env.payload, remote.lwwTimestamp, remote.lwwDevice, env.deleted);
                if (applied)
                    pulled++;
            }
            else {
                const parts = env.key.split('|');
                const sourceId = parts[0];
                const targetId = parts[1];
                const edgeType = parts[2];
                const existing = db.prepare('SELECT * FROM edges WHERE source_id = ? AND target_id = ? AND type = ?').get(sourceId, targetId, edgeType);
                if (existing) {
                    const localRecord = {
                        key: env.key,
                        entityType: 'edge',
                        operation: 'upsert',
                        payload: JSON.stringify(existing),
                        lwwTimestamp: Date.now(),
                        lwwDevice: 'local',
                        lwwConfidence: 1,
                        acked: true,
                    };
                    const resolution = (0, tim_core_1.resolveLWW)(localRecord, remote);
                    if (resolution.winner !== remote)
                        conflicts++;
                }
                const applied = (0, tim_store_1.applyRemoteEdge)(db, env.payload, remote.lwwTimestamp, remote.lwwDevice, env.deleted);
                if (applied)
                    pulled++;
            }
        }
        cursor = res.next_cursor;
    } while (res.has_more === true);
    state.cursor = res.next_cursor ?? state.cursor;
    state.lastPull = new Date().toISOString();
    (0, config_js_1.saveSyncState)(state);
    return { pulled, conflicts };
}
async function runPush(ctx) {
    const enc = makeEncrypt(ctx.passphrase, ctx.salt);
    const secretEnc = ctx.secretPassphrase
        ? makeSecretEncrypt(ctx.secretPassphrase, ctx.salt)
        : undefined;
    return pushCycle(ctx.client, ctx.store, ctx.state, ctx.deviceId, enc, secretEnc);
}
async function runPull(ctx) {
    const dec = makeDecrypt(ctx.passphrase, ctx.salt);
    const secretDec = ctx.secretPassphrase
        ? makeSecretDecrypt(ctx.secretPassphrase, ctx.salt)
        : undefined;
    return pullCycle(ctx.client, ctx.store, ctx.state, dec, secretDec);
}
function buildSyncContext(store, config, passphrase, deviceId, secretPassphrase) {
    const state = (0, config_js_1.loadSyncState)() ?? {
        fileId: config.fileId,
        cursor: null,
        lastPush: null,
        lastPull: null,
    };
    state.fileId = config.fileId;
    return {
        client: new client_js_1.TimSyncClient(config.serverUrl, config.token),
        store,
        state,
        deviceId,
        passphrase,
        salt: config.salt,
        secretPassphrase,
    };
}
//# sourceMappingURL=sync.js.map