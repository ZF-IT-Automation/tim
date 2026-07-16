"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.stagingKey = stagingKey;
exports.parseStagingKey = parseStagingKey;
exports.stagingToEnvelope = stagingToEnvelope;
exports.envelopeToStaging = envelopeToStaging;
exports.edgeCompositeKey = edgeCompositeKey;
function stagingKey(entityType, key) {
    return `${entityType}:${key}`;
}
function parseStagingKey(sk) {
    const idx = sk.indexOf(':');
    if (idx < 0)
        return { type: 'entry', key: sk };
    const type = sk.slice(0, idx);
    return { type: type === 'edge' ? 'edge' : 'entry', key: sk.slice(idx + 1) };
}
function stagingToEnvelope(row) {
    let entityType;
    let operation;
    let key;
    let lwwTs;
    let device;
    if ('entityType' in row) {
        entityType = row.entityType;
        operation = row.operation;
        key = row.key;
        lwwTs = row.lwwTimestamp;
        device = row.lwwDevice;
    }
    else {
        entityType = row.entity_type;
        operation = row.operation;
        key = row.key;
        lwwTs = row.lww_timestamp;
        device = row.lww_device;
    }
    const deleted = operation === 'delete';
    let payload = row.payload;
    if (entityType === 'entry' && !deleted) {
        try {
            const parsed = JSON.parse(payload);
            if (typeof parsed.metadata_raw !== 'string' && typeof parsed.metadata === 'string') {
                payload = JSON.stringify({ ...parsed, metadata_raw: parsed.metadata });
            }
        }
        catch {
            // Keep malformed legacy payloads unchanged; the receiver rejects them.
        }
    }
    return {
        v: 1,
        type: entityType,
        key,
        lww: new Date(lwwTs).toISOString(),
        deleted,
        payload,
        ...(device ? { device } : {}),
    };
}
function envelopeToStaging(env, fallbackDeviceId) {
    const lwwTs = Date.parse(env.lww);
    return {
        key: env.key,
        entityType: env.type,
        operation: env.deleted ? 'delete' : 'upsert',
        payload: env.payload,
        lwwTimestamp: Number.isFinite(lwwTs) ? lwwTs : Date.now(),
        lwwDevice: env.device ?? fallbackDeviceId,
        lwwConfidence: 1.0,
        acked: false,
    };
}
function edgeCompositeKey(sourceId, targetId, type) {
    return `${sourceId}|${targetId}|${type}`;
}
//# sourceMappingURL=envelope.js.map