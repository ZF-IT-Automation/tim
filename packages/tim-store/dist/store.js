"use strict";
// TIM Store — v0.1.0-alpha
// SQLite-backed MemoryInterface implementation.
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.TimStore = void 0;
exports.sanitizeFtsQuery = sanitizeFtsQuery;
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const ulid_1 = require("ulid");
const entry_id_js_1 = require("./entry-id.js");
const tim_sync_1 = require("tim-sync");
const schema_js_1 = require("./schema.js");
const curate_js_1 = require("./curate.js");
const metadata_coerce_js_1 = require("./metadata-coerce.js");
const sync_methods_js_1 = require("./sync-methods.js");
/**
 * Sanitize a user-supplied query string into a safe FTS5 MATCH expression.
 *
 * Problems this guards against (verified empirically against better-sqlite3 FTS5):
 *   1. `task:true` → "no such column: task"   (token:value parsed as column filter)
 *   2. `"foo AND bar"` literal text containing AND is a valid FTS5 operator,
 *      so users searching for "AND" or "OR" as words can collide with FTS5 syntax.
 *   3. Special chars `^ * ( ) " '` in raw input can throw `fts5: syntax error`.
 *
 * Strategy:
 *   - For `token:value` patterns, if `token` matches a real FTS5 column name
 *     (title, content, tags), pass through as-is. Otherwise, split into two
 *     tokens (the bogus "column" becomes a search term).
 *   - Drop FTS5 operator words (AND, OR, NOT, NEAR) case-insensitive.
 *   - Strip quotes/parens/carets/stars, replace with space.
 *   - Re-emit as `token1 token2` (implicit FTS5 AND).
 *   - Return empty string if no safe tokens survive — caller must skip the query.
 */
