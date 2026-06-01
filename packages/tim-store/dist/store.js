"use strict";
// TIM Store — v0.1.0-alpha
// SQLite-backed MemoryInterface implementation.
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TimStore = void 0;
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const ulid_1 = require("ulid");
const os = __importStar(require("os"));
const schema_js_1 = require("./schema.js");
const curate_js_1 = require("./curate.js");
class TimStore {
    db;
    emitter;
    agentId;
    constructor(dbPath, options = {}) {
        this.db = new better_sqlite3_1.default(dbPath);
        this.emitter = options.emitter;
        this.agentId = options.agentId ?? 'system';
        (0, schema_js_1.runMigrations)(this.db);
        (0, schema_js_1.createTriggers)(this.db);
    }
    emit(type, payload) {
        if (!this.emitter)
            return;
        try {
            void this.emitter.emit(type, payload).catch(err => {
                console.error(`[TimStore] event handler failed (${type}):`, err);
            });
        }
        catch (err) {
            console.error(`[TimStore] event emit failed (${type}):`, err);
        }
    }
    async read(id, options = {}) {
        let entry = this.db.prepare('SELECT * FROM entries WHERE id = ?').get(id);
        // Label-based fallback for hmem compatibility (e.g., "P0062", "L0042")
        if (!entry && /^[A-Z]\d{4}$/.test(id)) {
            entry = this.db.prepare("SELECT * FROM entries WHERE json_extract(metadata, '$.label') = ?").get(id);
        }
        if (!entry)
            return null;
        // Visibility check
        const mask = options.visibilityMask ?? 7; // default: owner+trusted+leased
        if ((entry.visibility & mask) === 0)
            return null;
        if (!options.showIrrelevant && entry.irrelevant)
            return null;
        return rowToEntry(entry);
    }
    async createProject(label, options = {}) {
        const metadata = {
            ...(options.metadata ?? {}),
            kind: 'project',
            label,
        };
        return this.write(options.content ?? label, { metadata });
    }
    async loadProject(label, options = {}) {
        const project = await this.read(label);
        if (!project)
            return null;
        const depth = options.depth ?? 3;
        const budget = options.budget ?? 200;
        const sections = options.sections ?? null;
        const children = [];
        let truncated = false;
        const matchesSection = (entry) => {
            if (!sections?.length)
                return true;
            const entryLabel = entry.metadata.label;
            return sections.some(section => section === entry.id || section === entryLabel);
        };
        const loadChildren = (parentId, currentDepth, filterSections) => {
            if (currentDepth > depth || truncated)
                return;
            let childEntries = this.db.prepare(`
        SELECT * FROM entries
        WHERE parent_id = ?
          AND irrelevant = 0
          AND tombstoned_at IS NULL
        ORDER BY COALESCE(CAST(json_extract(metadata, '$.order') AS INTEGER), 999999), created_at ASC
      `).all(parentId);
            if (filterSections && sections?.length) {
                childEntries = childEntries.filter(row => matchesSection(rowToEntry(row)));
            }
            for (const row of childEntries) {
                if (children.length >= budget) {
                    truncated = true;
                    return;
                }
                const child = rowToEntry(row);
                children.push(child);
                loadChildren(child.id, currentDepth + 1, false);
            }
        };
        loadChildren(project.id, 1, true);
        return { project, children, truncated };
    }
    async getChildren(parentId, filter) {
        let sql = `
      SELECT * FROM entries
      WHERE parent_id = ?
        AND irrelevant = 0
        AND tombstoned_at IS NULL
    `;
        const params = [parentId];
        if (filter?.metadataKind) {
            sql += ` AND json_extract(metadata, '$.kind') = ?`;
            params.push(filter.metadataKind);
        }
        sql += filter?.metadataKind === 'exchange'
            ? ` ORDER BY CAST(json_extract(metadata, '$.seq') AS INTEGER) ASC`
            : ` ORDER BY COALESCE(CAST(json_extract(metadata, '$.order') AS INTEGER), 999999), created_at ASC`;
        const rows = this.db.prepare(sql).all(...params);
        return rows.map(rowToEntry);
    }
    /** Get all entries with a given metadata.kind value (no parent filter). */
    async getByMetadataKind(kind, limit = 200) {
        const rows = this.db.prepare(`
      SELECT * FROM entries
      WHERE json_extract(metadata, '$.kind') = ?
        AND irrelevant = 0
        AND tombstoned_at IS NULL
      ORDER BY created_at DESC
      LIMIT ?
    `).all(kind, limit);
        return rows.map(rowToEntry);
    }
    async getChildByKind(parentId, kind) {
        const rows = this.db.prepare(`
      SELECT * FROM entries
      WHERE parent_id = ?
        AND json_extract(metadata, '$.kind') = ?
        AND irrelevant = 0
        AND tombstoned_at IS NULL
      ORDER BY COALESCE(CAST(json_extract(metadata, '$.seq') AS INTEGER), 999999),
               COALESCE(CAST(json_extract(metadata, '$.order') AS INTEGER), 999999),
               created_at ASC
    `).all(parentId, kind);
        return rows.map(rowToEntry);
    }
    async getChildrenBySeq(parentId) {
        const rows = this.db.prepare(`
      SELECT * FROM entries
      WHERE parent_id = ?
        AND irrelevant = 0
        AND tombstoned_at IS NULL
      ORDER BY COALESCE(CAST(json_extract(metadata, '$.seq') AS INTEGER), 999999),
               created_at ASC
    `).all(parentId);
        return rows.map(rowToEntry);
    }
    async getTasks(opts) {
        let sql = `
      SELECT e.* FROM entries e
      WHERE json_extract(e.metadata, '$.task') = true
        AND e.irrelevant = 0
        AND e.tombstoned_at IS NULL
    `;
        const params = [];
        if (opts?.status) {
            sql += ` AND json_extract(e.metadata, '$.status') = ?`;
            params.push(opts.status);
        }
        sql += `
      ORDER BY
        CASE json_extract(e.metadata, '$.status')
          WHEN 'in_progress' THEN 0
          WHEN 'todo' THEN 1
          ELSE 2
        END,
        CASE json_extract(e.metadata, '$.priority')
          WHEN 'high' THEN 0
          WHEN 'medium' THEN 1
          WHEN 'low' THEN 2
          ELSE 3
        END,
        CASE WHEN json_extract(e.metadata, '$.due') IS NULL THEN 1 ELSE 0 END,
        json_extract(e.metadata, '$.due') ASC
    `;
        const rows = this.db.prepare(sql).all(...params);
        return rows.map(row => {
            const meta = JSON.parse(row.metadata);
            return {
                id: row.id,
                title: row.title,
                content: row.content,
                parent_id: row.parent_id,
                project_label: this.resolveProjectLabel(row.parent_id),
                status: meta.status ?? null,
                priority: meta.priority ?? null,
                due: meta.due ?? null,
            };
        });
    }
    resolveProjectLabel(startParentId) {
        let currentId = startParentId;
        while (currentId) {
            const row = this.db.prepare('SELECT parent_id, metadata FROM entries WHERE id = ?').get(currentId);
            if (!row)
                return null;
            const meta = JSON.parse(row.metadata);
            if (meta.kind === 'project') {
                return meta.label ?? null;
            }
            currentId = row.parent_id;
        }
        return null;
    }
    close() {
        this.db.close();
    }
    curate() {
        return new curate_js_1.CurateManager(this.db);
    }
    /** @internal Exposed for tests */
    getDb() {
        return this.db;
    }
    async write(content, options = {}) {
        const now = new Date().toISOString();
        const id = options.id ?? `${os.hostname().slice(0, 4)}-${now.slice(5, 7)}${now.slice(8, 10)}-${(0, ulid_1.ulid)()}`;
        const timestamp = Date.now();
        const { title, body } = splitTitleBody(content, options.title);
        // Calculate depth
        let depth = 1;
        const parentId = options.parentId ?? null;
        if (parentId) {
            const parent = this.db.prepare('SELECT depth FROM entries WHERE id = ?').get(parentId);
            if (parent)
                depth = Math.min(parent.depth + 1, 5);
        }
        const metadata = { ...(options.metadata ?? {}) };
        if (parentId && metadata.order === undefined) {
            const maxRow = this.db.prepare(`
        SELECT MAX(CAST(json_extract(metadata, '$.order') AS INTEGER)) AS max_order
        FROM entries WHERE parent_id = ? AND irrelevant = 0
      `).get(parentId);
            metadata.order = (maxRow.max_order ?? -1) + 1;
        }
        const entry = {
            id,
            parent_id: parentId,
            title,
            content: body,
            content_type: options.contentType ?? 'text',
            depth,
            confidence: options.confidence ?? 1.0,
            created_at: now,
            accessed_at: now,
            decay_rate: options.decayRate ?? 0.0,
            visibility: options.visibility ?? 1,
            tags: JSON.stringify(options.tags ?? []),
            irrelevant: 0,
            favorite: 0,
            tombstoned_at: null,
            metadata: JSON.stringify(metadata),
        };
        this.db.prepare(`INSERT INTO entries (id, parent_id, title, content, content_type, depth,
      confidence, created_at, accessed_at, decay_rate, visibility, tags, irrelevant,
      favorite, tombstoned_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(entry.id, entry.parent_id, entry.title, entry.content, entry.content_type, entry.depth, entry.confidence, entry.created_at, entry.accessed_at, entry.decay_rate, entry.visibility, entry.tags, entry.irrelevant, entry.favorite, entry.tombstoned_at, entry.metadata);
        // Write to staging for sync
        this.db.prepare(`INSERT INTO staging (key, entity_type, operation, payload,
      lww_timestamp, lww_device, lww_confidence)
      VALUES (?, 'entry', 'upsert', ?, ?, ?, ?)`).run(id, JSON.stringify(entry), timestamp, 'local', options.confidence ?? 1.0);
        // Create edges if provided
        if (options.edges) {
            for (const edge of options.edges) {
                await this.link(entry.id, edge.targetId, edge.type, edge.weight, edge.metadata);
            }
        }
        const result = rowToEntry(entry);
        this.emit('memory:written', { entry: result, agentId: this.agentId, timestamp: now });
        return result;
    }
    async update(id, patch) {
        const existing = this.db.prepare('SELECT * FROM entries WHERE id = ?').get(id);
        if (!existing)
            throw new Error(`Entry not found: ${id}`);
        const now = new Date().toISOString();
        const timestamp = Date.now();
        let title = existing.title;
        let body = existing.content;
        if (patch.title !== undefined) {
            title = patch.title.trim();
        }
        if (patch.content !== undefined) {
            if (patch.title !== undefined) {
                body = patch.content;
            }
            else if (!existing.title.trim()) {
                const split = splitTitleBody(patch.content);
                title = split.title;
                body = split.body;
            }
            else {
                const nl = patch.content.indexOf('\n');
                body = nl === -1 ? patch.content.trim() : patch.content.slice(nl + 1).trim();
            }
        }
        const updated = {
            ...existing,
            title,
            content: body,
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
        this.db.prepare(`UPDATE entries SET title=?, content=?, content_type=?, confidence=?,
      decay_rate=?, visibility=?, tags=?, irrelevant=?, tombstoned_at=?, metadata=?,
      accessed_at=? WHERE id=?`).run(updated.title, updated.content, updated.content_type, updated.confidence, updated.decay_rate, updated.visibility, updated.tags, updated.irrelevant, updated.tombstoned_at, updated.metadata, updated.accessed_at, id);
        // Write to staging
        this.db.prepare(`INSERT INTO staging (key, entity_type, operation, payload,
      lww_timestamp, lww_device, lww_confidence)
      VALUES (?, 'entry', 'upsert', ?, ?, ?, ?)`).run(id, JSON.stringify(updated), timestamp, 'local', updated.confidence);
        const result = rowToEntry(updated);
        this.emit('memory:updated', { entry: result, agentId: this.agentId, timestamp: now });
        return result;
    }
    async delete(id, hard = false) {
        const existing = this.db.prepare('SELECT * FROM entries WHERE id = ?').get(id);
        if (!existing)
            return;
        const now = new Date().toISOString();
        if (hard) {
            this.db.prepare('UPDATE entries SET tombstoned_at = ? WHERE id = ?').run(now, id);
            this.db.prepare(`INSERT INTO staging (key, entity_type, operation, payload,
        lww_timestamp, lww_device, lww_confidence)
        VALUES (?, 'entry', 'delete', ?, ?, ?, ?)`).run(id, JSON.stringify({ id, tombstoned_at: now }), Date.now(), 'local', 1.0);
        }
        else {
            this.db.prepare('UPDATE entries SET irrelevant = 1 WHERE id = ?').run(id);
        }
        this.emit('memory:deleted', {
            entry: rowToEntry(existing),
            agentId: this.agentId,
            timestamp: now,
        });
    }
    // ─── Search ────────────────────────────────────────────
    async search(options) {
        return this.searchFts(options.query, options.topK ?? 10);
    }
    async searchFts(query, limit = 10) {
        // Sanitize FTS5 query
        const sanitized = query.replace(/['"]/g, '');
        const rows = this.db.prepare(`
      SELECT e.* FROM entries e
      INNER JOIN fts_entries f ON e.rowid = f.rowid
      WHERE fts_entries MATCH ?
      AND e.irrelevant = 0
      ORDER BY rank
      LIMIT ?
    `).all(sanitized, limit);
        return rows.map(rowToEntry);
    }
    // ─── Edges ─────────────────────────────────────────────
    async link(sourceId, targetId, type, weight = 1.0, metadata = {}) {
        const id = (0, ulid_1.ulid)();
        const edgeRow = {
            id,
            source_id: sourceId,
            target_id: targetId,
            type,
            weight,
            metadata: JSON.stringify(metadata),
        };
        this.db.prepare(`INSERT INTO edges (id, source_id, target_id, type, weight, metadata)
      VALUES (?, ?, ?, ?, ?, ?)`).run(edgeRow.id, edgeRow.source_id, edgeRow.target_id, edgeRow.type, edgeRow.weight, edgeRow.metadata);
        const edgeKey = `${sourceId}|${targetId}|${type}`;
        const ts = Date.now();
        this.db.prepare(`INSERT INTO staging (key, entity_type, operation, payload,
      lww_timestamp, lww_device, lww_confidence)
      VALUES (?, 'edge', 'upsert', ?, ?, ?, ?)`).run(edgeKey, JSON.stringify(edgeRow), ts, this.agentId, 1.0);
        const edge = { id, sourceId, targetId, type, weight, metadata };
        this.emit('edge:created', {
            edge,
            agentId: this.agentId,
            timestamp: new Date().toISOString(),
        });
        return edge;
    }
    async getEdges(id, direction = 'both') {
        let rows = [];
        if (direction === 'outgoing' || direction === 'both') {
            const out = this.db.prepare('SELECT * FROM edges WHERE source_id = ?').all(id);
            rows.push(...out);
        }
        if (direction === 'incoming' || direction === 'both') {
            const inc = this.db.prepare('SELECT * FROM edges WHERE target_id = ?').all(id);
            rows.push(...inc);
        }
        return rows.map(rowToEdge);
    }
    async traceChain(startId, edgeType, depth = 5) {
        const visited = new Set();
        const result = [];
        const queue = [startId];
        while (queue.length > 0 && depth > 0) {
            const current = queue.shift();
            if (visited.has(current))
                continue;
            visited.add(current);
            const entry = await this.read(current);
            if (entry)
                result.push(entry);
            let edges;
            if (edgeType) {
                edges = this.db.prepare('SELECT * FROM edges WHERE source_id = ? AND type = ?')
                    .all(current, edgeType);
            }
            else {
                edges = this.db.prepare('SELECT * FROM edges WHERE source_id = ?')
                    .all(current);
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
    async registerAgent(name, label) {
        const id = (0, ulid_1.ulid)();
        const now = new Date().toISOString();
        this.db.prepare(`INSERT INTO agents (id, name, label, registered_at, visibility_mask)
      VALUES (?, ?, ?, ?, 1)`).run(id, name, label, now);
        return { id, name, label, registeredAt: now, visibilityMask: 1 };
    }
    async getAgents() {
        const rows = this.db.prepare('SELECT * FROM agents').all();
        return rows.map(r => ({
            id: r.id,
            name: r.name,
            label: r.label,
            registeredAt: r.registered_at,
            visibilityMask: r.visibility_mask,
        }));
    }
    // ─── Sync / Staging ────────────────────────────────────
    async getStaging(cursor) {
        let rows;
        if (cursor !== undefined) {
            rows = this.db.prepare('SELECT * FROM staging WHERE rowid > ? ORDER BY rowid')
                .all(cursor);
        }
        else {
            rows = this.db.prepare('SELECT * FROM staging WHERE acked = 0 ORDER BY rowid')
                .all();
        }
        return rows.map(rowToStaging);
    }
    async applyStaging(records) {
        const upsertEntry = this.db.prepare(`INSERT OR REPLACE INTO entries
      (id, parent_id, title, content, content_type, depth, confidence, created_at,
       accessed_at, decay_rate, visibility, tags, irrelevant, favorite, tombstoned_at, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
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
                    }
                    else {
                        const entry = JSON.parse(record.payload);
                        upsertEntry.run(entry.id, entry.parent_id, entry.title ?? '', entry.content, entry.content_type, entry.depth, entry.confidence, entry.created_at, entry.accessed_at, entry.decay_rate, entry.visibility, entry.tags, entry.irrelevant, entry.favorite ?? 0, entry.tombstoned_at, entry.metadata);
                    }
                }
                else if (record.entityType === 'edge') {
                    if (record.operation === 'delete') {
                        const payload = JSON.parse(record.payload);
                        deleteEdge.run(payload.id);
                    }
                    else {
                        const edge = JSON.parse(record.payload);
                        upsertEdge.run(edge.id, edge.source_id, edge.target_id, edge.type, edge.weight, edge.metadata);
                    }
                }
            }
        });
        transaction();
    }
    async getStagingCursor() {
        const row = this.db.prepare('SELECT MAX(rowid) as cursor FROM staging').get();
        return row.cursor ?? 0;
    }
    async gcStaging(olderThanDays) {
        const threshold = Date.now() - olderThanDays * 86400_000;
        const result = this.db.prepare('DELETE FROM staging WHERE acked = 1 AND lww_timestamp < ?').run(threshold);
        return result.changes;
    }
    // ─── Health ────────────────────────────────────────────
    async health() {
        const issues = [];
        // Broken links: edges referencing deleted/tombstoned entries
        const brokenLinks = this.db.prepare(`
      SELECT COUNT(*) as count FROM edges e
      LEFT JOIN entries s ON e.source_id = s.id
      LEFT JOIN entries t ON e.target_id = t.id
      WHERE s.id IS NULL OR s.tombstoned_at IS NOT NULL
         OR t.id IS NULL OR t.tombstoned_at IS NOT NULL
    `).get();
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
    `).get();
        if (orphans.count > 0) {
            issues.push(`${orphans.count} orphan entries`);
        }
        // FTS integrity
        let ftsOk = true;
        try {
            this.db.prepare("INSERT INTO fts_entries(fts_entries) VALUES ('integrity-check')").run();
        }
        catch {
            ftsOk = false;
            issues.push('FTS5 index integrity failure');
        }
        // Counts
        const totalEntries = this.db.prepare('SELECT COUNT(*) as count FROM entries WHERE irrelevant = 0').get().count;
        const totalEdges = this.db.prepare('SELECT COUNT(*) as count FROM edges').get().count;
        return {
            brokenLinks: brokenLinks.count,
            orphanEntries: orphans.count,
            ftsIntegrity: ftsOk,
            totalEntries,
            totalEdges,
            issues,
        };
    }
    async stats() {
        const totalEntries = this.db.prepare('SELECT COUNT(*) as c FROM entries WHERE irrelevant = 0').get().c;
        const totalEdges = this.db.prepare('SELECT COUNT(*) as c FROM edges').get().c;
        // Depth distribution
        const depthRows = this.db.prepare('SELECT depth, COUNT(*) as c FROM entries WHERE irrelevant = 0 GROUP BY depth').all();
        const entriesByDepth = {};
        for (const r of depthRows)
            entriesByDepth[r.depth] = r.c;
        // Content type distribution
        const typeRows = this.db.prepare('SELECT content_type, COUNT(*) as c FROM entries WHERE irrelevant = 0 GROUP BY content_type').all();
        const entriesByType = {};
        for (const r of typeRows)
            entriesByType[r.content_type] = r.c;
        // Top tags
        const allTags = this.db.prepare("SELECT tags FROM entries WHERE irrelevant = 0 AND tags != '[]'").all();
        const tagCounts = new Map();
        for (const row of allTags) {
            const tags = JSON.parse(row.tags);
            for (const tag of tags) {
                tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
            }
        }
        const topTags = [...tagCounts.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, 20)
            .map(([tag, count]) => ({ tag, count }));
        // Confidence
        const avgConf = this.db.prepare('SELECT AVG(confidence) as avg FROM entries WHERE irrelevant = 0').get().avg;
        // Temporal
        const oldest = this.db.prepare('SELECT created_at FROM entries WHERE irrelevant = 0 ORDER BY created_at LIMIT 1').get()?.created_at ?? null;
        const newest = this.db.prepare('SELECT created_at FROM entries WHERE irrelevant = 0 ORDER BY created_at DESC LIMIT 1').get()?.created_at ?? null;
        const thirtyDaysAgo = new Date(Date.now() - 30 * 86400_000).toISOString();
        const stale = this.db.prepare('SELECT COUNT(*) as c FROM entries WHERE irrelevant = 0 AND accessed_at < ?').get(thirtyDaysAgo).c;
        return { totalEntries, totalEdges, entriesByDepth, entriesByType, topTags, avgConfidence: avgConf, oldestEntry: oldest, newestEntry: newest, staleCount: stale };
    }
    // ─── Suppression ───────────────────────────────────────
    async suppress(pattern, reason, ttl) {
        const now = new Date().toISOString();
        let expiresAt = null;
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
    async isSuppressed(content) {
        const now = new Date().toISOString();
        const patterns = this.db.prepare('SELECT pattern FROM suppressed WHERE expires_at IS NULL OR expires_at > ?').all(now);
        return patterns.some(p => content.toLowerCase().includes(p.pattern.toLowerCase()));
    }
    async runDecay(options) {
        const exclude = new Set(options.exclude ?? []);
        const rows = this.db.prepare(`
      SELECT id FROM entries
      WHERE created_at < ?
        AND irrelevant = 0
        AND tombstoned_at IS NULL
    `).all(options.before);
        let count = 0;
        for (const row of rows) {
            if (exclude.has(row.id))
                continue;
            await this.delete(row.id);
            count++;
        }
        return count;
    }
}
exports.TimStore = TimStore;
// ─── Row → Domain Mappers ───────────────────────────────
function splitTitleBody(content, explicitTitle) {
    if (explicitTitle !== undefined) {
        return { title: explicitTitle.trim(), body: content };
    }
    const nl = content.indexOf('\n');
    if (nl === -1)
        return { title: content.trim(), body: '' };
    return { title: content.slice(0, nl).trim(), body: content.slice(nl + 1).trim() };
}
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
        decayRate: row.decay_rate,
        visibility: row.visibility,
        tags: JSON.parse(row.tags),
        irrelevant: row.irrelevant === 1,
        favorite: row.favorite === 1,
        tombstonedAt: row.tombstoned_at,
        metadata: JSON.parse(row.metadata),
    };
}
function rowToEdge(row) {
    return {
        id: row.id,
        sourceId: row.source_id,
        targetId: row.target_id,
        type: row.type,
        weight: row.weight,
        metadata: JSON.parse(row.metadata),
    };
}
function rowToStaging(row) {
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
//# sourceMappingURL=store.js.map