"use strict";
// Read-only projection of the entry tree for `tim viewer`.
//
// Two deliberate departures from the rest of the CLI:
//
// 1. It does NOT go through TimStore. TimStore's constructor runs
//    migrations and re-creates the FTS triggers — both are writes — so it
//    cannot back a guaranteed-read-only surface. The viewer opens its own
//    `readonly` SQLite handle instead and mirrors the SELECTs that
//    store.ts uses (same filters, same ordering, same label fallback).
//    Everything from tim-store that takes a plain Database handle
//    (secret inheritance, metadata coercion) is reused as-is.
//
// 2. It applies NO budget, NO child cap and NO truncation, and it never
//    drops a node for render_depth=0 — unlike the MCP project renderer.
//    render_depth is surfaced as data instead, because verifying it is
//    the whole point of the viewer.
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ViewerData = exports.REDACTED_TITLE = void 0;
exports.sortChildren = sortChildren;
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const tim_store_1 = require("tim-store");
/** Metadata keys kept on a redacted secret node — structure, never payload. */
const STRUCTURAL_METADATA_KEYS = [
    'kind',
    'type',
    'label',
    'order',
    'seq',
    'batch_index',
    'render_depth',
    'renderDepthLoad',
    'renderDepthRead',
    'render_tail',
    'secret',
];
exports.REDACTED_TITLE = '[secret — redacted]';
const ENTRY_COLUMNS = 'id, parent_id, title, content, content_type, depth, confidence, created_at,' +
    ' accessed_at, updated_at, visibility, tags, irrelevant, favorite, tombstoned_at, metadata';