function sanitizeFtsQuery(query) {
    if (!query)
        return '';
    // FTS5 columns defined in schema.ts — these are the ONLY column names
    // a `token:value` filter is allowed to reference. Anything else is a
    // crash ("no such column: X").
    const REAL_COLUMNS = new Set(['title', 'content', 'tags']);
    // Step 1: rewrite each `token:` occurrence.
    //   - If token is a real FTS5 column (title/content/tags), preserve the
    //     `token:value` form (pass-through).
    //   - If token is NOT a real column, split it: keep the token as a
    //     search term AND keep the value as a search term.
    //     We do this by replacing the colon with a space, NOT the whole match.
    let s = query.replace(/([A-Za-z_][A-Za-z0-9_]*):/g, (m, col) => {
        if (REAL_COLUMNS.has(col.toLowerCase())) {
            return m; // keep "title:" / "content:" / "tags:" intact
        }
        return col + ' '; // "kind:summary" → "kind summary" (split, don't drop)
    });
    // Step 2: drop chars that confuse FTS5 tokenization: " ' ( ) * ^
    s = s.replace(/["'*()^]/g, ' ');
    // Step 3: split, drop operator words, trim.
    const tokens = s
        .split(/\s+/)
        .map(t => t.trim())
        .filter(t => t.length > 0)
        .filter(t => !/^(AND|OR|NOT|NEAR)$/i.test(t));
    if (tokens.length === 0)
        return '';
    // Implicit FTS5 AND — each token joined by space.
    return tokens.join(' ');
}
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
            entry = this.db.prepare("SELECT * FROM entries WHERE json_extract(metadata, '$.label') = ? AND tombstoned_at IS NULL").get(id);
        }
        if (!entry)
            return null;
        // Visibility check
        const mask = options.visibilityMask ?? 7; // default: owner+trusted+leased
        if ((entry.visibility & mask) === 0)
            return null;
        if (!options.showIrrelevant && entry.irrelevant)
            return null;
        const result = rowToEntry(entry);
        // Optionally include children (for tim_read with depth)
        if (options.includeChildren && options.depth !== 1) {
            const depth = options.depth ?? 2;
            const children = this.loadChildrenRecursive(result.id, depth, 1);
            result.children = children;
        }
        return result;
    }
    loadChildrenRecursive(parentId, maxDepth, currentDepth) {
        if (currentDepth > maxDepth)
            return [];
        const rows = this.db.prepare(`
      SELECT * FROM entries
      WHERE parent_id = ?
        AND irrelevant = 0
        AND tombstoned_at IS NULL
      ORDER BY COALESCE(CAST(json_extract(metadata, '$.order') AS INTEGER), 999999), created_at ASC
    `).all(parentId);
        return rows.map(row => {
            const child = rowToEntry(row);
            if (currentDepth < maxDepth) {
                const grandkids = this.loadChildrenRecursive(child.id, maxDepth, currentDepth + 1);
                if (grandkids.length > 0)
                    child.children = grandkids;
            }
            return child;
        });
    }
    async createProject(label, options = {}) {
        const aliases = normalizeProjectAliases(options.aliases);
        const metadata = {
            ...(options.metadata ?? {}),
            kind: 'project',
            label,
            ...(aliases.length > 0 ? { aliases } : {}),
        };
        const tx = this.db.transaction((labelArg) => {
            const dup = this.db.prepare(`
        SELECT id FROM entries
        WHERE json_extract(metadata, '$.kind') = 'project'
          AND json_extract(metadata, '$.label') = ?
          AND tombstoned_at IS NULL
      `).get(labelArg);
            if (dup) {
                throw new Error(`Project label already exists: ${labelArg} (${dup.id})`);
            }
            const { entry } = this.buildEntryRow(options.content ?? label, { metadata });
            this.insertEntrySync(entry);
            return entry;
        });
        const entry = tx.immediate(label);
        const timestamp = Date.now();
        this.insertStagingSync(entry, timestamp, 1.0);
        const result = rowToEntry(entry);
        this.emit('memory:written', { entry: result, agentId: this.agentId, timestamp: entry.created_at });
        return result;
    }
    /**
     * Resolve a project label or alias to a canonical P-label.
     * Direct label/id lookup first, then metadata.aliases scan.
     */
    async resolveProjectLabel(query) {
        const q = query.trim();
        if (!q)
            return { status: 'not_found', query: q };
        const direct = await this.read(q);
        if (direct?.metadata.kind === 'project') {
            const label = typeof direct.metadata.label === 'string' ? direct.metadata.label : q;
            return { status: 'found', label };
        }
        const labelRow = this.db.prepare(`
      SELECT metadata FROM entries
      WHERE json_extract(metadata, '$.kind') = 'project'
        AND json_extract(metadata, '$.label') = ?
        AND irrelevant = 0
        AND tombstoned_at IS NULL
    `).get(q);
        if (labelRow) {
            const meta = JSON.parse(labelRow.metadata);
            const label = typeof meta.label === 'string' ? meta.label : q;
            return { status: 'found', label };
        }
        const needle = q.toLowerCase();
        const rows = this.db.prepare(`
      SELECT metadata FROM entries
      WHERE json_extract(metadata, '$.kind') = 'project'
        AND irrelevant = 0
        AND tombstoned_at IS NULL
    `).all();
        const matches = [];
        for (const row of rows) {
            const meta = JSON.parse(row.metadata);
            const label = typeof meta.label === 'string' ? meta.label : '';
            if (!label)
                continue;
            const aliases = Array.isArray(meta.aliases) ? meta.aliases : [];
            if (aliases.some(a => String(a).toLowerCase() === needle)) {
                if (!matches.includes(label))
                    matches.push(label);
            }
        }
        if (matches.length === 0)
            return { status: 'not_found', query: q };
        if (matches.length === 1)
            return { status: 'found', label: matches[0] };
        return { status: 'ambiguous', query: q, labels: matches.sort() };
    }
    /**
     * Resolve a section by (projectId, title) within a project root.
     *
     * Sections are direct children of a project root (kind=project, parent_id=NULL
     * typically, or any node whose metadata.label matches). Used by tim_write to
     * disambiguate `parentTitle="Tasks"` lookups — silently picking the first
     * match caused orphan writes under wrong/legacy sections.
     *
     * Returns a tagged union:
     *   - found:      exactly one match.
     *   - not_found:  zero matches; `candidates` lists the section titles that
     *                 DO exist under the project (helps the caller recover).
     *   - ambiguous:  multiple matches; `candidates` carries id+title+project+
     *                 depth+createdAt for each (caller re-issues with parentId).
     */
    async resolveSectionByTitle(projectId, title) {
        const resolved = await this.resolveProjectLabel(projectId);
        if (resolved.status !== 'found') {
            // Project itself is missing or ambiguous. Surface as not_found with
            // project label untouched — caller can decide whether to escalate.
            return { status: 'not_found', project: projectId, title, candidates: [] };
        }
        const projectLabel = resolved.label;
        // Find the project root entry.
        const projectRow = this.db.prepare(`
      SELECT id FROM entries
      WHERE json_extract(metadata, '$.kind') = 'project'
        AND json_extract(metadata, '$.label') = ?
        AND irrelevant = 0
        AND tombstoned_at IS NULL
    `).get(projectLabel);
        if (!projectRow) {
            return { status: 'not_found', project: projectLabel, title, candidates: [] };
        }
        // All matches: every direct child of the project root with this title
        // that is still live (not irrelevant, not tombstoned).
        const matches = this.db.prepare(`
      SELECT e.id, e.title, e.depth, e.created_at
      FROM entries e
      WHERE e.parent_id = ?
        AND e.title = ?
        AND e.irrelevant = 0
      AND e.tombstoned_at IS NULL
        AND e.tombstoned_at IS NULL
      ORDER BY e.created_at ASC
    `).all(projectRow.id, title);
        if (matches.length === 1) {
            const m = matches[0];
            return {
                status: 'found',
                id: m.id,
                project: projectLabel,
                title: m.title,
            };
        }
        if (matches.length > 1) {
            const candidates = matches.map(m => ({
                id: m.id,
                title: m.title,
                project: projectLabel,
                depth: m.depth,
                createdAt: m.created_at,
            }));
            return { status: 'ambiguous', project: projectLabel, title, candidates };
        }
        // Zero matches. List sibling section titles under the project root so the
        // caller can see what's actually there.
        const siblings = this.db.prepare(`
      SELECT DISTINCT title FROM entries
      WHERE parent_id = ?
        AND irrelevant = 0
        AND tombstoned_at IS NULL
        AND title != ''
      ORDER BY title ASC
    `).all(projectRow.id);
        return {
            status: 'not_found',
            project: projectLabel,
            title,
            candidates: siblings.map(s => s.title),
        };
    }
    /** Resolve label/alias/id to a project entry; throws on missing or ambiguous. */
    async requireProject(projectId) {
        const resolved = await this.resolveProjectLabel(projectId);
        if (resolved.status === 'ambiguous') {
            throw new Error(`Ambiguous project identifier: ${projectId} (candidates: ${resolved.labels.join(', ')})`);
        }
        if (resolved.status !== 'found') {
            throw new Error(`Project not found: ${projectId}`);
        }
        const project = await this.read(resolved.label);
        if (!project || project.metadata.kind !== 'project') {
            throw new Error(`Project not found: ${projectId}`);
        }
        return project;
    }
    async loadProject(label, options = {}) {
        const resolved = await this.resolveProjectLabel(label);
        if (resolved.status !== 'found')
            return null;
        const project = await this.read(resolved.label);
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
    /**
     * Count sessions recorded under a project (by label or id). One session
     * entry (kind=session) is created per session start, so this is the
     * "sessions so far" count used to gate periodic project-summary generation.
     * Kinds are literals to avoid a session-tree → store import cycle.
     */
    async countSessionSummaries(projectLabel) {
        const project = await this.read(projectLabel);
        if (!project)
            return 0;
        const sessionsRoot = this.db.prepare(`
      SELECT id FROM entries
      WHERE parent_id = ?
        AND json_extract(metadata, '$.kind') = 'sessions-root'
        AND tombstoned_at IS NULL
    `).get(project.id);
        if (!sessionsRoot)
            return 0;
        const row = this.db.prepare(`
      SELECT COUNT(*) AS n FROM entries
      WHERE parent_id = ?
        AND json_extract(metadata, '$.kind') = 'session'
        AND irrelevant = 0
        AND tombstoned_at IS NULL
    `).get(sessionsRoot.id);
        return row.n;
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
    /**
     * Query root-level entries (parent_id IS NULL) that are not projects.
     * Filter by either:
     *   - `type`: exact match on `json_extract(metadata, '$.type')` (preferred)
     *   - `tag` : legacy string-tag match via JSON-LIKE (deprecated, kept
     *             for backward compatibility with the pre-Phase-0 hook)
     *
     * `type` takes precedence if both are supplied.
     */
    getRootLevelEntries(filter) {
        let sql = `
      SELECT * FROM entries
      WHERE parent_id IS NULL
        AND (json_extract(metadata, '$.kind') != 'project' OR json_extract(metadata, '$.kind') IS NULL)
        AND irrelevant = 0
        AND tombstoned_at IS NULL
    `;
        const params = [];
        if (filter?.type) {
            sql += ` AND json_extract(metadata, '$.type') = ?`;
            params.push(filter.type);
        }
        else if (filter?.tag) {
            sql += ` AND tags LIKE ?`;
            // Match the tag within JSON array: e.g., '%"#rule"%' (legacy).
            params.push(`%"${filter.tag}"%`);
        }
        sql += ` ORDER BY created_at ASC`;
        const rows = this.db.prepare(sql).all(...params);
        return rows.map(rowToEntry);
    }
    async getTasks(opts) {
        let sql = `
      SELECT e.* FROM entries e
      WHERE json_extract(e.metadata, '$.task') IS NOT NULL
        AND json_extract(e.metadata, '$.task') != false
        AND e.irrelevant = 0
        AND e.tombstoned_at IS NULL
    `;
        const params = [];
        if (opts?.status) {
            sql += ` AND COALESCE(
        json_extract(e.metadata, '$.task.status'),
        json_extract(e.metadata, '$.status')
      ) = ?`;
            params.push(opts.status);
        }
        sql += `
      ORDER BY
        CASE COALESCE(
          json_extract(e.metadata, '$.task.status'),
          json_extract(e.metadata, '$.status')
        )
          WHEN 'in_progress' THEN 0
          WHEN 'todo' THEN 1
          ELSE 2
        END,
        CASE COALESCE(
          json_extract(e.metadata, '$.task.priority'),
          json_extract(e.metadata, '$.priority')
        )
          WHEN 'high' THEN 0
          WHEN 'medium' THEN 1
          WHEN 'low' THEN 2
          ELSE 3
        END,
        CASE WHEN COALESCE(
          json_extract(e.metadata, '$.task.due_date'),
          json_extract(e.metadata, '$.due')
        ) IS NULL THEN 1 ELSE 0 END,
        COALESCE(
          json_extract(e.metadata, '$.task.due_date'),
          json_extract(e.metadata, '$.due')
        ) ASC
    `;
        const rows = this.db.prepare(sql).all(...params);
        return rows.map(row => {
            const meta = JSON.parse(row.metadata);
            let status = null;
            let priority = null;
            let due = null;
            const task = meta.task;
            if (typeof task === 'object' && task !== null && !Array.isArray(task)) {
                const tm = task;
                status = tm.status ?? null;
                priority = tm.priority ?? null;
                due = tm.due_date ?? null;
            }
            else if (task === true) {
                status = meta.status ?? null;
                priority = meta.priority ?? null;
                due = meta.due ?? null;
            }
            return {
                id: row.id,
                title: row.title,
                content: row.content,
                parent_id: row.parent_id,
                project_label: this.findProjectLabelForParent(row.parent_id),
                status,
                priority,
                due,
            };
        });
    }
    async getRules() {
        const rows = this.db.prepare(`
      SELECT e.* FROM entries e
      WHERE (
        json_extract(e.metadata, '$.type') = 'rule'
        OR (
          json_extract(e.metadata, '$.rule') IS NOT NULL
          AND json_extract(e.metadata, '$.rule') != false
        )
        OR e.tags LIKE '%"#rule"%'
      )
        AND e.irrelevant = 0
        AND e.tombstoned_at IS NULL
      ORDER BY e.created_at ASC
    `).all();
        return rows.map(row => {
            const meta = JSON.parse(row.metadata);
            let trigger = null;
            let action = null;
            const rule = meta.rule;
            if (typeof rule === 'object' && rule !== null && !Array.isArray(rule)) {
                const rm = rule;
                trigger = typeof rm.trigger === 'string' ? rm.trigger : null;
                action = typeof rm.action === 'string' ? rm.action : null;
            }
            else if (meta.type === 'rule') {
                action = row.title || null;
            }
            return {
                id: row.id,
                title: row.title,
                content: row.content,
                parent_id: row.parent_id,
                project_label: this.findProjectLabelForParent(row.parent_id),
                trigger,
                action,
            };
        });
    }
    /** All project root nodes (kind='project'). Used for cross-project overview + name resolution. */
    async listProjects() {
        const rows = this.db.prepare(`
      SELECT id, title, metadata FROM entries
      WHERE json_extract(metadata, '$.kind') = 'project'
        AND irrelevant = 0
        AND tombstoned_at IS NULL
      ORDER BY json_extract(metadata, '$.label') ASC
    `).all();
        return rows.map(r => {
            const meta = JSON.parse(r.metadata);
            return { id: r.id, label: meta.label ?? r.id, title: r.title ?? '' };
        });
    }
    /**
     * Entries carrying a tag. Tags stored as JSON array string → matched with
     * `tags LIKE '%"<tag>"%'`. `tag` is normalized: leading '#' kept as stored
     * (caller passes exact stored form, e.g. '#bug'). `limit` is an INTERNAL
     * safety cap (default 1000), NOT the user-facing limit.
     */
    async getByTag(tag, limit = 1000) {
        const rows = this.db.prepare(`
      SELECT * FROM entries
      WHERE tags LIKE ?
        AND irrelevant = 0
        AND tombstoned_at IS NULL
      ORDER BY created_at DESC
      LIMIT ?
    `).all(`%"${tag}"%`, limit);
        return rows.map(rowToEntry);
    }
    /** Entries where json_extract(metadata,'$.type') = type. `limit` internal cap (default 1000). */
    async getByMetadataType(type, limit = 1000) {
        const rows = this.db.prepare(`
      SELECT * FROM entries
      WHERE json_extract(metadata, '$.type') = ?
        AND irrelevant = 0
        AND tombstoned_at IS NULL
      ORDER BY created_at DESC
      LIMIT ?
    `).all(type, limit);
        return rows.map(rowToEntry);
    }
    /**
     * Public wrapper of findProjectLabelForParent.
     * Resolves the owning project label for ANY entry by walking parent_id up.
     * Returns null if the entry has no project ancestor.
     */
    getProjectLabel(entryId) {
        const row = this.db.prepare('SELECT id FROM entries WHERE id = ?')
            .get(entryId);
        if (!row)
            return null;
        return this.findProjectLabelForParent(entryId);
    }
    findProjectLabelForParent(startParentId) {
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
    /** Run `fn` inside a single exclusive DB transaction (serializes concurrent callers). */
    runExclusive(fn) {
        return this.db.transaction(fn)();
    }
    /** Synchronous write for use inside `runExclusive` transactions. */
    writeSync(content, options = {}) {
        const { entry, now, timestamp } = this.buildEntryRow(content, options);
        this.insertEntrySync(entry);
        this.insertStagingSync(entry, timestamp, options.confidence ?? 1.0);
        const result = rowToEntry(entry);
        this.emit('memory:written', { entry: result, agentId: this.agentId, timestamp: now });
        return result;
    }
    getChildByKindSync(parentId, kind) {
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
    getChildrenBySeqSync(parentId) {
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
    /** Entries whose metadata JSON has non-boolean values for known boolean keys (legacy 1/0/"true"/"false"). */
    findEntriesWithNonBooleanTask() {
        const rows = this.db
            .prepare('SELECT id, metadata FROM entries WHERE tombstoned_at IS NULL')
            .all();
        return rows.filter(row => {
            try {
                const parsed = JSON.parse(row.metadata);
                return (0, metadata_coerce_js_1.metadataNeedsCoercion)(parsed);
            }
            catch {
                return false;
            }
        });
    }
    /**
     * One-shot migration: coerce legacy boolean metadata primitives to real booleans.
     * @returns counts of found / updated / skipped rows
     */
    async reconcileMetadataTypes(options = {}) {
        const dryRun = options.dryRun ?? false;
        const rows = this.findEntriesWithNonBooleanTask();
        let updated = 0;
        let skipped = 0;
        for (const row of rows) {
            let coerced;
            try {
                coerced = (0, metadata_coerce_js_1.parseAndCoerceMetadata)(row.metadata);
            }
            catch {
                skipped++;
                continue;
            }
            if (dryRun) {
                updated++;
                continue;
            }
            await this.update(row.id, { metadata: coerced });
            updated++;
        }
        return { found: rows.length, updated, skipped };
    }
    buildEntryRow(content, options) {
        const now = new Date().toISOString();
        const id = options.id ?? (0, entry_id_js_1.formatEntryId)({ metadata: options.metadata, now: new Date(now) });
        const timestamp = Date.now();
        const { title, body } = splitTitleBody(content, options.title);
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
        return { entry, now, timestamp };
    }
    insertEntrySync(entry) {
        this.db.prepare(`INSERT INTO entries (id, parent_id, title, content, content_type, depth,
      confidence, created_at, accessed_at, decay_rate, visibility, tags, irrelevant,
      favorite, tombstoned_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(entry.id, entry.parent_id, entry.title, entry.content, entry.content_type, entry.depth, entry.confidence, entry.created_at, entry.accessed_at, entry.decay_rate, entry.visibility, entry.tags, entry.irrelevant, entry.favorite, entry.tombstoned_at, entry.metadata);
    }
    insertStagingSync(entry, timestamp, confidence) {
        this.db.prepare(`INSERT INTO staging (key, entity_type, operation, payload,
      lww_timestamp, lww_device, lww_confidence)
      VALUES (?, 'entry', 'upsert', ?, ?, ?, ?)`).run(entry.id, JSON.stringify(entry), timestamp, 'local', confidence);
    }
    async write(content, options = {}) {
        const { entry, now, timestamp } = this.buildEntryRow(content, options);
        this.insertEntrySync(entry);
        this.insertStagingSync(entry, timestamp, options.confidence ?? 1.0);
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
            const timestamp = Date.now();
            const updated = {
                ...existing,
                irrelevant: 1,
                accessed_at: now,
            };
            this.db.prepare('UPDATE entries SET irrelevant = 1, accessed_at = ? WHERE id = ?').run(now, id);
            this.db.prepare(`INSERT INTO staging (key, entity_type, operation, payload,
        lww_timestamp, lww_device, lww_confidence)
        VALUES (?, 'entry', 'upsert', ?, ?, ?, ?)`).run(id, JSON.stringify(updated), timestamp, 'local', updated.confidence);
        }
        this.emit('memory:deleted', {
            entry: rowToEntry(existing),
            agentId: this.agentId,
            timestamp: now,
        });
    }
    // ─── Search ────────────────────────────────────────────
    async search(options) {
        const topK = options.topK ?? 10;
        const fts = await this.searchFts(options.query, topK);
        // Labels/aliases live in metadata, not the FTS corpus. Merge a direct project hit.
        // Broader fix: index metadata.label + aliases in fts_entries (migration + triggers).
        const resolved = await this.resolveProjectLabel(options.query);
        if (resolved.status === 'found') {
            const row = this.db.prepare(`
        SELECT * FROM entries
        WHERE json_extract(metadata, '$.kind') = 'project'
          AND json_extract(metadata, '$.label') = ?
          AND irrelevant = 0
          AND tombstoned_at IS NULL
      `).get(resolved.label);
            const proj = row ? rowToEntry(row) : null;
            if (proj && !fts.some(e => e.id === proj.id)) {
                return [proj, ...fts].slice(0, topK);
            }
        }
        return fts;
    }
    async searchFts(query, limit = 10) {
        // Sanitize FTS5 query — strip operator words, escape special chars, AND-join tokens.
        // See sanitizeFtsQuery() in store-utils for rationale.
        const sanitized = sanitizeFtsQuery(query);
        if (!sanitized)
            return [];
        const rows = this.db.prepare(`
      SELECT e.* FROM entries e
      INNER JOIN fts_entries f ON e.rowid = f.rowid
      WHERE fts_entries MATCH ?
      AND e.irrelevant = 0
      AND e.tombstoned_at IS NULL
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
    async unlink(edgeId) {
        const row = this.db.prepare('SELECT * FROM edges WHERE id = ?').get(edgeId);
        if (!row)
            return;
        this.db.prepare('DELETE FROM edges WHERE id = ?').run(edgeId);
        const edgeKey = `${row.source_id}|${row.target_id}|${row.type}`;
        const ts = Date.now();
        const edgeRow = {
            id: row.id,
            source_id: row.source_id,
            target_id: row.target_id,
            type: row.type,
            weight: row.weight,
            metadata: row.metadata,
        };
        this.db.prepare(`INSERT INTO staging (key, entity_type, operation, payload,
      lww_timestamp, lww_device, lww_confidence)
      VALUES (?, 'edge', 'delete', ?, ?, ?, ?)`).run(edgeKey, JSON.stringify(edgeRow), ts, this.agentId, 1.0);
        const edge = {
            id: row.id,
            sourceId: row.source_id,
            targetId: row.target_id,
            type: row.type,
            weight: row.weight,
            metadata: row.metadata ? JSON.parse(row.metadata) : {},
        };
        this.emit('edge:deleted', {
            edge,
            agentId: this.agentId,
            timestamp: new Date().toISOString(),
        });
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
                        const existing = this.db.prepare('SELECT * FROM entries WHERE id = ?').get(payload.id);
                        if (existing) {
                            const local = (0, sync_methods_js_1.recordFromPayload)(payload.id, 'entry', existing.tombstoned_at ? 'delete' : 'upsert', JSON.stringify(existing), Date.parse(existing.accessed_at ?? existing.created_at), 'local', Number(existing.confidence ?? 1));
                            const { winner } = (0, tim_sync_1.resolveLWW)(local, record);
                            if (winner !== record)
                                continue;
                        }
                        deleteEntry.run(payload.id);
                    }
                    else {
                        const entry = JSON.parse(record.payload);
                        const existing = this.db.prepare('SELECT * FROM entries WHERE id = ?').get(entry.id);
                        if (existing) {
                            const local = (0, sync_methods_js_1.recordFromPayload)(entry.id, 'entry', existing.tombstoned_at ? 'delete' : 'upsert', JSON.stringify(existing), Date.parse(existing.accessed_at ?? existing.created_at), 'local', Number(existing.confidence ?? 1));
                            const { winner } = (0, tim_sync_1.resolveLWW)(local, record);
                            if (winner !== record)
                                continue;
                        }
                        upsertEntry.run(entry.id, entry.parent_id, entry.title ?? '', entry.content, entry.content_type, entry.depth, entry.confidence, entry.created_at, entry.accessed_at, entry.decay_rate, entry.visibility, entry.tags, entry.irrelevant, entry.favorite ?? 0, entry.tombstoned_at, entry.metadata);
                    }
                }
                else if (record.entityType === 'edge') {
                    const edge = JSON.parse(record.payload);
                    const compositeKey = `${edge.source_id}|${edge.target_id}|${edge.type}`;
                    const existing = this.db.prepare('SELECT * FROM edges WHERE source_id = ? AND target_id = ? AND type = ?').get(edge.source_id, edge.target_id, edge.type);
                    if (record.operation === 'delete') {
                        if (existing) {
                            const local = (0, sync_methods_js_1.recordFromPayload)(compositeKey, 'edge', 'upsert', JSON.stringify(existing), record.lwwTimestamp, 'local');
                            const { winner } = (0, tim_sync_1.resolveLWW)(local, record);
                            if (winner !== record)
                                continue;
                        }
                        deleteEdge.run(edge.id);
                    }
                    else {
                        if (existing) {
                            const local = (0, sync_methods_js_1.recordFromPayload)(compositeKey, 'edge', 'upsert', JSON.stringify(existing), record.lwwTimestamp, 'local');
                            const { winner } = (0, tim_sync_1.resolveLWW)(local, record);
                            if (winner !== record)
                                continue;
                        }
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
        // Top tags — defensively parse each row's tags column. A corrupt
        // (non-JSON) tags value would otherwise crash the whole stats() call,
        // which is exactly the BUG 2 production crash we saw today.
        // We skip the bad row and continue, logging via stderr so a curator
        // sweep can find it later.
        const allTags = this.db.prepare("SELECT id, tags FROM entries WHERE irrelevant = 0 AND tags != '[]'").all();
        const tagCounts = new Map();
        let skipped = 0;
        for (const row of allTags) {
            let parsed;
            try {
                parsed = JSON.parse(row.tags);
            }
            catch (err) {
                skipped++;
                console.error(`[TimStore.stats] skipping entry ${row.id}: invalid tags JSON (${err.message})`);
                continue;
            }
            if (!Array.isArray(parsed)) {
                skipped++;
                console.error(`[TimStore.stats] skipping entry ${row.id}: tags parsed to non-array (${typeof parsed})`);
                continue;
            }
            for (const tag of parsed) {
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
        AND json_extract(metadata, '$.kind') = 'exchange'
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
function normalizeProjectAliases(aliases) {
    if (!aliases?.length)
        return [];
    const out = [];
    for (const raw of aliases) {
        const a = raw.trim().toLowerCase();
        if (!a || out.includes(a))
            continue;
        out.push(a);
    }
    return out;
}
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
        metadata: (0, metadata_coerce_js_1.parseAndCoerceMetadata)(row.metadata),
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