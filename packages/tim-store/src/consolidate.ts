import Database from 'better-sqlite3';
import type { Entry } from 'tim-core';
import { askJev, jevNoul, resolveJevApiKey, SCHEMA_KINDS } from 'tim-core';
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

/** Scored pairs plus how this call's Jev pass classified the ones it asked about. */
export interface DuplicateCandidateList extends Array<ConsolidationCandidate> {
  confirmed: number;
  rejected: number;
  /** Jev was configured but did not answer; these pairs were not queued and are asked again next run. */
  unconfirmed: number;
  /** Over this run's Jev budget; left for the next run. */
  deferred: number;
}

export interface CurationMetadata {
  kind: 'curation';
  consolidation: ConsolidationType;
  status: CurationStatus;
  pair?: [string, string];
  target?: string;
  score?: number;
  /** Jev noul when this pair was confirmed. Absent when confirmation was skipped or failed. */
  jev?: number;
  /** Set when Jev rejected the pair; such rows suppress re-asking on later scans. */
  rejected_by?: 'jev';
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

const JEV_DUPLICATE_NOUL = 0.7;
const JEV_CONFIRM_CONCURRENCY = 6;
// One request per pair: a project with hundreds of title look-alikes (P0062's
// post-mortem series had ~290) must not block the tool for minutes per scan.
const JEV_MAX_PAIRS_PER_RUN = 60;
const JEV_BODY_CHARS = 1500;
const JEV_SAME_FACT =
  'Do A and B record the same fact or task, so that one can be dropped without losing a distinct fact? A different date, version, subject or a follow-up is not the same fact.';

interface ScoredDuplicate {
  pair: [string, string];
  score: number;
  reason: string;
  a: Entry;
  b: Entry;
}

function duplicateCandidateList(): DuplicateCandidateList {
  const list = [] as ConsolidationCandidate[] as DuplicateCandidateList;
  list.confirmed = 0;
  list.rejected = 0;
  list.unconfirmed = 0;
  list.deferred = 0;
  return list;
}

function jevPairState(a: Entry, b: Entry): { a: { title: string; body: string }; b: { title: string; body: string } } {
  const clip = (entry: Entry) => ({ title: entry.title, body: entry.content.slice(0, JEV_BODY_CHARS) });
  return { a: clip(a), b: clip(b) };
}

async function mapConcurrent<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
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

