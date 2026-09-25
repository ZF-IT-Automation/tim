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

/**
 * Mark pushed staging records as acknowledged.
 *
 * Matching is by key *and* timestamp, not by key alone: a local write that
 * lands while the push is in flight stages a newer record for the same key,
 * and that one has to stay unacked so the next cycle picks it up.
 *
 * ponytail: `<=` means two writes to one key inside the same millisecond, one
 * of them mid-push, still ack the newer record. `<` would be worse (the pushed
 * record would never ack at all). Give staging a monotonic sequence if that
 * millisecond ever matters.
 */
export function ackStaging(
  db: Database.Database,
  acks: Array<{ key: string; lww: number }>,
): void {
  if (acks.length === 0) return;
  const stmt = db.prepare('UPDATE staging SET acked = 1 WHERE key = ? AND lww_timestamp <= ?');
  db.transaction(() => {
    for (const ack of acks) stmt.run(ack.key, ack.lww);
  })();
}

export function entryLocalLwwTimestamp(row: {
  updated_at?: string;
  created_at: string;
  tombstoned_at?: string | null;
}): number {
  if (row.tombstoned_at) return Date.parse(row.tombstoned_at);
  return Date.parse(String(row.updated_at ?? row.created_at));
}

export type EntryLwwRow = {
  id: string;
  updated_at?: string;
  created_at: string;
  tombstoned_at?: string | null;
  lww_device?: string | null;
  confidence?: number | null;
};

export function localEntryRecordFromRow(row: EntryLwwRow): StagingRecord {
  const id = row.id;
  return recordFromPayload(
    id,
    'entry',
    row.tombstoned_at ? 'delete' : 'upsert',
    JSON.stringify(row),
    entryLocalLwwTimestamp(row),
    String(row.lww_device ?? 'local'),
    Number(row.confidence ?? 1),
  );
}

/** Persist a deletion tombstone, creating a placeholder row when the entry never existed locally. */
export function applyEntryTombstone(
  db: Database.Database,
  entryId: string,
  lwwTimestamp: number,
  lwwDevice: string,
): void {
  const tombstoneAt = new Date(lwwTimestamp).toISOString();
  const existing = db.prepare('SELECT id FROM entries WHERE id = ?').get(entryId);
  if (existing) {
    db.prepare(
      'UPDATE entries SET tombstoned_at = ?, updated_at = ?, lww_device = ? WHERE id = ?',
    ).run(tombstoneAt, tombstoneAt, lwwDevice, entryId);
  } else {
    db.prepare(`INSERT INTO entries
      (id, parent_id, title, content, content_type, depth, confidence, created_at,
       accessed_at, updated_at, decay_rate, visibility, tags, irrelevant, favorite, tombstoned_at, metadata, lww_device)
      VALUES (?, NULL, '', '', 'text', 1, 1.0, ?, ?, ?, 0, 1, '[]', 0, 0, ?, '{}', ?)`).run(
      entryId, tombstoneAt, tombstoneAt, tombstoneAt, tombstoneAt, lwwDevice,
    );
  }
}

/**
 * SQLite `datetime()` stores UTC as `YYYY-MM-DD HH:MM:SS` with no zone.
 * `Date.parse` treats that shape as local time, which shifts the instant.
 */