/** Mirrors store.ts rowToEntry: metadata coerced, tags parsed defensively. */
function parseRow(row) {
    let tags = [];
    try {
        const parsed = JSON.parse(row.tags);
        if (Array.isArray(parsed))
            tags = parsed;
    }
    catch {
        tags = [];
    }
    let metadata = {};
    try {
        metadata = (0, tim_store_1.parseAndCoerceMetadata)(row.metadata);
    }
    catch {
        metadata = {};
    }
    return { row, tags, metadata };
}
function metaString(entry, key) {
    const value = entry.metadata[key];
    return typeof value === 'string' ? value : null;
}
function taskStatusOf(entry) {
    const task = entry.metadata.task;
    if (task && typeof task === 'object') {
        const status = task.status;
        if (typeof status === 'string')
            return status;
    }
    return null;
}
function structuralMetadata(metadata) {
    const out = {};
    for (const key of STRUCTURAL_METADATA_KEYS) {
        if (metadata[key] !== undefined)
            out[key] = metadata[key];
    }
    return out;
}
class ViewerData {
    db;
    showSecrets;
    databasePath;
    constructor(db, options = {}) {
        this.db = db;
        this.showSecrets = options.showSecrets === true;
        this.databasePath = db.name;
    }
    /** Open the viewer's own read-only handle. Never migrates, never writes. */
    static open(dbPath, options = {}) {
        return new ViewerData(new better_sqlite3_1.default(dbPath, { readonly: true, fileMustExist: true }), options);
    }
    getDb() {
        return this.db;
    }
    close() {
        this.db.close();
    }
    /**
     * Resolve an entry by id, with the same label fallback store.read() has
     * (so "P0001" works as well as a raw entry id).
     */
    readEntry(id) {
        let row = this.db
            .prepare(`SELECT ${ENTRY_COLUMNS} FROM entries WHERE id = ?`)
            .get(id);
        if (!row && /^[A-Z]\d{4}$/.test(id)) {
            row = this.db.prepare(`SELECT ${ENTRY_COLUMNS} FROM entries
         WHERE json_extract(metadata, '$.label') = ? AND tombstoned_at IS NULL`).get(id);
        }
        return row ? parseRow(row) : null;
    }
    /**
     * Counted in one grouped query per batch of parents rather than a count
     * per node — a project's Exchanges subtree can be thousands wide.
     * `hidden` is what the store's read paths filter out (soft-deleted or
     * tombstoned): reported as a number so nothing is silently invisible.
     */
    childCounts(parentIds) {
        const counts = new Map();
        if (parentIds.length === 0)
            return counts;
        // Chunked to stay under the SQLite bound-parameter limit.
        for (let i = 0; i < parentIds.length; i += 400) {
            const chunk = parentIds.slice(i, i + 400);
            const placeholders = chunk.map(() => '?').join(',');
            const rows = this.db.prepare(`
        SELECT parent_id AS pid,
          SUM(CASE WHEN irrelevant = 0 AND tombstoned_at IS NULL THEN 1 ELSE 0 END) AS visible,
          SUM(CASE WHEN irrelevant = 1 OR tombstoned_at IS NOT NULL THEN 1 ELSE 0 END) AS hidden
        FROM entries
        WHERE parent_id IN (${placeholders})
        GROUP BY parent_id
      `).all(...chunk);
            for (const row of rows) {
                counts.set(row.pid, { visible: row.visible ?? 0, hidden: row.hidden ?? 0 });
            }
        }
        return counts;
    }
    toNode(entry, counts, secret) {
        const redacted = secret && !this.showSecrets;
        const row = entry.row;
        return {
            id: row.id,
            parentId: row.parent_id,
            title: redacted ? exports.REDACTED_TITLE : (row.title ?? ''),
            kind: metaString(entry, 'kind'),
            type: metaString(entry, 'type'),
            label: metaString(entry, 'label'),
            renderDepth: entry.metadata.render_depth ?? null,
            order: entry.metadata.order ?? null,
            seq: entry.metadata.seq ?? null,
            batchIndex: entry.metadata.batch_index ?? null,
            taskStatus: redacted ? null : taskStatusOf(entry),
            tags: redacted ? [] : entry.tags,
            contentChars: row.content ? row.content.length : 0,
            childCount: counts.visible,
            hiddenChildCount: counts.hidden,
            secret,
            redacted,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
        };
    }
    /** Entry points: every live entry with metadata.kind='project'. */
    listProjects() {
        const rows = this.db.prepare(`
      SELECT ${ENTRY_COLUMNS} FROM entries
      WHERE json_extract(metadata, '$.kind') = 'project'
        AND irrelevant = 0
        AND tombstoned_at IS NULL
      ORDER BY json_extract(metadata, '$.label') ASC, created_at ASC
    `).all();
        const projects = rows.map(parseRow);
        const counts = this.childCounts(projects.map(p => p.row.id));
        return projects.map(p => this.toNode(p, counts.get(p.row.id) ?? { visible: 0, hidden: 0 }, (0, tim_store_1.isSecret)(this.db, p.row.id)));
    }
    /**
     * Children of `id` — all of them, in tree order. `id` may be an entry id
     * or a project label.
     */
    children(id) {
        const parent = this.readEntry(id);
        if (!parent)
            return null;
        // Same visibility filter as store.getChildren().
        const rows = this.db.prepare(`
      SELECT ${ENTRY_COLUMNS} FROM entries
      WHERE parent_id = ?
        AND irrelevant = 0
        AND tombstoned_at IS NULL
    `).all(parent.row.id);
        const children = sortChildren(rows.map(parseRow));
        const counts = this.childCounts([parent.row.id, ...children.map(c => c.row.id)]);
        // Secrecy is inherited: resolve the parent chain once, then a child is
        // secret iff the parent is or it carries its own flag.
        const parentSecret = (0, tim_store_1.isSecret)(this.db, parent.row.id);
        return {
            parent: this.toNode(parent, counts.get(parent.row.id) ?? { visible: 0, hidden: 0 }, parentSecret),
            children: children.map(child => this.toNode(child, counts.get(child.row.id) ?? { visible: 0, hidden: 0 }, parentSecret || child.metadata.secret === true)),
        };
    }
    node(id) {
        const entry = this.readEntry(id);
        if (!entry)
            return null;
        const secret = (0, tim_store_1.isSecret)(this.db, entry.row.id);
        const counts = this.childCounts([entry.row.id]).get(entry.row.id) ?? {
            visible: 0,
            hidden: 0,
        };
        const base = this.toNode(entry, counts, secret);
        const row = entry.row;
        return {
            ...base,
            content: base.redacted ? null : row.content,
            contentType: row.content_type,
            metadata: base.redacted ? structuralMetadata(entry.metadata) : entry.metadata,
            depth: row.depth,
            confidence: row.confidence,
            visibility: row.visibility,
            favorite: row.favorite === 1,
            irrelevant: row.irrelevant === 1,
            accessedAt: row.accessed_at,
            path: this.ancestors(entry),
        };
    }
    /** Root-first breadcrumb, self excluded. */
    ancestors(entry) {
        const crumbs = [];
        const seen = new Set([entry.row.id]);
        let parentId = entry.row.parent_id;
        while (parentId && !seen.has(parentId)) {
            seen.add(parentId);
            const row = this.db
                .prepare('SELECT id, parent_id, title, metadata FROM entries WHERE id = ?')
                .get(parentId);
            if (!row)
                break;
            let meta = {};
            try {
                meta = JSON.parse(row.metadata);
            }
            catch {
                meta = {};
            }
            const crumbSecret = meta.secret === true || Number(meta.secret) === 1;
            crumbs.unshift({
                id: row.id,
                title: crumbSecret && !this.showSecrets ? exports.REDACTED_TITLE : (row.title ?? ''),
                kind: typeof meta.kind === 'string' ? meta.kind : null,
                label: typeof meta.label === 'string' ? meta.label : null,
            });
            parentId = row.parent_id;
        }
        return crumbs;
    }
    stats() {
        const one = (sql) => this.db.prepare(sql).get()?.c ?? 0;
        return {
            databasePath: this.databasePath,
            readOnly: this.db.readonly,
            schemaVersion: this.schemaVersion(),
            showSecrets: this.showSecrets,
            projectCount: one("SELECT COUNT(*) AS c FROM entries WHERE json_extract(metadata, '$.kind') = 'project'" +
                ' AND irrelevant = 0 AND tombstoned_at IS NULL'),
            totalEntries: one('SELECT COUNT(*) AS c FROM entries WHERE irrelevant = 0 AND tombstoned_at IS NULL'),
            hiddenEntries: one('SELECT COUNT(*) AS c FROM entries WHERE irrelevant = 1 OR tombstoned_at IS NOT NULL'),
            secretEntries: one("SELECT COUNT(*) AS c FROM entries WHERE json_extract(metadata, '$.secret') = 1"),
            edgeCount: one('SELECT COUNT(*) AS c FROM edges'),
        };
    }
    /** Schema version recorded in the file (0 when the table is absent). */
    schemaVersion() {
        try {
            const row = this.db.prepare('SELECT version FROM _schema_version').get();
            return row?.version ?? 0;
        }
        catch {
            return 0;
        }
    }
}
exports.ViewerData = ViewerData;
/**
 * Tree order. store.getChildren() sorts by metadata.order, but the store
 * auto-assigns `order` from insertion sequence, while session turns and
 * batch summaries carry their own authoritative seq / batch_index. Those
 * win when present, so Exchanges → Batch N → turns reads in true
 * conversation order; created_at breaks remaining ties.
 */
function sortChildren(children) {
    const rank = (entry) => {
        for (const key of ['seq', 'batch_index', 'order']) {
            const raw = entry.metadata[key];
            if (raw === undefined || raw === null)
                continue;
            const num = typeof raw === 'number' ? raw : Number(raw);
            if (Number.isFinite(num))
                return num;
        }
        return Number.POSITIVE_INFINITY;
    };
    return [...children].sort((a, b) => {
        const diff = rank(a) - rank(b);
        // Infinity - Infinity is NaN: both unranked, fall through to created_at.
        if (Number.isFinite(diff) && diff !== 0)
            return diff;
        return a.row.created_at.localeCompare(b.row.created_at);
    });
}
//# sourceMappingURL=viewer-data.js.map