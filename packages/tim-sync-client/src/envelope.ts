import type { StagingRecord } from 'tim-core';

export interface TimEnvelope {
  v: 1;
  type: 'entry' | 'edge';
  key: string;
  lww: string;
  deleted: boolean;
  payload: string;
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

  if ('entityType' in row) {
    entityType = row.entityType;
    operation = row.operation;
    key = row.key;
    lwwTs = row.lwwTimestamp;
  } else {
    entityType = row.entity_type;
    operation = row.operation;
    key = row.key;
    lwwTs = row.lww_timestamp;
  }
  const deleted = operation === 'delete';

  return {
    v: 1,
    type: entityType as 'entry' | 'edge',
    key,
    lww: new Date(lwwTs).toISOString(),
    deleted,
    payload: row.payload,
  };
}

export function envelopeToStaging(env: TimEnvelope, deviceId: string): StagingRecord {
  const lwwTs = Date.parse(env.lww);
  return {
    key: env.key,
    entityType: env.type,
    operation: env.deleted ? 'delete' : 'upsert',
    payload: env.payload,
    lwwTimestamp: Number.isFinite(lwwTs) ? lwwTs : Date.now(),
    lwwDevice: deviceId,
    lwwConfidence: 1.0,
    acked: false,
  };
}

export function edgeCompositeKey(sourceId: string, targetId: string, type: string): string {
  return `${sourceId}|${targetId}|${type}`;
}
