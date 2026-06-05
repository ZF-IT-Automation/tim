// TIM Store — Curation tools (hmem-compatible)
// Atomic rename, move, batch flag updates, tag operations.

import Database from 'better-sqlite3';
import type { Entry } from 'tim-core';
import { parseAndCoerceMetadata } from './metadata-coerce.js';

// ─── Internal Row Type ────────────────────────────────────

interface RowEntry {
  id: string;
  parent_id: string | null;
  title: string;
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
  favorite: number;
  tombstoned_at: string | null;
  metadata: string;
}

export interface UpdateManyFlags {
  irrelevant?: boolean;
  favorite?: boolean;
}

// ─── Helpers ─────────────────────────────────────────────

function rowToEntry(row: RowEntry): Entry {
  return {
    id: row.id,
    parentId: row.parent_id,
    title: row.title ?? '',
    content: row.content,
    contentType: row.content_type as Entry['contentType'],
    depth: row.depth,
    confidence: row.confidence,
    createdAt: row.created_at,
    accessedAt: row.accessed_at,
    decayRate: row.decay_rate,
    visibility: row.visibility,
    tags: JSON.parse(row.tags),
    irrelevant: row.irrelevant === 1,
    favorite: row.favorite === 1,
    tombstonedAt: row.tombstoned_at,
    metadata: parseAndCoerceMetadata(row.metadata),
  };
}

function getEntry(db: Database.Database, id: string): RowEntry | undefined {
  return db.prepare('SELECT * FROM entries WHERE id = ?').get(id) as RowEntry | undefined;
}

function stageEntry(db: Database.Database, row: RowEntry, device = 'local'): void {
  db.prepare(`INSERT INTO staging (key, entity_type, operation, payload,
    lww_timestamp, lww_device, lww_confidence)
    VALUES (?, 'entry', 'upsert', ?, ?, ?, ?)`).run(
    row.id,
    JSON.stringify(row),
    Date.now(),
    device,
    row.confidence,
  );
}

function stageEntries(db: Database.Database, ids: Iterable<string>): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const row = getEntry(db, id);
    if (row) stageEntry(db, row);
  }
}

function replaceIdInJsonString(json: string, oldId: string, newId: string): string {
  if (!json.includes(oldId)) return json;
  return json.split(oldId).join(newId);
}

// ─── CurateManager ─────────────────────────────────────────

export class CurateManager {
  constructor(private db: Database.Database) {}

