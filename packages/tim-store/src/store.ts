// TIM Store — v0.1.0-alpha
// SQLite-backed MemoryInterface implementation.

import Database from 'better-sqlite3';
import { ulid } from 'ulid';
import type {
  Entry, Edge, EdgeType, ReadOptions, WriteOptions,
  SearchOptions, MemoryInterface, HealthReport, MemoryStats,
  AgentIdentity, StagingRecord, ContentType,
} from 'tim-core';
import { runMigrations, createTriggers, getCurrentVersion } from './schema.js';

export class TimStore implements MemoryInterface {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    runMigrations(this.db);
    createTriggers(this.db);
  }

  close(): void {
    this.db.close();
  }

  // ─── CRUD ──────────────────────────────────────────────

  async read(id: string, options: ReadOptions = {}): Promise<Entry | null> {
    const entry = this.db.prepare('SELECT * FROM entries WHERE id = ?').get(id) as RowEntry | undefined;
    if (!entry) return null;

    // Visibility check
    const mask = options.visibilityMask ?? 7; // default: owner+trusted+leased
    if ((entry.visibility & mask) === 0) return null;
    if (!options.showIrrelevant && entry.irrelevant) return null;

    return rowToEntry(entry);
  }

  async write(content: string, options: WriteOptions = {}): Promise<Entry> {
    const id = ulid();
    const now = new Date().toISOString();
    const timestamp = Date.now();

    // Calculate depth
    let depth = 1;
    if (options.parentId) {
      const parent = this.db.prepare('SELECT depth FROM entries WHERE id = ?').get(options.parentId) as
        { depth: number } | undefined;
      if (parent) depth = Math.min(parent.depth + 1, 5);
    }

    const entry = {
      id,
      parent_id: options.parentId ?? null,
      content,
      content_type: options.contentType ?? 'text',
      depth,
      confidence: options.confidence ?? 1.0,
      created_at: now,
      accessed_at: now,
      decay_rate: options.decayRate ?? 0.0,
      visibility: options.visibility ?? 1,
      tags: JSON.stringify(options.tags ?? []),
      irrelevant: 0,
      tombstoned_at: null,
      metadata: JSON.stringify(options.metadata ?? {}),
    };

    this.db.prepare(`INSERT INTO entries (id, parent_id, content, content_type, depth,
      confidence, created_at, accessed_at, decay_rate, visibility, tags, irrelevant,
      tombstoned_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      entry.id, entry.parent_id, entry.content, entry.content_type, entry.depth,
      entry.confidence, entry.created_at, entry.accessed_at, entry.decay_rate,
      entry.visibility, entry.tags, entry.irrelevant, entry.tombstoned_at, entry.metadata
    );

    // Write to staging for sync
    this.db.prepare(`INSERT INTO staging (key, entity_type, operation, payload,
      lww_timestamp, lww_device, lww_confidence)
      VALUES (?, 'entry', 'upsert', ?, ?, ?, ?)`).run(
      id, JSON.stringify(entry), timestamp, 'local', options.confidence ?? 1.0
    );

    // Create edges if provided
    if (options.edges) {
      for (const edge of options.edges) {
        await this.link(entry.id, edge.targetId, edge.type, edge.weight, edge.metadata);
      }
    }

    return rowToEntry(entry);
  }

  async update(id: string, patch: Partial<Entry>): Promise<Entry> {
    const existing = this.db.prepare('SELECT * FROM entries WHERE id = ?').get(id) as RowEntry | undefined;
    if (!existing) throw new Error(`Entry not found: ${id}`);

    const now = new Date().toISOString();
    const timestamp = Date.now();

    const updated = {
      ...existing,
      content: patch.content ?? existing.content,
      content_type: patch.contentType ?? existing.content_type,
      confidence: patch.confidence ?? existing.confidence,
      decay_rate: patch.decayRate ?? existing.decay_rate,
      visibility: patch.visibility ?? existing.visibility,
      tags: patch.tags ? JSON.stringify(patch.tags) : existing.tags,
      irrelevant: patch.irrelevant ? 1 : existing.irrelevant,
      tombstoned_at: patch.tombstonedAt ?? existing.tombstoned_at,
      metadata: patch.metadata ? JSON.stringify(patch.metadata) : existing.metadata,
      accessed_at: now,
    };

    this.db.prepare(`UPDATE entries SET content=?, content_type=?, confidence=?,
      decay_rate=?, visibility=?, tags=?, irrelevant=?, tombstoned_at=?, metadata=?,
      accessed_at=? WHERE id=?`).run(
      updated.content, updated.content_type, updated.confidence,
      updated.decay_rate, updated.visibility, updated.tags,
      updated.irrelevant, updated.tombstoned_at, updated.metadata,
      updated.accessed_at, id
    );

    // Write to staging
    this.db.prepare(`INSERT INTO staging (key, entity_type, operation, payload,
      lww_timestamp, lww_device, lww_confidence)
      VALUES (?, 'entry', 'upsert', ?, ?, ?, ?)`).run(
      id, JSON.stringify(updated), timestamp, 'local', updated.confidence
    );

    return rowToEntry(updated);
  }

  async delete(id: string, hard: boolean = false): Promise<void> {
    if (hard) {
      const now = new Date().toISOString();
      this.db.prepare('UPDATE entries SET tombstoned_at = ? WHERE id = ?').run(now, id);
      this.db.prepare(`INSERT INTO staging (key, entity_type, operation, payload,
        lww_timestamp, lww_device, lww_confidence)
        VALUES (?, 'entry', 'delete', ?, ?, ?, ?)`).run(
        id, JSON.stringify({ id, tombstoned_at: now }), Date.now(), 'local', 1.0
      );
    } else {
      this.db.prepare('UPDATE entries SET irrelevant = 1 WHERE id = ?').run(id);
    }
  }

  // ─── Search ────────────────────────────────────────────

  async search(options: SearchOptions): Promise<Entry[]> {
    return this.searchFts(options.query, options.topK ?? 10);
  }

  async searchFts(query: string, limit: number = 10): Promise<Entry[]> {
    // Sanitize FTS5 query
    const sanitized = query.replace(/['"]/g, '');
    const rows = this.db.prepare(`
      SELECT e.* FROM entries e
      INNER JOIN fts_entries f ON e.rowid = f.rowid
      WHERE fts_entries MATCH ?
      AND e.irrelevant = 0
      ORDER BY rank
      LIMIT ?
    `).all(sanitized, limit) as RowEntry[];

    return rows.map(rowToEntry);
  }

  // ─── Edges ─────────────────────────────────────────────

  async link(
    sourceId: string, targetId: string, type: EdgeType,
    weight: number = 1.0, metadata: Record<string, unknown> = {}
  ): Promise<Edge> {
    const id = ulid();

    this.db.prepare(`INSERT INTO edges (id, source_id, target_id, type, weight, metadata)
      VALUES (?, ?, ?, ?, ?, ?)`).run(id, sourceId, targetId, type, weight, JSON.stringify(metadata));

    return { id, sourceId, targetId, type, weight, metadata };
  }

  async getEdges(id: string, direction: 'outgoing' | 'incoming' | 'both' = 'both'): Promise<Edge[]> {
    let rows: RowEdge[] = [];

    if (direction === 'outgoing' || direction === 'both') {
      const out = this.db.prepare('SELECT * FROM edges WHERE source_id = ?').all(id) as RowEdge[];
      rows.push(...out);
    }
    if (direction === 'incoming' || direction === 'both') {
      const inc = this.db.prepare('SELECT * FROM edges WHERE target_id = ?').all(id) as RowEdge[];
      rows.push(...inc);
    }

    return rows.map(rowToEdge);
  }

  async traceChain(startId: string, edgeType?: EdgeType, depth: number = 5): Promise<Entry[]> {
    const visited = new Set<string>();
    const result: Entry[] = [];
    const queue: string[] = [startId];

    while (queue.length > 0 && depth > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);

      const entry = await this.read(current);
      if (entry) result.push(entry);

      let edges: RowEdge[];
      if (edgeType) {
        edges = this.db.prepare('SELECT * FROM edges WHERE source_id = ? AND type = ?')
          .all(current, edgeType) as RowEdge[];
      } else {
        edges = this.db.prepare('SELECT * FROM edges WHERE source_id = ?')
          .all(current) as RowEdge[];
      }

      for (const edge of edges) {
        if (!visited.has(edge.target_id)) {
          queue.push(edge.target_id);
        }
      }
      depth--;
    }

    return result;
  }

  // ─── Agents ────────────────────────────────────────────

  async registerAgent(name: string, label: string): Promise<AgentIdentity> {
    const id = ulid();
    const now = new Date().toISOString();

    this.db.prepare(`INSERT INTO agents (id, name, label, registered_at, visibility_mask)
      VALUES (?, ?, ?, ?, 1)`).run(id, name, label, now);

    return { id, name, label, registeredAt: now, visibilityMask: 1 };
  }

  async getAgents(): Promise<AgentIdentity[]> {
    const rows = this.db.prepare('SELECT * FROM agents').all() as RowAgent[];
    return rows.map(r => ({
      id: r.id,
      name: r.name,
      label: r.label,
      registeredAt: r.registered_at,
      visibilityMask: r.visibility_mask,
    }));
  }

  // ─── Sync / Staging ────────────────────────────────────

  async getStaging(cursor?: number): Promise<StagingRecord[]> {
    let rows: RowStaging[];
    if (cursor !== undefined) {
      rows = this.db.prepare('SELECT * FROM staging WHERE rowid > ? ORDER BY rowid')
        .all(cursor) as RowStaging[];
    } else {
      rows = this.db.prepare('SELECT * FROM staging WHERE acked = 0 ORDER BY rowid')
        .all() as RowStaging[];
    }
    return rows.map(rowToStaging);
  }

  async applyStaging(records: StagingRecord[]): Promise<void> {
    const upsertEntry = this.db.prepare(`INSERT OR REPLACE INTO entries
      (id, parent_id, content, content_type, depth, confidence, created_at,
       accessed_at, decay_rate, visibility, tags, irrelevant, tombstoned_at, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

    const upsertEdge = this.db.prepare(`INSERT OR REPLACE INTO edges
      (id, source_id, target_id, type, weight, metadata)
      VALUES (?, ?, ?, ?, ?, ?)`);

    const deleteEntry = this.db.prepare('DELETE FROM entries WHERE id = ?');
    const deleteEdge = this.db.prepare('DELETE FROM edges WHERE id = ?');

    const transaction = this.db.transaction(() => {
      for (const record of records) {
        if (record.entityType === 'entry') {
          if (record.operation === 'delete') {
            const payload = JSON.parse(record.payload);
            deleteEntry.run(payload.id);
          } else {
            const entry = JSON.parse(record.payload) as RowEntry;
            upsertEntry.run(
              entry.id, entry.parent_id, entry.content, entry.content_type,
              entry.depth, entry.confidence, entry.created_at, entry.accessed_at,
              entry.decay_rate, entry.visibility, entry.tags,
              entry.irrelevant, entry.tombstoned_at, entry.metadata
            );
          }
        } else if (record.entityType === 'edge') {
          if (record.operation === 'delete') {
            const payload = JSON.parse(record.payload);
            deleteEdge.run(payload.id);
          } else {
            const edge = JSON.parse(record.payload) as RowEdge;
            upsertEdge.run(
              edge.id, edge.source_id, edge.target_id,
              edge.type, edge.weight, edge.metadata
            );
          }
        }
      }
    });

    transaction();
  }

  async getStagingCursor(): Promise<number> {
    const row = this.db.prepare('SELECT MAX(rowid) as cursor FROM staging').get() as
      { cursor: number | null };
    return row.cursor ?? 0;
  }

  async gcStaging(olderThanDays: number): Promise<number> {
    const threshold = Date.now() - olderThanDays * 86400_000;
    const result = this.db.prepare(
      'DELETE FROM staging WHERE acked = 1 AND lww_timestamp < ?'
    ).run(threshold);
    return result.changes;
  }

  // ─── Health ────────────────────────────────────────────

  async health(): Promise<HealthReport> {
    const issues: string[] = [];

    // Broken links: edges referencing deleted/tombstoned entries
    const brokenLinks = this.db.prepare(`
      SELECT COUNT(*) as count FROM edges e
      LEFT JOIN entries s ON e.source_id = s.id
      LEFT JOIN entries t ON e.target_id = t.id
      WHERE s.id IS NULL OR s.tombstoned_at IS NOT NULL
         OR t.id IS NULL OR t.tombstoned_at IS NOT NULL
    `).get() as { count: number };
    if (brokenLinks.count > 0) {
      issues.push(`${brokenLinks.count} broken links`);
    }

    // Orphan entries: no edges, no children, not root
    const orphans = this.db.prepare(`
      SELECT COUNT(*) as count FROM entries e
      WHERE e.parent_id IS NOT NULL
        AND e.id NOT IN (SELECT DISTINCT parent_id FROM entries WHERE parent_id IS NOT NULL)
        AND e.id NOT IN (SELECT source_id FROM edges)
        AND e.id NOT IN (SELECT target_id FROM edges)
    `).get() as { count: number };
    if (orphans.count > 0) {
      issues.push(`${orphans.count} orphan entries`);
    }

    // FTS integrity
    let ftsOk = true;
    try {
      this.db.prepare("INSERT INTO fts_entries(fts_entries) VALUES ('integrity-check')").run();
    } catch {
      ftsOk = false;
      issues.push('FTS5 index integrity failure');
    }

    // Counts
    const totalEntries = (this.db.prepare('SELECT COUNT(*) as count FROM entries WHERE irrelevant = 0').get() as { count: number }).count;
    const totalEdges = (this.db.prepare('SELECT COUNT(*) as count FROM edges').get() as { count: number }).count;

    return {
      brokenLinks: brokenLinks.count,
      orphanEntries: orphans.count,
      ftsIntegrity: ftsOk,
      totalEntries,
      totalEdges,
      issues,
    };
  }

  async stats(): Promise<MemoryStats> {
    const totalEntries = (this.db.prepare('SELECT COUNT(*) as c FROM entries WHERE irrelevant = 0').get() as { c: number }).c;
    const totalEdges = (this.db.prepare('SELECT COUNT(*) as c FROM edges').get() as { c: number }).c;

    // Depth distribution
    const depthRows = this.db.prepare('SELECT depth, COUNT(*) as c FROM entries WHERE irrelevant = 0 GROUP BY depth').all() as { depth: number; c: number }[];
    const entriesByDepth: Record<number, number> = {};
    for (const r of depthRows) entriesByDepth[r.depth] = r.c;

    // Content type distribution
    const typeRows = this.db.prepare('SELECT content_type, COUNT(*) as c FROM entries WHERE irrelevant = 0 GROUP BY content_type').all() as { content_type: string; c: number }[];
    const entriesByType: Record<string, number> = {};
    for (const r of typeRows) entriesByType[r.content_type] = r.c;

    // Top tags
    const allTags = this.db.prepare("SELECT tags FROM entries WHERE irrelevant = 0 AND tags != '[]'").all() as { tags: string }[];
    const tagCounts = new Map<string, number>();
    for (const row of allTags) {
      const tags = JSON.parse(row.tags) as string[];
      for (const tag of tags) {
        tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
      }
    }
    const topTags = [...tagCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([tag, count]) => ({ tag, count }));

    // Confidence
    const avgConf = (this.db.prepare('SELECT AVG(confidence) as avg FROM entries WHERE irrelevant = 0').get() as { avg: number }).avg;

    // Temporal
    const oldest = (this.db.prepare('SELECT created_at FROM entries WHERE irrelevant = 0 ORDER BY created_at LIMIT 1').get() as { created_at: string } | undefined)?.created_at ?? null;
    const newest = (this.db.prepare('SELECT created_at FROM entries WHERE irrelevant = 0 ORDER BY created_at DESC LIMIT 1').get() as { created_at: string } | undefined)?.created_at ?? null;

    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400_000).toISOString();
    const stale = (this.db.prepare('SELECT COUNT(*) as c FROM entries WHERE irrelevant = 0 AND accessed_at < ?').get(thirtyDaysAgo) as { c: number }).c;

    return { totalEntries, totalEdges, entriesByDepth, entriesByType, topTags, avgConfidence: avgConf, oldestEntry: oldest, newestEntry: newest, staleCount: stale };
  }

  // ─── Suppression ───────────────────────────────────────

  async suppress(pattern: string, reason: string, ttl?: string): Promise<void> {
    const now = new Date().toISOString();
    let expiresAt: string | null = null;

    if (ttl) {
      const match = ttl.match(/^(\d+)([hdm])$/);
      if (match) {
        const value = parseInt(match[1]);
        const unit = match[2];
        const ms = unit === 'h' ? 3600_000 : unit === 'd' ? 86400_000 : 60_000;
        expiresAt = new Date(Date.now() + value * ms).toISOString();
      }
    }

    this.db.prepare(`INSERT INTO suppressed (pattern, reason, suppressed_at, suppressed_by, expires_at)
      VALUES (?, ?, ?, ?, ?)`).run(pattern, reason, now, 'system', expiresAt);
  }

  async isSuppressed(content: string): Promise<boolean> {
    const now = new Date().toISOString();
    const patterns = this.db.prepare(
      'SELECT pattern FROM suppressed WHERE expires_at IS NULL OR expires_at > ?'
    ).all(now) as { pattern: string }[];

    return patterns.some(p => content.toLowerCase().includes(p.pattern.toLowerCase()));
  }
}

