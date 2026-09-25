import { normalizeLwwTimestamp, validProtocolBlob } from 'tim-core';
import type { PullBlob } from './client.js';
import type { StagingRecord } from 'tim-core';

export interface TimEnvelope {
  v: 1;
  type: 'entry' | 'edge';
  key: string;
  lww: string;
  deleted: boolean;
  payload: string;
  /** Original writer device; mandatory on the wire. Optional only for inspecting old queues. */
  device?: string;
  /** Inner secret-layer encryption applied to entry payload fields. */
  is_encrypted?: boolean;
}

export interface StagingRow {
  key: string;
  entity_type: string;
  operation: string;
  payload: string;
  lww_timestamp: number;
  lww_device: string;
  lww_confidence: number;
  acked: number;
}

export function stagingKey(entityType: 'entry' | 'edge', key: string): string {
  return `${entityType}:${key}`;
}

export function parseStagingKey(sk: string): { type: 'entry' | 'edge'; key: string } {
  const idx = sk.indexOf(':');
  if (idx < 0) return { type: 'entry', key: sk };
  const type = sk.slice(0, idx) as 'entry' | 'edge';
  return { type: type === 'edge' ? 'edge' : 'entry', key: sk.slice(idx + 1) };
}

export function stagingToEnvelope(row: StagingRow | StagingRecord): TimEnvelope {
  let entityType: string;
  let operation: string;
  let key: string;
  let lwwTs: number;
  let device: string | undefined;

  if ('entityType' in row) {
    entityType = row.entityType;
    operation = row.operation;
    key = row.key;
    lwwTs = row.lwwTimestamp;
    device = row.lwwDevice;
  } else {
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
      const parsed = JSON.parse(payload) as Record<string, unknown>;
      if (typeof parsed.metadata_raw !== 'string' && typeof parsed.metadata === 'string') {
        payload = JSON.stringify({ ...parsed, metadata_raw: parsed.metadata });
      }
    } catch {
      // Keep malformed legacy payloads unchanged; the receiver rejects them.
    }
  }

  return {
    v: 1,
    type: entityType as 'entry' | 'edge',
    key,
    lww: normalizeLwwTimestamp(lwwTs),
    deleted,
    payload,
    ...(device ? { device } : {}),
  };
}

export function envelopeToStaging(env: TimEnvelope, _fallbackDeviceId?: string): StagingRecord {
  if (!env.device) throw new Error('Envelope has no original LWW device');
  const lwwTs = Date.parse(normalizeLwwTimestamp(env.lww));
  return {
    key: env.key,
    entityType: env.type,
    operation: env.deleted ? 'delete' : 'upsert',
    payload: env.payload,
    lwwTimestamp: lwwTs,
    lwwDevice: env.device,
    lwwConfidence: 1.0,
    acked: false,
  };
}

export function edgeCompositeKey(sourceId: string, targetId: string, type: string): string {
  return `${sourceId}|${targetId}|${type}`;
}

/** Reject a whole page on malformed/unknown envelopes, never silently skip a row. */
export function validatePulledEnvelope(value: unknown, blob: PullBlob): asserts value is TimEnvelope {
  const e = value as TimEnvelope | null;
  if (!e || e.v !== 1 || !['entry','edge'].includes(e.type) || typeof e.deleted !== 'boolean'
    || typeof e.payload !== 'string' || typeof e.device !== 'string' || !e.device
    || (e.is_encrypted !== undefined && typeof e.is_encrypted !== 'boolean')) throw new Error('Unsupported or malformed envelope');
  if (!validProtocolBlob({ ...blob, proposed_id: blob.client_proposed_id })
    || blob.entity_type !== e.type || blob.entity_key !== e.key
    || blob.updated_at !== e.lww || blob.lww_device !== e.device) throw new Error('Envelope metadata mismatch');
  const p = JSON.parse(e.payload);
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw new Error('Malformed envelope payload');
  if (e.type === 'entry') {
    if (p.id !== e.key) throw new Error('Entry identity mismatch');
  } else {
    if (![p.source_id,p.target_id,p.type].every(x => typeof x === 'string' && x.length>0 && !x.includes('|'))
      || edgeCompositeKey(p.source_id,p.target_id,p.type) !== e.key) throw new Error('Edge identity mismatch');
  }
  const objectJson = (value: unknown): boolean => {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return !!parsed && typeof parsed === 'object' && !Array.isArray(parsed);
  };
  if (!e.deleted) {
    if (typeof p.id !== 'string' || !p.id) throw new Error('Missing payload ID');
    if (e.type === 'edge' && (!Number.isFinite(p.weight) || typeof p.metadata !== 'string' || !objectJson(p.metadata))) throw new Error('Malformed edge payload');
    if (e.type === 'entry' && (typeof p.content !== 'string' || typeof p.content_type !== 'string'
      || !Number.isFinite(p.depth) || !Number.isFinite(p.confidence)
      || typeof p.created_at !== 'string' || typeof p.accessed_at !== 'string'
      || !Number.isFinite(p.decay_rate) || !Number.isFinite(p.visibility)
      || typeof p.tags !== 'string' || !Number.isFinite(p.irrelevant))) throw new Error('Malformed entry payload');
    if (e.type === 'entry') {
      const tags = JSON.parse(p.tags);
      if (!Array.isArray(tags) || !tags.every(t => typeof t === 'string')
        || !objectJson(p.metadata ?? '{}')
        || (p.metadata_raw !== undefined && !objectJson(p.metadata_raw))
        || (p.title !== undefined && typeof p.title !== 'string')
        || (p.parent_id != null && typeof p.parent_id !== 'string')) throw new Error('Malformed entry fields');
    }
  }
}