  private hasJevRejection(projectLabel: string, dedupKey: string): boolean {
    return !!this.db.prepare(`
      SELECT 1 FROM entries
      WHERE json_extract(metadata, '$.kind') = 'curation'
        AND json_extract(metadata, '$.project_ref') = ?
        AND json_extract(metadata, '$.dedup_key') = ?
        AND json_extract(metadata, '$.rejected_by') = 'jev'
        AND tombstoned_at IS NULL
        AND irrelevant = 0
      LIMIT 1
    `).get(projectLabel, dedupKey);
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
    opts: { threshold?: number; confirm?: boolean } = {},
  ): Promise<DuplicateCandidateList> {
    const titleThreshold = 0.6;
    const cosineThreshold = opts.threshold ?? 0.8;
    // No key is the configured "off" state: exactly the pre-Jev queueing, not an outage.
    const confirm = opts.confirm !== false && resolveJevApiKey() !== undefined;
    const project = await this.resolveProject(projectLabel);
    const entries = this.getProjectContentEntries(project.id);
    const vectors = this.loadVectors(entries.map(e => e.id));
    const scored: ScoredDuplicate[] = [];

    for (let i = 0; i < entries.length; i++) {
      for (let j = i + 1; j < entries.length; j++) {
        const left = entries[i]!;
        const right = entries[j]!;
        const titleScore = titleSimilarity(left.title, right.title);
        let cosScore = 0;
        const va = vectors.get(left.id);
        const vb = vectors.get(right.id);
        if (va && vb) {
          cosScore = cosineSimilarity(va, vb);
        }
        const score = Math.max(titleScore, cosScore);
        const isDup = cosScore >= cosineThreshold || titleScore >= titleThreshold;
        if (!isDup) continue;

        const a = left.id < right.id ? left : right;
        const b = left.id < right.id ? right : left;
        const reason =
          cosScore >= cosineThreshold
            ? `cosine=${cosScore.toFixed(2)} title=${titleScore.toFixed(2)}`
            : `title=${titleScore.toFixed(2)}`;
        scored.push({
          pair: [a.id, b.id],
          score: Number(score.toFixed(3)),
          reason,
          a,
          b,
        });
      }
    }

    const candidates = duplicateCandidateList();
    const fresh: ScoredDuplicate[] = [];
    for (const item of scored) {
      const key = pairDedupKey(item.pair[0], item.pair[1]);
      const existing = await this.findExistingCuration(projectLabel, key);
      if (!existing) {
        if (confirm && this.hasJevRejection(projectLabel, key)) candidates.rejected++;
        else fresh.push(item);
        continue;
      }
      const storedScore = typeof existing.metadata.score === 'number' ? existing.metadata.score : item.score;
      const storedReason = typeof existing.metadata.reason === 'string' ? existing.metadata.reason : item.reason;
      candidates.push({
        id: existing.id,
        consolidation: 'duplicate',
        pair: item.pair,
        score: storedScore,
        reason: storedReason,
      });
    }

    if (!confirm) {
      for (const item of fresh) {
        const queued = await this.enqueueScoredDuplicate(projectLabel, item, item.reason);
        if (queued) candidates.push(queued);
      }
      return candidates;
    }

    candidates.deferred = Math.max(0, fresh.length - JEV_MAX_PAIRS_PER_RUN);
    const decisions = await mapConcurrent(fresh.slice(0, JEV_MAX_PAIRS_PER_RUN), JEV_CONFIRM_CONCURRENCY, async item => {
      const answers = await askJev('find-duplicates', jevPairState(item.a, item.b), {
        same: { type: 'noul', instructions: JEV_SAME_FACT },
      });
      const noul = answers ? jevNoul(answers, 'same') : undefined;
      if (noul === undefined) return { item, kind: 'unconfirmed' as const };
      if (noul >= JEV_DUPLICATE_NOUL) return { item, kind: 'confirmed' as const, noul };
      return { item, kind: 'rejected' as const };
    });

    for (const decision of decisions) {
      if (decision.kind === 'unconfirmed') {
        // Queued-but-unjudged pairs would never be asked again and could be merged
        // by processCurationQueue; leave them for the next run instead.
        candidates.unconfirmed++;
        continue;
      }
      if (decision.kind === 'rejected') {
        // Remembered so the next scan neither re-queues nor re-bills the same no.
        await this.enqueue(projectLabel, 'duplicate', {
          consolidation: 'duplicate',
          status: 'rejected',
          pair: decision.item.pair,
          score: decision.item.score,
          reason: `${decision.item.reason} rejected by jev`,
          rejected_by: 'jev',
        });
        candidates.rejected++;
        continue;
      }
      const reason = `${decision.item.reason} jev=${decision.noul.toFixed(2)}`;
      const queued = await this.enqueueScoredDuplicate(projectLabel, decision.item, reason, decision.noul);
      if (!queued) continue;
      candidates.confirmed++;
      candidates.push(queued);
    }
    return candidates;
  }

  private async enqueueScoredDuplicate(
    projectLabel: string,
    item: ScoredDuplicate,
    reason: string,
    jev?: number,
  ): Promise<ConsolidationCandidate | null> {
    const written = await this.enqueue(projectLabel, 'duplicate', {
      consolidation: 'duplicate',
      status: 'pending',
      pair: item.pair,
      score: item.score,
      reason,
      ...(jev !== undefined ? { jev } : {}),
    });
    if (!written) return null;
    return {
      id: written.id,
      consolidation: 'duplicate',
      pair: item.pair,
      score: item.score,
      reason,
    };
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