  renameEntry(oldId: string, newId: string): Entry {
    if (oldId === newId) {
      throw new Error('oldId and newId must differ');
    }

    const transaction = this.db.transaction(() => {
      const existing = getEntry(this.db, oldId);
      if (!existing) throw new Error(`Entry not found: ${oldId}`);

      const collision = getEntry(this.db, newId);
      if (collision) throw new Error(`Entry already exists: ${newId}`);

      const affectedEntryIds = new Set<string>();

      // Insert copy under newId so FK targets exist before repointing references
      this.db.prepare(`
        INSERT INTO entries (id, parent_id, title, content, content_type, depth, confidence,
          created_at, accessed_at, decay_rate, visibility, tags, irrelevant, favorite,
          tombstoned_at, metadata)
        SELECT ?, parent_id, title, content, content_type, depth, confidence,
          created_at, accessed_at, decay_rate, visibility, tags, irrelevant, favorite,
          tombstoned_at, metadata
        FROM entries WHERE id = ?
      `).run(newId, oldId);

      // Edges referencing this ID
      this.db.prepare('UPDATE edges SET source_id = ? WHERE source_id = ?').run(newId, oldId);
      this.db.prepare('UPDATE edges SET target_id = ? WHERE target_id = ?').run(newId, oldId);

      // Child entries
      const children = this.db.prepare(
        'SELECT id FROM entries WHERE parent_id = ?',
      ).all(oldId) as { id: string }[];
      for (const child of children) affectedEntryIds.add(child.id);
      this.db.prepare('UPDATE entries SET parent_id = ? WHERE parent_id = ?').run(newId, oldId);

      // Staging key + payload references
      this.db.prepare('UPDATE staging SET key = ? WHERE key = ?').run(newId, oldId);
      const stagingRows = this.db.prepare(
        "SELECT rowid, payload FROM staging WHERE payload LIKE '%' || ? || '%'",
      ).all(oldId) as { rowid: number; payload: string }[];
      const updateStagingPayload = this.db.prepare('UPDATE staging SET payload = ? WHERE rowid = ?');
      for (const row of stagingRows) {
        updateStagingPayload.run(replaceIdInJsonString(row.payload, oldId, newId), row.rowid);
      }

      // Suppressed table (pattern / suppressed_by may embed IDs)
      this.db.prepare(
        "UPDATE suppressed SET pattern = replace(pattern, ?, ?) WHERE pattern LIKE '%' || ? || '%'",
      ).run(oldId, newId, oldId);
      this.db.prepare(
        "UPDATE suppressed SET suppressed_by = replace(suppressed_by, ?, ?) WHERE suppressed_by LIKE '%' || ? || '%'",
      ).run(oldId, newId, oldId);

      // Metadata JSON best-effort scan — entries
      const metaRows = this.db.prepare(
        "SELECT id, metadata FROM entries WHERE metadata LIKE '%' || ? || '%'",
      ).all(oldId) as { id: string; metadata: string }[];
      const updateMeta = this.db.prepare('UPDATE entries SET metadata = ? WHERE id = ?');
      for (const row of metaRows) {
        if (row.id === oldId || row.id === newId) continue;
        updateMeta.run(replaceIdInJsonString(row.metadata, oldId, newId), row.id);
        affectedEntryIds.add(row.id);
      }

      // Edge metadata
      const edgeMetaRows = this.db.prepare(
        "SELECT id, metadata FROM edges WHERE metadata LIKE '%' || ? || '%'",
      ).all(oldId) as { id: string; metadata: string }[];
      const updateEdgeMeta = this.db.prepare('UPDATE edges SET metadata = ? WHERE id = ?');
      for (const row of edgeMetaRows) {
        updateEdgeMeta.run(replaceIdInJsonString(row.metadata, oldId, newId), row.id);
      }

      // Remove old row (refs already repointed)
      this.db.prepare('DELETE FROM entries WHERE id = ?').run(oldId);

      const renamed = getEntry(this.db, newId)!;
      stageEntry(this.db, renamed);
      stageEntries(this.db, affectedEntryIds);

      return rowToEntry(renamed);
    });

    return transaction();
  }

  moveEntry(id: string, newParentId: string | null, order?: number): Entry {
    const transaction = this.db.transaction(() => {
      const entry = getEntry(this.db, id);
      if (!entry) throw new Error(`Entry not found: ${id}`);

      if (newParentId !== null) {
        const parent = getEntry(this.db, newParentId);
        if (!parent) throw new Error(`Parent not found: ${newParentId}`);
        if (newParentId === id) throw new Error('Entry cannot be its own parent');
      }

      let newDepth = 1;
      if (newParentId) {
        const parent = getEntry(this.db, newParentId)!;
        newDepth = Math.min(parent.depth + 1, 5);
      }

      this.db.prepare('UPDATE entries SET parent_id = ?, depth = ? WHERE id = ?')
        .run(newParentId, newDepth, id);

      const meta = JSON.parse(entry.metadata) as Record<string, unknown>;
      if (order !== undefined) {
        const siblings = this.db.prepare(`
          SELECT id, metadata FROM entries
          WHERE parent_id IS ? AND irrelevant = 0 AND id != ?
        `).all(newParentId, id) as { id: string; metadata: string }[];

        for (const sibling of siblings) {
          const sibMeta = JSON.parse(sibling.metadata) as Record<string, unknown>;
          const sibOrder = Number(sibMeta.order);
          if (Number.isFinite(sibOrder) && sibOrder >= order) {
            sibMeta.order = sibOrder + 1;
            this.db.prepare('UPDATE entries SET metadata = ? WHERE id = ?')
              .run(JSON.stringify(sibMeta), sibling.id);
          }
        }
        meta.order = order;
      } else if (newParentId) {
        const maxRow = this.db.prepare(`
          SELECT MAX(CAST(json_extract(metadata, '$.order') AS INTEGER)) AS max_order
          FROM entries WHERE parent_id = ? AND irrelevant = 0 AND id != ?
        `).get(newParentId, id) as { max_order: number | null };
        meta.order = (maxRow.max_order ?? -1) + 1;
      }

      this.db.prepare('UPDATE entries SET metadata = ? WHERE id = ?')
        .run(JSON.stringify(meta), id);

      // Cascade depth to descendants via recursive CTE
      this.db.prepare(`
        WITH RECURSIVE tree(id, depth) AS (
          SELECT id, depth FROM entries WHERE id = ?
          UNION ALL
          SELECT e.id, MIN(t.depth + 1, 5)
          FROM entries e
          INNER JOIN tree t ON e.parent_id = t.id
        )
        UPDATE entries SET depth = (
          SELECT tree.depth FROM tree WHERE tree.id = entries.id
        )
        WHERE id IN (SELECT id FROM tree)
      `).run(id);

      const affectedIds = this.db.prepare(`
        WITH RECURSIVE tree(id) AS (
          SELECT id FROM entries WHERE id = ?
          UNION ALL
          SELECT e.id FROM entries e
          INNER JOIN tree t ON e.parent_id = t.id
        )
        SELECT id FROM tree
      `).all(id) as { id: string }[];

      stageEntries(this.db, affectedIds.map(r => r.id));

      return rowToEntry(getEntry(this.db, id)!);
    });

    return transaction();
  }

