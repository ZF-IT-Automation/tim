import Database from 'better-sqlite3';
import type { Entry } from 'tim-core';
import { SCHEMA_KINDS } from 'tim-core';
import type { TimStore } from './store.js';
import { titleSimilarity, cosineSimilarity } from './store.js';
import { parseAndCoerceMetadata } from './metadata-coerce.js';

export type ConsolidationType = 'duplicate' | 'decay';
export type CurationStatus = 'pending' | 'done' | 'rejected';

export interface ConsolidationCandidate {
  id: string;
  consolidation: ConsolidationType;
  pair?: [string, string];
  target?: string;
  score?: number;
  reason: string;
}

export interface CurationMetadata {
  kind: 'curation';
  consolidation: ConsolidationType;
  status: CurationStatus;
  pair?: [string, string];
  target?: string;
  score?: number;
  reason: string;
  project_ref: string;
  dedup_key: string;
}

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
  updated_at: string;
  decay_rate: number;
  visibility: number;
  tags: string;
  irrelevant: number;
  favorite: number;
  tombstoned_at: string | null;
  metadata: string;
}

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
    updatedAt: row.updated_at,
    decayRate: row.decay_rate,
    visibility: row.visibility,
    tags: JSON.parse(row.tags),
    irrelevant: row.irrelevant === 1,
    favorite: row.favorite === 1,
    tombstonedAt: row.tombstoned_at,
    metadata: parseAndCoerceMetadata(row.metadata),
  };
}

function pairDedupKey(id1: string, id2: string): string {
  const [a, b] = id1 < id2 ? [id1, id2] : [id2, id1];
  return `duplicate:${a}:${b}`;
}

function targetDedupKey(target: string): string {
  return `decay:${target}`;
}

function isContentEntry(entry: Entry): boolean {
  const kind = entry.metadata.kind as string | undefined;
  if (kind === 'curation') return false;
  if (kind && SCHEMA_KINDS.has(kind)) return false;
  return true;
}

const MS_PER_DAY = 86_400_000;

export class ConsolidationManager {
  constructor(
    private db: Database.Database,
    private store: TimStore,
  ) {}

  private async resolveProject(projectLabel: string): Promise<Entry> {
    return this.store.requireProject(projectLabel);
  }

  private getProjectContentEntries(projectId: string): Entry[] {
    const rows = this.db.prepare(`
      WITH RECURSIVE descendants AS (
        SELECT * FROM entries
        WHERE parent_id = ?
          AND tombstoned_at IS NULL
          AND irrelevant = 0
        UNION ALL
        SELECT e.* FROM entries e
        INNER JOIN descendants d ON e.parent_id = d.id
        WHERE e.tombstoned_at IS NULL AND e.irrelevant = 0
      )
      SELECT * FROM descendants
    `).all(projectId) as RowEntry[];
    return rows.map(rowToEntry).filter(isContentEntry);
  }

  private loadVectors(entryIds: string[]): Map<string, Float32Array> {
    if (entryIds.length === 0) return new Map();
    const rows = this.db.prepare(`
      SELECT entry_id, vector FROM entry_vectors
      WHERE entry_id IN (${entryIds.map(() => '?').join(', ')})
    `).all(...entryIds) as Array<{ entry_id: string; vector: Buffer }>;
    const map = new Map<string, Float32Array>();
    for (const row of rows) {
      map.set(
        row.entry_id,
        new Float32Array(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength / 4),
      );
    }
    return map;
  }

  private async findExistingCuration(
    projectLabel: string,
    dedupKey: string,
  ): Promise<Entry | null> {
    const rows = this.db.prepare(`
      SELECT * FROM entries
      WHERE json_extract(metadata, '$.kind') = 'curation'
        AND json_extract(metadata, '$.project_ref') = ?
        AND json_extract(metadata, '$.dedup_key') = ?
        AND json_extract(metadata, '$.status') != 'rejected'
        AND tombstoned_at IS NULL
        AND irrelevant = 0
      LIMIT 1
    `).all(projectLabel, dedupKey) as RowEntry[];
    return rows[0] ? rowToEntry(rows[0]) : null;
  }