// ─── Row Types (internal) ───────────────────────────────

interface RowEntry {
  id: string;
  parent_id: string | null;
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
  tombstoned_at: string | null;
  metadata: string;
}

interface RowEdge {
  id: string;
  source_id: string;
  target_id: string;
  type: string;
  weight: number;
  metadata: string;
}

interface RowAgent {
  id: string;
  name: string;
  label: string;
  registered_at: string;
  visibility_mask: number;
}

interface RowStaging {
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

// ─── Row → Domain Mappers ───────────────────────────────

function rowToEntry(row: RowEntry): Entry {
  return {
    id: row.id,
    parentId: row.parent_id,
    content: row.content,
    contentType: row.content_type as ContentType,
    depth: row.depth,
    confidence: row.confidence,
    createdAt: row.created_at,
    accessedAt: row.accessed_at,
    decayRate: row.decay_rate,
    visibility: row.visibility,
    tags: JSON.parse(row.tags),
    irrelevant: row.irrelevant === 1,
    tombstonedAt: row.tombstoned_at,
    metadata: JSON.parse(row.metadata),
  };
}

function rowToEdge(row: RowEdge): Edge {
  return {
    id: row.id,
    sourceId: row.source_id,
    targetId: row.target_id,
    type: row.type as EdgeType,
    weight: row.weight,
    metadata: JSON.parse(row.metadata),
  };
}

function rowToStaging(row: RowStaging): StagingRecord {
  return {
    key: row.key,
    entityType: row.entity_type,
    operation: row.operation,
    payload: row.payload,
    lwwTimestamp: row.lww_timestamp,
    lwwDevice: row.lww_device,
    lwwConfidence: row.lww_confidence,
    acked: row.acked === 1,
  };
}
