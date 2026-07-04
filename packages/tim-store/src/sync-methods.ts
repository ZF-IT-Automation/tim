import type Database from 'better-sqlite3';
import { resolveLWW } from 'tim-core';
import type { StagingRecord } from 'tim-core';
import { parseAndCoerceMetadata } from './metadata-coerce.js';

export interface StagingRow {
  rowid: number;
  key: string;
  entity_type: string;
  operation: string;
  payload: string;
  lww_timestamp: number;
  lww_device: string;
  lww_confidence: number;
  acked: number;
}

export function getUnackedStaging(db: Database.Database): StagingRow[] {
  return db.prepare('SELECT * FROM staging WHERE acked = 0 ORDER BY rowid').all() as StagingRow[];
}

export function ackStaging(db: Database.Database, keys: string[]): void {
  if (keys.length === 0) return;
  const placeholders = keys.map(() => '?').join(',');
  db.prepare(`UPDATE staging SET acked = 1 WHERE key IN (${placeholders})`).run(...keys);
}

export function entryLocalLwwTimestamp(row: {
  updated_at?: string;
  created_at: string;
}): number {
  return Date.parse(String(row.updated_at ?? row.created_at));
}

export function edgeLocalLwwTimestamp(row: { updated_at?: string }): number {
  if (row.updated_at) return Date.parse(row.updated_at);
  return 0;
}

export function recordFromPayload(
  key: string,
  entityType: 'entry' | 'edge',
  operation: 'upsert' | 'delete',
  payload: string,
  lwwTimestamp: number,
  lwwDevice: string,
  confidence = 1.0,
): StagingRecord {
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

export function applyRemoteEntry(
  db: Database.Database,
  payloadJson: string,
  lwwTimestamp: number,
  lwwDevice: string,
  deleted: boolean,
): boolean {
  let entryId: string;
  try {
    entryId = (JSON.parse(payloadJson) as { id: string }).id;
  } catch {
    return false;
  }

  const remote = recordFromPayload(
    entryId,
    'entry',
    deleted ? 'delete' : 'upsert',
    payloadJson,
    lwwTimestamp,
    lwwDevice,
  );

  const existing = db.prepare('SELECT * FROM entries WHERE id = ?').get(entryId) as
    | Record<string, unknown>
    | undefined;

  if (existing) {
    const local = recordFromPayload(
      entryId,
      'entry',
      existing.tombstoned_at ? 'delete' : 'upsert',
      JSON.stringify(existing),
      entryLocalLwwTimestamp(existing as { updated_at?: string; created_at: string }),
      'local',
      Number(existing.confidence ?? 1),
    );
    const { winner } = resolveLWW(local, remote);
    if (winner !== remote) return false;
  } else if (deleted) {
    return false;
  }

  if (deleted) {
    db.prepare('UPDATE entries SET tombstoned_at = ? WHERE id = ?').run(
      new Date(lwwTimestamp).toISOString(),
      entryId,
    );
    return true;
  }

  const entry = JSON.parse(payloadJson) as {
    id: string;
    parent_id?: string | null;
    title?: string;
    content: string;
    content_type: string;
    depth: number;
    confidence: number;
    created_at: string;
    accessed_at: string;
    decay_rate: number;
    visibility: number;
    tags: string;
    irrelevant: number;
    favorite?: number;
    tombstoned_at: string | null;
    metadata: string;
  };

  const coercedMetadata = JSON.stringify(parseAndCoerceMetadata(entry.metadata));

  const updatedAt = new Date(lwwTimestamp).toISOString();
  db.prepare(`INSERT OR REPLACE INTO entries
    (id, parent_id, title, content, content_type, depth, confidence, created_at,
     accessed_at, updated_at, decay_rate, visibility, tags, irrelevant, favorite, tombstoned_at, metadata)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    entry.id,
    entry.parent_id ?? null,
    entry.title ?? '',
    entry.content,
    entry.content_type,
    entry.depth,
    entry.confidence,
    entry.created_at,
    entry.accessed_at,
    updatedAt,
    entry.decay_rate,
    entry.visibility,
    entry.tags,
    entry.irrelevant,
    entry.favorite ?? 0,
    entry.tombstoned_at,
    coercedMetadata,
  );
  return true;
}

export function applyRemoteEdge(
  db: Database.Database,
  payloadJson: string,
  lwwTimestamp: number,
  lwwDevice: string,
  deleted: boolean,
): boolean {
  let edge: {
    id: string;
    source_id: string;
    target_id: string;
    type: string;
    weight: number;
    metadata: string;
  };
  try {
    edge = JSON.parse(payloadJson) as typeof edge;
  } catch {
    return false;
  }

  const compositeKey = `${edge.source_id}|${edge.target_id}|${edge.type}`;
  const remote = recordFromPayload(
    compositeKey,
    'edge',
    deleted ? 'delete' : 'upsert',
    payloadJson,
    lwwTimestamp,
    lwwDevice,
  );

  const existing = db.prepare(
    'SELECT * FROM edges WHERE source_id = ? AND target_id = ? AND type = ?',
  ).get(edge.source_id, edge.target_id, edge.type) as Record<string, unknown> | undefined;

  if (existing) {
    const local = recordFromPayload(
      compositeKey,
      'edge',
      'upsert',
      JSON.stringify(existing),
      edgeLocalLwwTimestamp(existing as { updated_at?: string }),
      'local',
    );
    const { winner } = resolveLWW(local, remote);
    if (winner !== remote) return false;
  } else if (deleted) {
    return false;
  }

  if (deleted) {
    db.prepare('DELETE FROM edges WHERE id = ?').run(edge.id);
    return true;
  }

  const updatedAt = new Date(lwwTimestamp).toISOString();
  db.prepare(`INSERT OR REPLACE INTO edges (id, source_id, target_id, type, weight, metadata, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    edge.id,
    edge.source_id,
    edge.target_id,
    edge.type,
    edge.weight,
    edge.metadata,
    updatedAt,
  );
  return true;
}