  async enqueue(
    projectLabel: string,
    type: ConsolidationType,
    metadata: Omit<CurationMetadata, 'kind' | 'project_ref' | 'dedup_key'>,
  ): Promise<Entry | null> {
    const dedupKey =
      type === 'duplicate' && metadata.pair
        ? pairDedupKey(metadata.pair[0], metadata.pair[1])
        : metadata.target
          ? targetDedupKey(metadata.target)
          : null;
    if (!dedupKey) return null;

    const existing = await this.findExistingCuration(projectLabel, dedupKey);
    if (existing) return existing;

    const project = await this.resolveProject(projectLabel);
    const title =
      type === 'duplicate'
        ? `Duplicate: ${metadata.pair?.join(' ↔ ')}`
        : `Decay candidate: ${metadata.target}`;

    return this.store.write(title, {
      parentId: project.id,
      metadata: {
        kind: 'curation',
        project_ref: projectLabel,
        dedup_key: dedupKey,
        ...metadata,
      } as Record<string, unknown>,
      tags: ['#curation', `#${type}`],
    });
  }

  async getCurationQueue(projectLabel: string, status?: CurationStatus): Promise<Entry[]> {
    let sql = `
      SELECT * FROM entries
      WHERE json_extract(metadata, '$.kind') = 'curation'
        AND json_extract(metadata, '$.project_ref') = ?
        AND tombstoned_at IS NULL
        AND irrelevant = 0
    `;
    const params: unknown[] = [projectLabel];
    if (status) {
      sql += ` AND json_extract(metadata, '$.status') = ?`;
      params.push(status);
    }
    sql += ` ORDER BY created_at ASC`;
    const rows = this.db.prepare(sql).all(...params) as RowEntry[];
    return rows.map(rowToEntry);
  }

  async getCurationStats(projectLabel: string): Promise<Record<string, number>> {
    const rows = this.db.prepare(`
      SELECT
        json_extract(metadata, '$.status') AS status,
        json_extract(metadata, '$.consolidation') AS consolidation,
        COUNT(*) AS n
      FROM entries
      WHERE json_extract(metadata, '$.kind') = 'curation'
        AND json_extract(metadata, '$.project_ref') = ?
        AND tombstoned_at IS NULL
        AND irrelevant = 0
      GROUP BY status, consolidation
    `).all(projectLabel) as Array<{ status: string; consolidation: string; n: number }>;

    const stats: Record<string, number> = {};
    for (const row of rows) {
      const key = `${row.consolidation}:${row.status}`;
      stats[key] = row.n;
    }
    return stats;
  }

  async setCurationDone(entryId: string): Promise<Entry> {
    const entry = await this.store.read(entryId);
    if (!entry) throw new Error(`Curation entry not found: ${entryId}`);
    await this.store.update(entryId, {
      metadata: { ...entry.metadata, status: 'done' },
    });
    return (await this.store.read(entryId))!;
  }

  async setCurationRejected(entryId: string): Promise<Entry> {
    const entry = await this.store.read(entryId);
    if (!entry) throw new Error(`Curation entry not found: ${entryId}`);
    await this.store.update(entryId, {
      metadata: { ...entry.metadata, status: 'rejected' },
    });
    return (await this.store.read(entryId))!;
  }