  updateMany(ids: string[], flags: UpdateManyFlags): Entry[] {
    if (ids.length === 0) return [];
    if (flags.irrelevant === undefined && flags.favorite === undefined) {
      throw new Error('At least one flag (irrelevant, favorite) must be specified');
    }

    const transaction = this.db.transaction(() => {
      const results: Entry[] = [];

      for (const id of ids) {
        const entry = getEntry(this.db, id);
        if (!entry) throw new Error(`Entry not found: ${id}`);

        const sets: string[] = [];
        const params: unknown[] = [];

        if (flags.irrelevant !== undefined) {
          sets.push('irrelevant = ?');
          params.push(flags.irrelevant ? 1 : 0);
        }
        if (flags.favorite !== undefined) {
          sets.push('favorite = ?');
          params.push(flags.favorite ? 1 : 0);
        }

        params.push(id);
        this.db.prepare(`UPDATE entries SET ${sets.join(', ')} WHERE id = ?`).run(...params);

        const updated = getEntry(this.db, id)!;
        stageEntry(this.db, updated);
        results.push(rowToEntry(updated));
      }

      return results;
    });

    return transaction();
  }

  tagAdd(id: string, tags: string[]): Entry {
    const entry = getEntry(this.db, id);
    if (!entry) throw new Error(`Entry not found: ${id}`);

    let tagJson = entry.tags;
    for (const tag of tags) {
      const current = JSON.parse(tagJson) as string[];
      if (current.includes(tag)) continue;
      tagJson = (this.db.prepare("SELECT json_insert(?, '$[#]', ?) as tags")
        .get(tagJson, tag) as { tags: string }).tags;
    }

    this.db.prepare('UPDATE entries SET tags = ? WHERE id = ?')
      .run(tagJson, id);

    const updated = getEntry(this.db, id)!;
    stageEntry(this.db, updated);
    return rowToEntry(updated);
  }

  tagRemove(id: string, tags: string[]): Entry {
    const entry = getEntry(this.db, id);
    if (!entry) throw new Error(`Entry not found: ${id}`);

    let tagJson = entry.tags;
    for (const tag of tags) {
      const current = JSON.parse(tagJson) as string[];
      const idx = current.indexOf(tag);
      if (idx === -1) continue;
      tagJson = (this.db.prepare('SELECT json_remove(?, ?) as tags')
        .get(tagJson, `$[${idx}]`) as { tags: string }).tags;
    }

    this.db.prepare('UPDATE entries SET tags = ? WHERE id = ?')
      .run(tagJson, id);

    const updated = getEntry(this.db, id)!;
    stageEntry(this.db, updated);
    return rowToEntry(updated);
  }

  tagRename(oldTag: string, newTag: string): number {
    const rows = this.db.prepare(
      "SELECT id, tags FROM entries WHERE tags LIKE '%' || ? || '%'",
    ).all(oldTag) as { id: string; tags: string }[];

    const transaction = this.db.transaction(() => {
      let count = 0;
      for (const row of rows) {
        const tags = JSON.parse(row.tags) as string[];
        let changed = false;
        const updated = tags.map(t => {
          if (t === oldTag) {
            changed = true;
            return newTag;
          }
          return t;
        });
        if (!changed) continue;

        this.db.prepare('UPDATE entries SET tags = ? WHERE id = ?')
          .run(JSON.stringify(updated), row.id);

        const entry = getEntry(this.db, row.id)!;
        stageEntry(this.db, entry);
        count++;
      }
      return count;
    });

    return transaction();
  }
}