export function parseStoredUtcMillis(value: string | undefined): number {
  if (!value) return 0;
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(trimmed)) {
    const iso = `${trimmed.includes('T') ? trimmed : trimmed.replace(' ', 'T')}Z`;
    const parsed = Date.parse(iso);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function edgeLocalLwwTimestamp(row: { updated_at?: string }): number {
  return parseStoredUtcMillis(row.updated_at);
}

/**
 * Whether `remote` may replace `local`. A record with an empty device is an
 * unknown pre-T02 edge: only a strictly newer timestamp wins, so device `''`
 * cannot lose an equal-time tie.
 */
export function remoteEdgeWins(local: StagingRecord | undefined, remote: StagingRecord): boolean {
  if (!local) return true;
  if (local.lwwDevice === '') return remote.lwwTimestamp > local.lwwTimestamp;
  return resolveLWW(local, remote).winner === remote;
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
    | EntryLwwRow
    | undefined;

  if (existing) {
    const local = localEntryRecordFromRow(existing);
    const { winner } = resolveLWW(local, remote);
    if (winner !== remote) return false;
  }

  if (deleted) {
    applyEntryTombstone(db, entryId, lwwTimestamp, lwwDevice);
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
    metadata: string | Record<string, unknown>;
    metadata_raw?: string;
  };

  const legacyMetadata = typeof entry.metadata === 'string'
    ? entry.metadata
    : JSON.stringify(entry.metadata ?? {});
  const replicatedMetadata = typeof entry.metadata_raw === 'string'
    ? entry.metadata_raw
    : JSON.stringify(parseAndCoerceMetadata(legacyMetadata));

  // Slot-collision guard: batch-summaries share a UNIQUE slot on (parent_id, batch_index).
  // A remote entry with a different id but same slot must LWW-resolve against the local occupant.
  if (replicatedMetadata) {
    const meta = JSON.parse(replicatedMetadata) as Record<string, unknown>;
    if (meta.kind === 'batch-summary' && meta.batch_index !== undefined && entry.parent_id) {
      const slotOccupant = db.prepare(
        `SELECT id, updated_at, created_at, tombstoned_at, confidence, lww_device
         FROM entries
         WHERE parent_id = ? AND json_extract(metadata, '$.batch_index') = ?
           AND json_extract(metadata, '$.kind') = 'batch-summary'
           AND id != ?`,
      ).get(entry.parent_id, meta.batch_index, entry.id) as EntryLwwRow | undefined;
      if (slotOccupant) {
        const localSlot = localEntryRecordFromRow(slotOccupant);
        const slotRemote = recordFromPayload(
          entry.id, 'entry', 'upsert', payloadJson, lwwTimestamp, lwwDevice,
        );
        const { winner } = resolveLWW(localSlot, slotRemote);
        if (winner === localSlot) return false;
        db.prepare('DELETE FROM entries WHERE id = ?').run(slotOccupant.id);
      }
    }
  }

  const updatedAt = new Date(lwwTimestamp).toISOString();
  db.prepare(`INSERT INTO entries
    (id, parent_id, title, content, content_type, depth, confidence, created_at,
     accessed_at, updated_at, decay_rate, visibility, tags, irrelevant, favorite, tombstoned_at, metadata, lww_device)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      parent_id = excluded.parent_id,
      title = excluded.title,
      content = excluded.content,
      content_type = excluded.content_type,
      depth = excluded.depth,
      confidence = excluded.confidence,
      created_at = excluded.created_at,
      accessed_at = excluded.accessed_at,
      updated_at = excluded.updated_at,
      decay_rate = excluded.decay_rate,
      visibility = excluded.visibility,
      tags = excluded.tags,
      irrelevant = excluded.irrelevant,
      favorite = excluded.favorite,
      tombstoned_at = excluded.tombstoned_at,
      metadata = excluded.metadata,
      lww_device = excluded.lww_device`).run(
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
    replicatedMetadata,
    lwwDevice,
  );
  return true;
}


/** The register has no endpoint foreign keys: a delete can precede both endpoints. */
export function persistEdgeVersion(
  db: Database.Database, payload: string, timestamp: number, device: string, deleted: boolean,
): void {
  const edge = JSON.parse(payload) as { source_id: string; target_id: string; type: string };
  const key = `${edge.source_id}|${edge.target_id}|${edge.type}`;
  const existing = db.prepare(
    'SELECT lww_timestamp, lww_device, deleted FROM edge_versions WHERE entity_key = ?',
  ).get(key) as { lww_timestamp: number; lww_device: string; deleted: number } | undefined;
  if (existing) {
    const local = recordFromPayload(
      key, 'edge', existing.deleted ? 'delete' : 'upsert', payload,
      existing.lww_timestamp, existing.lww_device,
    );
    const incoming = recordFromPayload(
      key, 'edge', deleted ? 'delete' : 'upsert', payload, timestamp, device,
    );
    // Equal timestamp and device keep the current payload (resolveLWW returns the first).
    if (resolveLWW(local, incoming).winner !== incoming) return;
  }
  db.prepare(`INSERT INTO edge_versions (entity_key, payload, lww_timestamp, lww_device, deleted)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(entity_key) DO UPDATE SET payload=excluded.payload,
      lww_timestamp=excluded.lww_timestamp, lww_device=excluded.lww_device, deleted=excluded.deleted`)
    .run(key, payload, timestamp, device, Number(deleted));
}

export function localEdgeRecord(db: Database.Database, key: string): StagingRecord | undefined {
  const version = db.prepare('SELECT * FROM edge_versions WHERE entity_key = ?').get(key) as
    { payload: string; lww_timestamp: number; lww_device: string; deleted: number } | undefined;
  if (version) return recordFromPayload(key, 'edge', version.deleted ? 'delete' : 'upsert',
    version.payload, version.lww_timestamp, version.lww_device);
  // No register row: origin is unknown. Device '' must not lose an equal-time tie.
  const parts = key.split('|');
  const row = db.prepare('SELECT * FROM edges WHERE source_id=? AND target_id=? AND type=?')
    .get(...parts) as { updated_at?: string } | undefined;
  return row ? recordFromPayload(key, 'edge', 'upsert', JSON.stringify(row),
    edgeLocalLwwTimestamp(row), '') : undefined;
}

export function applyRemoteEdge(
  db: Database.Database,
  payloadJson: string,
  lwwTimestamp: number,
  lwwDevice: string,
  deleted: boolean,
): boolean {
  const edge = JSON.parse(payloadJson) as {
    id: string; source_id: string; target_id: string; type: string; weight: number; metadata: string;
  };
  const key = `${edge.source_id}|${edge.target_id}|${edge.type}`;
  const remote = recordFromPayload(key, 'edge', deleted ? 'delete' : 'upsert',
    payloadJson, lwwTimestamp, lwwDevice);
  return db.transaction(() => {
    const local = localEdgeRecord(db, key);
    if (!remoteEdgeWins(local, remote)) return false;
    if (!deleted) {
      const source = db.prepare('SELECT 1 AS present FROM entries WHERE id = ?').get(edge.source_id);
      const target = db.prepare('SELECT 1 AS present FROM entries WHERE id = ?').get(edge.target_id);
      if (!source || !target) {
        // Remember the logical edge so the page can be acknowledged. Do not
        // insert a physical row that the endpoint foreign keys would reject.
        persistEdgeVersion(db, payloadJson, lwwTimestamp, lwwDevice, false);
        return true;
      }
    }
    // Remove by logical identity, including older replicas' different row IDs.
    db.prepare('DELETE FROM edges WHERE source_id=? AND target_id=? AND type=?')
      .run(edge.source_id, edge.target_id, edge.type);
    if (!deleted) {
      db.prepare(`INSERT INTO edges (id, source_id, target_id, type, weight, metadata, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(edge.id, edge.source_id, edge.target_id,
        edge.type, edge.weight, edge.metadata, new Date(lwwTimestamp).toISOString());
    }
    persistEdgeVersion(db, payloadJson, lwwTimestamp, lwwDevice, deleted);
    return true;
  })();
}