  async findDuplicateCandidates(
    projectLabel: string,
    opts: { threshold?: number } = {},
  ): Promise<ConsolidationCandidate[]> {
    const titleThreshold = 0.6;
    const cosineThreshold = opts.threshold ?? 0.8;
    const project = await this.resolveProject(projectLabel);
    const entries = this.getProjectContentEntries(project.id);
    const vectors = this.loadVectors(entries.map(e => e.id));
    const candidates: ConsolidationCandidate[] = [];

    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const a = entries[i]!;
        const b = entries[j]!;
        const titleScore = titleSimilarity(a.title, b.title);
        let cosScore = 0;
        const va = vectors.get(a.id);
        const vb = vectors.get(b.id);
        if (va && vb) {
          cosScore = cosineSimilarity(va, vb);
        }
        const score = Math.max(titleScore, cosScore);
        const isDup = cosScore >= cosineThreshold || titleScore >= titleThreshold;
        if (!isDup) continue;

        const pair: [string, string] = a.id < b.id ? [a.id, b.id] : [b.id, a.id];
        const reason =
          cosScore >= cosineThreshold
            ? `cosine=${cosScore.toFixed(2)} title=${titleScore.toFixed(2)}`
            : `title=${titleScore.toFixed(2)}`;

        const written = await this.enqueue(projectLabel, 'duplicate', {
          consolidation: 'duplicate',
          status: 'pending',
          pair,
          score: Number(score.toFixed(3)),
          reason,
        });
        if (written) {
          candidates.push({
            id: written.id,
            consolidation: 'duplicate',
            pair,
            score: Number(score.toFixed(3)),
            reason,
          });
        }
      }
    }
    return candidates;
  }

  private hasFreshEdges(entryId: string, cutoffIso: string): boolean {
    const rows = this.db.prepare(`
      SELECT e.id, e.updated_at FROM edges ed
      JOIN entries e ON (
        (ed.source_id = ? AND e.id = ed.target_id)
        OR (ed.target_id = ? AND e.id = ed.source_id)
      )
      WHERE e.id != ?
        AND e.tombstoned_at IS NULL
        AND e.irrelevant = 0
        AND COALESCE(json_extract(e.metadata, '$.kind'), '') != 'curation'
    `).all(entryId, entryId, entryId) as Array<{ id: string; updated_at: string }>;

    return rows.some(row => row.updated_at >= cutoffIso);
  }

  async findDecayCandidates(
    projectLabel: string,
    opts: {
      accessDays?: number;
      accessCount?: number;
      verifiedDays?: number;
    } = {},
  ): Promise<ConsolidationCandidate[]> {
    const accessDays = opts.accessDays ?? 90;
    const accessCountMax = opts.accessCount ?? 3;
    const verifiedDays = opts.verifiedDays ?? 30;
    const now = Date.now();
    const accessCutoff = new Date(now - accessDays * MS_PER_DAY).toISOString();
    const verifiedCutoff = new Date(now - verifiedDays * MS_PER_DAY).toISOString();
    const edgeCutoff = accessCutoff;

    const project = await this.resolveProject(projectLabel);
    const entries = this.getProjectContentEntries(project.id);
    const refCounts = this.store.getReferenceCounts(entries.map(e => e.id));
    const candidates: ConsolidationCandidate[] = [];

    for (const entry of entries) {
      if (entry.accessedAt >= accessCutoff) continue;

      const accessCount =
        (typeof entry.metadata.access_count === 'number' ? entry.metadata.access_count : undefined)
        ?? refCounts.get(entry.id)
        ?? 0;
      if (accessCount >= accessCountMax) continue;

      const verifiedAt =
        typeof entry.metadata.verified_at === 'string'
          ? entry.metadata.verified_at
          : entry.updatedAt;
      if (verifiedAt >= verifiedCutoff) continue;

      if (this.hasFreshEdges(entry.id, edgeCutoff)) continue;

      const reason = `accessed=${entry.accessedAt.slice(0, 10)} refs=${accessCount} verified=${verifiedAt.slice(0, 10)}`;
      const written = await this.enqueue(projectLabel, 'decay', {
        consolidation: 'decay',
        status: 'pending',
        target: entry.id,
        reason,
      });
      if (written) {
        candidates.push({
          id: written.id,
          consolidation: 'decay',
          target: entry.id,
          reason,
        });
      }
    }
    return candidates;
  }
}
