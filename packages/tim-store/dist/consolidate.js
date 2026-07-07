"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ConsolidationManager = void 0;
const tim_core_1 = require("tim-core");
const store_js_1 = require("./store.js");
const metadata_coerce_js_1 = require("./metadata-coerce.js");
function rowToEntry(row) {
    return {
        id: row.id,
        parentId: row.parent_id,
        title: row.title ?? '',
        content: row.content,
        contentType: row.content_type,
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
        metadata: (0, metadata_coerce_js_1.parseAndCoerceMetadata)(row.metadata),
    };
}
function pairDedupKey(id1, id2) {
    const [a, b] = id1 < id2 ? [id1, id2] : [id2, id1];
    return `duplicate:${a}:${b}`;
}
function targetDedupKey(target) {
    return `decay:${target}`;
}
function isContentEntry(entry) {
    const kind = entry.metadata.kind;
    if (kind === 'curation')
        return false;
    if (kind && tim_core_1.SCHEMA_KINDS.has(kind))
        return false;
    return true;
}
const MS_PER_DAY = 86_400_000;
class ConsolidationManager {
    db;
    store;
    constructor(db, store) {
        this.db = db;
        this.store = store;
    }
    async resolveProject(projectLabel) {
        return this.store.requireProject(projectLabel);
    }
    getProjectContentEntries(projectId) {
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
    `).all(projectId);
        return rows.map(rowToEntry).filter(isContentEntry);
    }
    loadVectors(entryIds) {
        if (entryIds.length === 0)
            return new Map();
        const rows = this.db.prepare(`
      SELECT entry_id, vector FROM entry_vectors
      WHERE entry_id IN (${entryIds.map(() => '?').join(', ')})
    `).all(...entryIds);
        const map = new Map();
        for (const row of rows) {
            map.set(row.entry_id, new Float32Array(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength / 4));
        }
        return map;
    }
    async findExistingCuration(projectLabel, dedupKey) {
        const rows = this.db.prepare(`
      SELECT * FROM entries
      WHERE json_extract(metadata, '$.kind') = 'curation'
        AND json_extract(metadata, '$.project_ref') = ?
        AND json_extract(metadata, '$.dedup_key') = ?
        AND json_extract(metadata, '$.status') != 'rejected'
        AND tombstoned_at IS NULL
        AND irrelevant = 0
      LIMIT 1
    `).all(projectLabel, dedupKey);
        return rows[0] ? rowToEntry(rows[0]) : null;
    }
    async enqueue(projectLabel, type, metadata) {
        const dedupKey = type === 'duplicate' && metadata.pair
            ? pairDedupKey(metadata.pair[0], metadata.pair[1])
            : metadata.target
                ? targetDedupKey(metadata.target)
                : null;
        if (!dedupKey)
            return null;
        const existing = await this.findExistingCuration(projectLabel, dedupKey);
        if (existing)
            return existing;
        const project = await this.resolveProject(projectLabel);
        const title = type === 'duplicate'
            ? `Duplicate: ${metadata.pair?.join(' ↔ ')}`
            : `Decay candidate: ${metadata.target}`;
        return this.store.write(title, {
            parentId: project.id,
            metadata: {
                kind: 'curation',
                project_ref: projectLabel,
                dedup_key: dedupKey,
                ...metadata,
            },
            tags: ['#curation', `#${type}`],
        });
    }
    async getCurationQueue(projectLabel, status) {
        let sql = `
      SELECT * FROM entries
      WHERE json_extract(metadata, '$.kind') = 'curation'
        AND json_extract(metadata, '$.project_ref') = ?
        AND tombstoned_at IS NULL
        AND irrelevant = 0
    `;
        const params = [projectLabel];
        if (status) {
            sql += ` AND json_extract(metadata, '$.status') = ?`;
            params.push(status);
        }
        sql += ` ORDER BY created_at ASC`;
        const rows = this.db.prepare(sql).all(...params);
        return rows.map(rowToEntry);
    }
    async getCurationStats(projectLabel) {
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
    `).all(projectLabel);
        const stats = {};
        for (const row of rows) {
            const key = `${row.consolidation}:${row.status}`;
            stats[key] = row.n;
        }
        return stats;
    }
    async setCurationDone(entryId) {
        const entry = await this.store.read(entryId);
        if (!entry)
            throw new Error(`Curation entry not found: ${entryId}`);
        await this.store.update(entryId, {
            metadata: { ...entry.metadata, status: 'done' },
        });
        return (await this.store.read(entryId));
    }
    async setCurationRejected(entryId) {
        const entry = await this.store.read(entryId);
        if (!entry)
            throw new Error(`Curation entry not found: ${entryId}`);
        await this.store.update(entryId, {
            metadata: { ...entry.metadata, status: 'rejected' },
        });
        return (await this.store.read(entryId));
    }
    async findDuplicateCandidates(projectLabel, opts = {}) {
        const titleThreshold = 0.6;
        const cosineThreshold = opts.threshold ?? 0.8;
        const project = await this.resolveProject(projectLabel);
        const entries = this.getProjectContentEntries(project.id);
        const vectors = this.loadVectors(entries.map(e => e.id));
        const candidates = [];
        for (let i = 0; i < entries.length; i++) {
            for (let j = i + 1; j < entries.length; j++) {
                const a = entries[i];
                const b = entries[j];
                const titleScore = (0, store_js_1.titleSimilarity)(a.title, b.title);
                let cosScore = 0;
                const va = vectors.get(a.id);
                const vb = vectors.get(b.id);
                if (va && vb) {
                    cosScore = (0, store_js_1.cosineSimilarity)(va, vb);
                }
                const score = Math.max(titleScore, cosScore);
                const isDup = cosScore >= cosineThreshold || titleScore >= titleThreshold;
                if (!isDup)
                    continue;
                const pair = a.id < b.id ? [a.id, b.id] : [b.id, a.id];
                const reason = cosScore >= cosineThreshold
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
    hasFreshEdges(entryId, cutoffIso) {
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
    `).all(entryId, entryId, entryId);
        return rows.some(row => row.updated_at >= cutoffIso);
    }
    async findDecayCandidates(projectLabel, opts = {}) {
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
        const candidates = [];
        for (const entry of entries) {
            if (entry.accessedAt >= accessCutoff)
                continue;
            const accessCount = (typeof entry.metadata.access_count === 'number' ? entry.metadata.access_count : undefined)
                ?? refCounts.get(entry.id)
                ?? 0;
            if (accessCount >= accessCountMax)
                continue;
            const verifiedAt = typeof entry.metadata.verified_at === 'string'
                ? entry.metadata.verified_at
                : entry.updatedAt;
            if (verifiedAt >= verifiedCutoff)
                continue;
            if (this.hasFreshEdges(entry.id, edgeCutoff))
                continue;
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
exports.ConsolidationManager = ConsolidationManager;
//# sourceMappingURL=consolidate.js.map