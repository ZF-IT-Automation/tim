// TIM Store — v0.1.0-alpha
// SQLite-backed MemoryInterface implementation.

import Database from 'better-sqlite3';
import { ulid } from 'ulid';
import { formatEntryId } from './entry-id.js';
import type {
  Entry, Edge, EdgeType, ReadOptions, WriteOptions, DecayOptions,
  SearchOptions, MemoryInterface, HealthReport, MemoryStats, ContentStats,
  AgentIdentity, StagingRecord, ContentType,
  SyncEntity, SyncOperation, EventBus, EventType,
  ResolveProjectResult, ResolveSectionResult, SectionCandidate,
} from 'tim-core';
import { stripDeprecatedTags } from 'tim-core';
import { resolveLWW } from 'tim-sync';
import { runMigrations, createTriggers, getCurrentVersion } from './schema.js';
import { CurateManager } from './curate.js';
import { metadataNeedsCoercion, parseAndCoerceMetadata } from './metadata-coerce.js';
import { recordFromPayload } from './sync-methods.js';

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
export function sanitizeFtsQuery(query: string): string {
  if (!query) return '';
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
  if (tokens.length === 0) return '';
  // Implicit FTS5 AND — each token joined by space.
  return tokens.join(' ');
}

export interface TimStoreOptions {
  emitter?: Pick<EventBus, 'emit'>;
  agentId?: string;
}

export interface CreateProjectOptions {
  content?: string;
  metadata?: Record<string, unknown>;
  /** Short names for tim_load_project (e.g. ["o9k", "hmem"]). Stored lowercase. */
  aliases?: string[];
}

export interface LoadProjectOptions {
  depth?: number;
  budget?: number;
  sections?: string[] | null;
}

export interface LoadProjectResult {
  project: Entry;
  children: Entry[];
  truncated: boolean;
}

export interface TaskRecord {
  id: string;
  title: string;
  content: string;
  parent_id: string | null;
  project_label: string | null;
  status: string | null;
  priority: string | null;
  due: string | null;
}

export interface RuleRecord {
  id: string;
  title: string;
  content: string;
  parent_id: string | null;
  project_label: string | null;
  trigger: string | null;
  action: string | null;
}

export interface BugRecord {
  id: string;
  title: string;
  content: string;
  parent_id: string | null;
  project_label: string | null;
  severity: string | null;
  status: string | null;
}

export interface GetBugsOptions {
  status?: string;
}

export interface GetTasksOptions {
  status?: string;
}

export class TimStore implements MemoryInterface {
  private db: Database.Database;
  private emitter?: Pick<EventBus, 'emit'>;
  private agentId: string;

  constructor(dbPath: string, options: TimStoreOptions = {}) {
    this.db = new Database(dbPath);
    this.emitter = options.emitter;
    this.agentId = options.agentId ?? 'system';
    runMigrations(this.db);
    createTriggers(this.db);
  }

  private emit(type: EventType, payload: unknown): void {
    if (!this.emitter) return;
    try {
      void this.emitter.emit(type, payload).catch(err => {
        console.error(`[TimStore] event handler failed (${type}):`, err);
      });
    } catch (err) {
      console.error(`[TimStore] event emit failed (${type}):`, err);
    }
  }

  async read(id: string, options: ReadOptions = {}): Promise<Entry | null> {
    let entry = this.db.prepare('SELECT * FROM entries WHERE id = ?').get(id) as RowEntry | undefined;

    // Label-based fallback for hmem compatibility (e.g., "P0062", "L0042")
    if (!entry && /^[A-Z]\d{4}$/.test(id)) {
      entry = this.db.prepare(
        "SELECT * FROM entries WHERE json_extract(metadata, '$.label') = ? AND tombstoned_at IS NULL",
      ).get(id) as RowEntry | undefined;
    }

    if (!entry) return null;

    // Visibility check
    const mask = options.visibilityMask ?? 7; // default: owner+trusted+leased
    if ((entry.visibility & mask) === 0) return null;
    if (!options.showIrrelevant && entry.irrelevant) return null;

    const result = rowToEntry(entry);

    // Optionally include children (for tim_read with depth)
    if (options.includeChildren && options.depth !== 1) {
      const depth = options.depth ?? 2;
      const children = this.loadChildrenRecursive(result.id, depth, 1);
      (result as any).children = children;
    }

    return result;
  }

  private loadChildrenRecursive(
    parentId: string,
    maxDepth: number,
    currentDepth: number,
  ): Entry[] {
    if (currentDepth > maxDepth) return [];

    const rows = this.db.prepare(`
      SELECT * FROM entries
      WHERE parent_id = ?
        AND irrelevant = 0
        AND tombstoned_at IS NULL
      ORDER BY COALESCE(CAST(json_extract(metadata, '$.order') AS INTEGER), 999999), created_at ASC
    `).all(parentId) as RowEntry[];

    return rows.map(row => {
      const child = rowToEntry(row);
      if (currentDepth < maxDepth) {
        const grandkids = this.loadChildrenRecursive(child.id, maxDepth, currentDepth + 1);
        if (grandkids.length > 0) (child as any).children = grandkids;
      }
      return child;
    });
  }

  async createProject(
    label: string,
    options: CreateProjectOptions = {},
  ): Promise<Entry> {
    const aliases = normalizeProjectAliases(options.aliases);
    const metadata = {
      ...(options.metadata ?? {}),
      kind: 'project',
      label,
      ...(aliases.length > 0 ? { aliases } : {}),
    };

    const tx = this.db.transaction((labelArg: string) => {
      const dup = this.db.prepare(`
        SELECT id FROM entries
        WHERE json_extract(metadata, '$.kind') = 'project'
          AND json_extract(metadata, '$.label') = ?
          AND tombstoned_at IS NULL
      `).get(labelArg) as { id: string } | undefined;
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
  async resolveProjectLabel(query: string): Promise<ResolveProjectResult> {
    const q = query.trim();
    if (!q) return { status: 'not_found', query: q };

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
    `).get(q) as { metadata: string } | undefined;
    if (labelRow) {
      const meta = JSON.parse(labelRow.metadata) as Record<string, unknown>;
      const label = typeof meta.label === 'string' ? meta.label : q;
      return { status: 'found', label };
    }

    const needle = q.toLowerCase();
    const rows = this.db.prepare(`
      SELECT metadata FROM entries
      WHERE json_extract(metadata, '$.kind') = 'project'
        AND irrelevant = 0
        AND tombstoned_at IS NULL
    `).all() as { metadata: string }[];

    const matches: string[] = [];
    for (const row of rows) {
      const meta = JSON.parse(row.metadata) as Record<string, unknown>;
      const label = typeof meta.label === 'string' ? meta.label : '';
      if (!label) continue;
      const aliases = Array.isArray(meta.aliases) ? meta.aliases : [];
      if (aliases.some(a => String(a).toLowerCase() === needle)) {
        if (!matches.includes(label)) matches.push(label);
      }
    }

    if (matches.length === 0) return { status: 'not_found', query: q };
    if (matches.length === 1) return { status: 'found', label: matches[0]! };
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
  async resolveSectionByTitle(
    projectId: string,
    title: string,
  ): Promise<ResolveSectionResult> {
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
    `).get(projectLabel) as { id: string } | undefined;
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
    `).all(projectRow.id, title) as Array<{
      id: string; title: string; depth: number; created_at: string;
    }>;

    if (matches.length === 1) {
      const m = matches[0]!;
      return {
        status: 'found',
        id: m.id,
        project: projectLabel,
        title: m.title,
      };
    }

    if (matches.length > 1) {
      const candidates: SectionCandidate[] = matches.map(m => ({
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
    `).all(projectRow.id) as Array<{ title: string }>;
    return {
      status: 'not_found',
      project: projectLabel,
      title,
      candidates: siblings.map(s => s.title),
    };
  }

  /** Resolve label/alias/id to a project entry; throws on missing or ambiguous. */
  async requireProject(projectId: string): Promise<Entry> {
    const resolved = await this.resolveProjectLabel(projectId);
    if (resolved.status === 'ambiguous') {
      throw new Error(
        `Ambiguous project identifier: ${projectId} (candidates: ${resolved.labels.join(', ')})`,
      );
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

  async loadProject(
    label: string,
    options: LoadProjectOptions = {},
  ): Promise<LoadProjectResult | null> {
    const resolved = await this.resolveProjectLabel(label);
    if (resolved.status !== 'found') return null;

    const project = await this.read(resolved.label);
    if (!project) return null;

    const depth = options.depth ?? 3;
    const budget = options.budget ?? 200;
    const sections = options.sections ?? null;
    const children: Entry[] = [];
    let truncated = false;

    const matchesSection = (entry: Entry): boolean => {
      if (!sections?.length) return true;
      const entryLabel = entry.metadata.label as string | undefined;
      return sections.some(section => section === entry.id || section === entryLabel);
    };

    const loadChildren = (
      parentId: string,
      currentDepth: number,
      filterSections: boolean,
      reverse: boolean,
    ): void => {
      if (currentDepth > depth || truncated) return;

      // Reverse ordering when descending into sessions-root so the newest
      // sessions survive a tight DFS budget (Recent-Sessions sort bug).
      const orderBy = reverse
        ? `COALESCE(CAST(json_extract(metadata, '$.order') AS INTEGER), -1) DESC, created_at DESC`
        : `COALESCE(CAST(json_extract(metadata, '$.order') AS INTEGER), 999999) ASC, created_at ASC`;

      let childEntries = this.db.prepare(`
        SELECT * FROM entries
        WHERE parent_id = ?
          AND irrelevant = 0
          AND tombstoned_at IS NULL
        ORDER BY ${orderBy}
      `).all(parentId) as RowEntry[];

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
        // Load session subtrees newest-first so the newest sessions survive
        // budget truncation (Recent-Sessions sort bug).
        const childReverse = child.metadata.kind === 'sessions-root';
        loadChildren(child.id, currentDepth + 1, false, childReverse);
      }
    };

    loadChildren(project.id, 1, true, false);

    return { project, children, truncated };
  }

  /**
   * Count sessions recorded under a project (by label or id). One session
   * entry (kind=session) is created per session start, so this is the
   * "sessions so far" count used to gate periodic project-summary generation.
   * Kinds are literals to avoid a session-tree → store import cycle.
   */
  async countSessionSummaries(projectLabel: string): Promise<number> {
    const project = await this.read(projectLabel);
    if (!project) return 0;
    const sessionsRoot = this.db.prepare(`
      SELECT id FROM entries
      WHERE parent_id = ?
        AND json_extract(metadata, '$.kind') = 'sessions-root'
        AND tombstoned_at IS NULL
    `).get(project.id) as { id: string } | undefined;
    if (!sessionsRoot) return 0;
    const row = this.db.prepare(`
      SELECT COUNT(*) AS n FROM entries
      WHERE parent_id = ?
        AND json_extract(metadata, '$.kind') = 'session'
        AND irrelevant = 0
        AND tombstoned_at IS NULL
    `).get(sessionsRoot.id) as { n: number };
    return row.n;
  }

  async getChildren(
    parentId: string,
    filter?: { metadataKind?: string },
  ): Promise<Entry[]> {
    let sql = `
      SELECT * FROM entries
      WHERE parent_id = ?
        AND irrelevant = 0
        AND tombstoned_at IS NULL
    `;
    const params: unknown[] = [parentId];

    if (filter?.metadataKind) {
      sql += ` AND json_extract(metadata, '$.kind') = ?`;
      params.push(filter.metadataKind);
    }

    sql += filter?.metadataKind === 'exchange'
      ? ` ORDER BY CAST(json_extract(metadata, '$.seq') AS INTEGER) ASC`
      : ` ORDER BY COALESCE(CAST(json_extract(metadata, '$.order') AS INTEGER), 999999), created_at ASC`;

    const rows = this.db.prepare(sql).all(...params) as RowEntry[];
    return rows.map(rowToEntry);
  }

  /** Get all entries with a given metadata.kind value (no parent filter). */
  async getByMetadataKind(kind: string, limit: number = 200): Promise<Entry[]> {
    const rows = this.db.prepare(`
      SELECT * FROM entries
      WHERE json_extract(metadata, '$.kind') = ?
        AND irrelevant = 0
        AND tombstoned_at IS NULL
      ORDER BY created_at DESC
      LIMIT ?
    `).all(kind, limit) as RowEntry[];
    return rows.map(rowToEntry);
  }

  /** Return which of the given entry IDs exist in the DB (single IN-query). */
  async entryExistsBatch(ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db.prepare(
      `SELECT id FROM entries WHERE id IN (${placeholders})`,
    ).all(...ids) as { id: string }[];
    return new Set(rows.map(r => r.id));
  }

  /**
   * Recent batch-summary nodes (kind=batch-summary under session Summary trees).
   * Used by tim_remember for recency context.
   */
  async getRecentBatchSummaries(options: {
    limit?: number;
    maxAgeDays?: number;
    sessionId?: string;
    root?: string;
  } = {}): Promise<Entry[]> {
    const limit = options.limit ?? 5;
    const maxAgeDays = options.maxAgeDays ?? 30;
    const cutoff = new Date(Date.now() - maxAgeDays * 86400 * 1000).toISOString();

    let sql = `
      SELECT e.* FROM entries e
      WHERE json_extract(e.metadata, '$.kind') = 'batch-summary'
        AND e.irrelevant = 0
        AND e.tombstoned_at IS NULL
        AND e.created_at > ?
    `;
    const params: unknown[] = [cutoff];

    if (options.sessionId) {
      sql += ` AND json_extract(e.metadata, '$.sessionId') = ?`;
      params.push(options.sessionId);
    }

    if (options.root) {
      const resolved = await this.resolveProjectLabel(options.root);
      if (resolved.status !== 'found') return [];
      const project = await this.read(resolved.label);
      if (!project) return [];
      sql += ` AND e.id IN (
        WITH RECURSIVE tree(id) AS (
          SELECT id FROM entries WHERE id = ?
          UNION ALL
          SELECT c.id FROM entries c
          INNER JOIN tree t ON c.parent_id = t.id
          WHERE c.tombstoned_at IS NULL
        )
        SELECT id FROM tree
      )`;
      params.push(project.id);
    }

    sql += ` ORDER BY e.created_at DESC LIMIT ?`;
    params.push(limit);

    const rows = this.db.prepare(sql).all(...params) as RowEntry[];
    return rows.map(rowToEntry);
  }

  async getChildByKind(parentId: string, kind: string): Promise<Entry[]> {
    const rows = this.db.prepare(`
      SELECT * FROM entries
      WHERE parent_id = ?
        AND json_extract(metadata, '$.kind') = ?
        AND irrelevant = 0
        AND tombstoned_at IS NULL
      ORDER BY COALESCE(CAST(json_extract(metadata, '$.seq') AS INTEGER), 999999),
               COALESCE(CAST(json_extract(metadata, '$.order') AS INTEGER), 999999),
               created_at ASC
    `).all(parentId, kind) as RowEntry[];
    return rows.map(rowToEntry);
  }

  async getChildrenBySeq(parentId: string): Promise<Entry[]> {
    const rows = this.db.prepare(`
      SELECT * FROM entries
      WHERE parent_id = ?
        AND irrelevant = 0
        AND tombstoned_at IS NULL
      ORDER BY COALESCE(CAST(json_extract(metadata, '$.seq') AS INTEGER), 999999),
               created_at ASC
    `).all(parentId) as RowEntry[];
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
  getRootLevelEntries(filter?: { type?: string; tag?: string }): Entry[] {
    let sql = `
      SELECT * FROM entries
      WHERE parent_id IS NULL
        AND (json_extract(metadata, '$.kind') != 'project' OR json_extract(metadata, '$.kind') IS NULL)
        AND irrelevant = 0
        AND tombstoned_at IS NULL
    `;
    const params: unknown[] = [];

    if (filter?.type) {
      sql += ` AND json_extract(metadata, '$.type') = ?`;
      params.push(filter.type);
    } else if (filter?.tag) {
      sql += ` AND tags LIKE ?`;
      // Match the tag within JSON array: e.g., '%"#rule"%' (legacy).
      params.push(`%"${filter.tag}"%`);
    }

    sql += ` ORDER BY created_at ASC`;

    const rows = this.db.prepare(sql).all(...params) as RowEntry[];
    return rows.map(rowToEntry);
  }

  async getTasks(opts?: GetTasksOptions): Promise<TaskRecord[]> {
    let sql = `
      SELECT e.* FROM entries e
      WHERE json_extract(e.metadata, '$.task') IS NOT NULL
        AND json_extract(e.metadata, '$.task') != false
        AND e.irrelevant = 0
        AND e.tombstoned_at IS NULL
    `;
    const params: unknown[] = [];

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

    const rows = this.db.prepare(sql).all(...params) as RowEntry[];
    return rows.map(row => {
      const meta = JSON.parse(row.metadata) as Record<string, unknown>;
      let status: string | null = null;
      let priority: string | null = null;
      let due: string | null = null;

      const task = meta.task;
      if (typeof task === 'object' && task !== null && !Array.isArray(task)) {
        const tm = task as Record<string, unknown>;
        status = (tm.status as string | undefined) ?? null;
        priority = (tm.priority as string | undefined) ?? null;
        due = (tm.due_date as string | undefined) ?? null;
      } else if (task === true) {
        status = (meta.status as string | undefined) ?? null;
        priority = (meta.priority as string | undefined) ?? null;
        due = (meta.due as string | undefined) ?? null;
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

  async getBugs(opts?: GetBugsOptions): Promise<BugRecord[]> {
    let sql = `
      SELECT e.* FROM entries e
      WHERE (
        json_extract(e.metadata, '$.type') = 'bug'
        OR (
          json_extract(e.metadata, '$.bug') IS NOT NULL
          AND json_extract(e.metadata, '$.bug') != false
        )
        OR e.tags LIKE '%"#bug"%'
      )
        AND e.irrelevant = 0
        AND e.tombstoned_at IS NULL
    `;
    const params: unknown[] = [];

    if (opts?.status) {
      sql += ` AND COALESCE(
        json_extract(e.metadata, '$.bug.status'),
        json_extract(e.metadata, '$.status')
      ) = ?`;
      params.push(opts.status);
    }

    sql += `
      ORDER BY
        CASE COALESCE(
          json_extract(e.metadata, '$.bug.severity'),
          json_extract(e.metadata, '$.severity')
        )
          WHEN 'P0' THEN 0
          WHEN 'P1' THEN 1
          WHEN 'P2' THEN 2
          WHEN 'P3' THEN 3
          ELSE 4
        END,
        e.created_at ASC
    `;

    const rows = this.db.prepare(sql).all(...params) as RowEntry[];
    return rows.map(row => {
      const meta = JSON.parse(row.metadata) as Record<string, unknown>;
      let severity: string | null = null;
      let status: string | null = null;

      const bug = meta.bug;
      if (typeof bug === 'object' && bug !== null && !Array.isArray(bug)) {
        const bm = bug as Record<string, unknown>;
        severity = (bm.severity as string | undefined) ?? null;
        status = (bm.status as string | undefined) ?? null;
      } else if (meta.type === 'bug') {
        severity = (meta.severity as string | undefined) ?? null;
        status = (meta.status as string | undefined) ?? null;
      }

      return {
        id: row.id,
        title: row.title,
        content: row.content,
        parent_id: row.parent_id,
        project_label: this.findProjectLabelForParent(row.parent_id),
        severity,
        status,
      };
    });
  }

  async getRules(): Promise<RuleRecord[]> {
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
    `).all() as RowEntry[];

    return rows.map(row => {
      const meta = JSON.parse(row.metadata) as Record<string, unknown>;
      let trigger: string | null = null;
      let action: string | null = null;

      const rule = meta.rule;
      if (typeof rule === 'object' && rule !== null && !Array.isArray(rule)) {
        const rm = rule as Record<string, unknown>;
        trigger = typeof rm.trigger === 'string' ? rm.trigger : null;
        action = typeof rm.action === 'string' ? rm.action : null;
      } else if (meta.type === 'rule') {
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
  async listProjects(): Promise<Array<{ id: string; label: string; title: string }>> {
    const rows = this.db.prepare(`
      SELECT id, title, metadata FROM entries
      WHERE json_extract(metadata, '$.kind') = 'project'
        AND irrelevant = 0
        AND tombstoned_at IS NULL
      ORDER BY json_extract(metadata, '$.label') ASC
    `).all() as { id: string; title: string; metadata: string }[];
    return rows.map(r => {
      const meta = JSON.parse(r.metadata) as Record<string, unknown>;
      return { id: r.id, label: (meta.label as string) ?? r.id, title: r.title ?? '' };
    });
  }

  /**
   * Entries carrying a tag. Tags stored as JSON array string → matched with
   * `tags LIKE '%"<tag>"%'`. `tag` is normalized: leading '#' kept as stored
   * (caller passes exact stored form, e.g. '#bug'). `limit` is an INTERNAL
   * safety cap (default 1000), NOT the user-facing limit.
   */
  async getByTag(tag: string, limit: number = 1000): Promise<Entry[]> {
    const rows = this.db.prepare(`
      SELECT * FROM entries
      WHERE tags LIKE ?
        AND irrelevant = 0
        AND tombstoned_at IS NULL
      ORDER BY created_at DESC
      LIMIT ?
    `).all(`%"${tag}"%`, limit) as RowEntry[];
    return rows.map(rowToEntry);
  }

  /** Entries where json_extract(metadata,'$.type') = type. `limit` internal cap (default 1000). */
  async getByMetadataType(type: string, limit: number = 1000): Promise<Entry[]> {
    const rows = this.db.prepare(`
      SELECT * FROM entries
      WHERE json_extract(metadata, '$.type') = ?
        AND irrelevant = 0
        AND tombstoned_at IS NULL
      ORDER BY created_at DESC
      LIMIT ?
    `).all(type, limit) as RowEntry[];
    return rows.map(rowToEntry);
  }

  /**
   * Public wrapper of findProjectLabelForParent.
   * Resolves the owning project label for ANY entry by walking parent_id up.
   * Returns null if the entry has no project ancestor.
   */
  getProjectLabel(entryId: string): string | null {
    const row = this.db.prepare('SELECT id FROM entries WHERE id = ?')
      .get(entryId) as { id: string } | undefined;
    if (!row) return null;
    return this.findProjectLabelForParent(entryId);
  }

  private findProjectLabelForParent(startParentId: string | null): string | null {
    let currentId = startParentId;
    while (currentId) {
      const row = this.db.prepare(
        'SELECT parent_id, metadata FROM entries WHERE id = ?',
      ).get(currentId) as { parent_id: string | null; metadata: string } | undefined;
      if (!row) return null;

      const meta = JSON.parse(row.metadata) as Record<string, unknown>;
      if (meta.kind === 'project') {
        return (meta.label as string | undefined) ?? null;
      }
      currentId = row.parent_id;
    }
    return null;
  }

  close(): void {
    this.db.close();
  }

  curate(): CurateManager {
    return new CurateManager(this.db);
  }

  /** @internal Exposed for tests */
  getDb(): Database.Database {
    return this.db;
  }

  /** Run `fn` inside a single exclusive DB transaction (serializes concurrent callers). */
  runExclusive<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  /** Synchronous write for use inside `runExclusive` transactions. */
  writeSync(content: string, options: WriteOptions = {}): Entry {
    const { entry, now, timestamp } = this.buildEntryRow(content, options);
    this.insertEntrySync(entry);
    this.insertStagingSync(entry, timestamp, options.confidence ?? 1.0);
    const result = rowToEntry(entry);
    this.emit('memory:written', { entry: result, agentId: this.agentId, timestamp: now });
    return result;
  }

  getChildByKindSync(parentId: string, kind: string): Entry[] {
    const rows = this.db.prepare(`
      SELECT * FROM entries
      WHERE parent_id = ?
        AND json_extract(metadata, '$.kind') = ?
        AND irrelevant = 0
        AND tombstoned_at IS NULL
      ORDER BY COALESCE(CAST(json_extract(metadata, '$.seq') AS INTEGER), 999999),
               COALESCE(CAST(json_extract(metadata, '$.order') AS INTEGER), 999999),
               created_at ASC
    `).all(parentId, kind) as RowEntry[];
    return rows.map(rowToEntry);
  }

  getChildrenBySeqSync(parentId: string): Entry[] {
    const rows = this.db.prepare(`
      SELECT * FROM entries
      WHERE parent_id = ?
        AND irrelevant = 0
        AND tombstoned_at IS NULL
      ORDER BY COALESCE(CAST(json_extract(metadata, '$.seq') AS INTEGER), 999999),
               created_at ASC
    `).all(parentId) as RowEntry[];
    return rows.map(rowToEntry);
  }

  /** Entries whose metadata JSON has non-boolean values for known boolean keys (legacy 1/0/"true"/"false"). */
  findEntriesWithNonBooleanTask(): Array<{ id: string; metadata: string }> {
    const rows = this.db
      .prepare('SELECT id, metadata FROM entries WHERE tombstoned_at IS NULL')
      .all() as Array<{ id: string; metadata: string }>;

    return rows.filter(row => {
      try {
        const parsed = JSON.parse(row.metadata) as Record<string, unknown>;
        return metadataNeedsCoercion(parsed);
      } catch {
        return false;
      }
    });
  }

  /**
   * One-shot migration: coerce legacy boolean metadata primitives to real booleans.
   * @returns counts of found / updated / skipped rows
   */
  async reconcileMetadataTypes(options: { dryRun?: boolean } = {}): Promise<{
    found: number;
    updated: number;
    skipped: number;
  }> {
    const dryRun = options.dryRun ?? false;
    const rows = this.findEntriesWithNonBooleanTask();
    let updated = 0;
    let skipped = 0;

    for (const row of rows) {
      let coerced: Record<string, unknown>;
      try {
        coerced = parseAndCoerceMetadata(row.metadata);
      } catch {
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

  private buildEntryRow(
    content: string,
    options: WriteOptions,
  ): { entry: RowEntry; now: string; timestamp: number } {
    const now = new Date().toISOString();
    const id = options.id ?? formatEntryId({ metadata: options.metadata, now: new Date(now) });
    const timestamp = Date.now();
    const { title, body } = splitTitleBody(content, options.title);

    let depth = 1;
    const parentId = options.parentId ?? null;
    if (parentId) {
      const parent = this.db.prepare('SELECT depth FROM entries WHERE id = ?').get(parentId) as
        { depth: number } | undefined;
      if (parent) depth = Math.min(parent.depth + 1, 5);
    }

    const metadata: Record<string, unknown> = { ...(options.metadata ?? {}) };
    if (parentId && metadata.order === undefined) {
      const maxRow = this.db.prepare(`
        SELECT MAX(CAST(json_extract(metadata, '$.order') AS INTEGER)) AS max_order
        FROM entries WHERE parent_id = ? AND irrelevant = 0
      `).get(parentId) as { max_order: number | null };
      metadata.order = (maxRow.max_order ?? -1) + 1;
    }

    const entry: RowEntry = {
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

  private insertEntrySync(entry: RowEntry): void {
    this.db.prepare(`INSERT INTO entries (id, parent_id, title, content, content_type, depth,
      confidence, created_at, accessed_at, decay_rate, visibility, tags, irrelevant,
      favorite, tombstoned_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      entry.id, entry.parent_id, entry.title, entry.content, entry.content_type, entry.depth,
      entry.confidence, entry.created_at, entry.accessed_at, entry.decay_rate,
      entry.visibility, entry.tags, entry.irrelevant, entry.favorite, entry.tombstoned_at, entry.metadata
    );
  }

  private insertStagingSync(entry: RowEntry, timestamp: number, confidence: number): void {
    this.db.prepare(`INSERT INTO staging (key, entity_type, operation, payload,
      lww_timestamp, lww_device, lww_confidence)
      VALUES (?, 'entry', 'upsert', ?, ?, ?, ?)`).run(
      entry.id, JSON.stringify(entry), timestamp, 'local', confidence
    );
  }

  async write(content: string, options: WriteOptions = {}): Promise<Entry> {
    const { clean: cleanTags, removed: removedTags } = stripDeprecatedTags(options.tags ?? []);
    if (removedTags.length > 0) {
      console.warn(`[tim-store] Deprecated status/priority tags stripped: ${removedTags.join(', ')}`);
    }
    options = { ...options, tags: cleanTags };

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

  async update(id: string, patch: Partial<Entry>): Promise<Entry> {
    const existing = this.db.prepare('SELECT * FROM entries WHERE id = ?').get(id) as RowEntry | undefined;
    if (!existing) throw new Error(`Entry not found: ${id}`);

    if (patch.tags !== undefined) {
      const { clean: cleanTags, removed: removedTags } = stripDeprecatedTags(patch.tags);
      if (removedTags.length > 0) {
        console.warn(`[tim-store] Deprecated status/priority tags stripped: ${removedTags.join(', ')}`);
      }
      patch = { ...patch, tags: cleanTags };
    }

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
      } else if (!existing.title.trim()) {
        const split = splitTitleBody(patch.content);
        title = split.title;
        body = split.body;
      } else {
        body = patch.content;
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
      accessed_at=? WHERE id=?`).run(
      updated.title, updated.content, updated.content_type, updated.confidence,
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

    const result = rowToEntry(updated);
    this.emit('memory:updated', { entry: result, agentId: this.agentId, timestamp: now });
    return result;
  }

  async delete(id: string, hard: boolean = false): Promise<void> {
    const existing = this.db.prepare('SELECT * FROM entries WHERE id = ?').get(id) as RowEntry | undefined;
    if (!existing) return;

    this.deleteEntrySync(existing, hard);

    this.emit('memory:deleted', {
      entry: rowToEntry(existing),
      agentId: this.agentId,
      timestamp: new Date().toISOString(),
    });
  }

  /** Hard/soft delete inside a transaction; skips missing or tombstoned ids. */
  async deleteBatch(ids: string[], hard: boolean = true): Promise<number> {
    const uniqueIds = [...new Set(ids)];

    const deletedRows = this.db.transaction(() => {
      const rows: RowEntry[] = [];
      for (const id of uniqueIds) {
        const existing = this.db.prepare('SELECT * FROM entries WHERE id = ?').get(id) as RowEntry | undefined;
        if (!existing || existing.tombstoned_at) continue;
        this.deleteEntrySync(existing, hard);
        rows.push(existing);
      }
      return rows;
    })();

    const now = new Date().toISOString();
    for (const existing of deletedRows) {
      this.emit('memory:deleted', {
        entry: rowToEntry(existing),
        agentId: this.agentId,
        timestamp: now,
      });
    }

    return deletedRows.length;
  }

  private deleteEntrySync(existing: RowEntry, hard: boolean): void {
    const now = new Date().toISOString();
    if (hard) {
      this.db.prepare('UPDATE entries SET tombstoned_at = ? WHERE id = ?').run(now, existing.id);
      this.db.prepare(`INSERT INTO staging (key, entity_type, operation, payload,
        lww_timestamp, lww_device, lww_confidence)
        VALUES (?, 'entry', 'delete', ?, ?, ?, ?)`).run(
        existing.id, JSON.stringify({ id: existing.id, tombstoned_at: now }), Date.now(), 'local', 1.0
      );
    } else {
      const timestamp = Date.now();
      const updated = {
        ...existing,
        irrelevant: 1,
        accessed_at: now,
      };
      this.db.prepare('UPDATE entries SET irrelevant = 1, accessed_at = ? WHERE id = ?').run(now, existing.id);
      this.db.prepare(`INSERT INTO staging (key, entity_type, operation, payload,
        lww_timestamp, lww_device, lww_confidence)
        VALUES (?, 'entry', 'upsert', ?, ?, ?, ?)`).run(
        existing.id, JSON.stringify(updated), timestamp, 'local', updated.confidence
      );
    }
  }

  // ─── Search ────────────────────────────────────────────

  async search(options: SearchOptions): Promise<Entry[]> {
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
      `).get(resolved.label) as RowEntry | undefined;
      const proj = row ? rowToEntry(row) : null;
      if (proj && !fts.some(e => e.id === proj.id)) {
        return [proj, ...fts].slice(0, topK);
      }
    }
    return fts;
  }

  async searchFts(query: string, limit: number = 10): Promise<Entry[]> {
    // Sanitize FTS5 query — strip operator words, escape special chars, AND-join tokens.
    // See sanitizeFtsQuery() in store-utils for rationale.
    const sanitized = sanitizeFtsQuery(query);
    if (!sanitized) return [];
    const rows = this.db.prepare(`
      SELECT e.* FROM entries e
      INNER JOIN fts_entries f ON e.rowid = f.rowid
      WHERE fts_entries MATCH ?
      AND e.irrelevant = 0
      AND e.tombstoned_at IS NULL
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

    const edgeRow = {
      id,
      source_id: sourceId,
      target_id: targetId,
      type,
      weight,
      metadata: JSON.stringify(metadata),
    };

    this.db.prepare(`INSERT INTO edges (id, source_id, target_id, type, weight, metadata)
      VALUES (?, ?, ?, ?, ?, ?)`).run(
      edgeRow.id, edgeRow.source_id, edgeRow.target_id,
      edgeRow.type, edgeRow.weight, edgeRow.metadata,
    );

    const edgeKey = `${sourceId}|${targetId}|${type}`;
    const ts = Date.now();
    this.db.prepare(`INSERT INTO staging (key, entity_type, operation, payload,
      lww_timestamp, lww_device, lww_confidence)
      VALUES (?, 'edge', 'upsert', ?, ?, ?, ?)`).run(
      edgeKey, JSON.stringify(edgeRow), ts, this.agentId, 1.0,
    );

    const edge = { id, sourceId, targetId, type, weight, metadata };
    this.emit('edge:created', {
      edge,
      agentId: this.agentId,
      timestamp: new Date().toISOString(),
    });
    return edge;
  }

  async unlink(edgeId: string): Promise<void> {
    const row = this.db.prepare('SELECT * FROM edges WHERE id = ?').get(edgeId) as RowEdge | undefined;
    if (!row) return;

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
      VALUES (?, 'edge', 'delete', ?, ?, ?, ?)`).run(
      edgeKey, JSON.stringify(edgeRow), ts, this.agentId, 1.0,
    );

    const edge: Edge = {
      id: row.id,
      sourceId: row.source_id,
      targetId: row.target_id,
      type: row.type as EdgeType,
      weight: row.weight,
      metadata: row.metadata ? JSON.parse(row.metadata) : {},
    };
    this.emit('edge:deleted', {
      edge,
      agentId: this.agentId,
      timestamp: new Date().toISOString(),
    });
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
            const payload = JSON.parse(record.payload) as { id: string };
            const existing = this.db.prepare('SELECT * FROM entries WHERE id = ?').get(payload.id) as
              RowEntry | undefined;
            if (existing) {
              const local = recordFromPayload(
                payload.id,
                'entry',
                existing.tombstoned_at ? 'delete' : 'upsert',
                JSON.stringify(existing),
                Date.parse(existing.accessed_at ?? existing.created_at),
                'local',
                Number(existing.confidence ?? 1),
              );
              const { winner } = resolveLWW(local, record);
              if (winner !== record) continue;
            }
            deleteEntry.run(payload.id);
          } else {
            const entry = JSON.parse(record.payload) as RowEntry;
            const existing = this.db.prepare('SELECT * FROM entries WHERE id = ?').get(entry.id) as
              RowEntry | undefined;
            if (existing) {
              const local = recordFromPayload(
                entry.id,
                'entry',
                existing.tombstoned_at ? 'delete' : 'upsert',
                JSON.stringify(existing),
                Date.parse(existing.accessed_at ?? existing.created_at),
                'local',
                Number(existing.confidence ?? 1),
              );
              const { winner } = resolveLWW(local, record);
              if (winner !== record) continue;
            }
            upsertEntry.run(
              entry.id, entry.parent_id, entry.title ?? '', entry.content, entry.content_type,
              entry.depth, entry.confidence, entry.created_at, entry.accessed_at,
              entry.decay_rate, entry.visibility, entry.tags,
              entry.irrelevant, entry.favorite ?? 0, entry.tombstoned_at, entry.metadata
            );
          }
        } else if (record.entityType === 'edge') {
          const edge = JSON.parse(record.payload) as RowEdge;
          const compositeKey = `${edge.source_id}|${edge.target_id}|${edge.type}`;
          const existing = this.db.prepare(
            'SELECT * FROM edges WHERE source_id = ? AND target_id = ? AND type = ?',
          ).get(edge.source_id, edge.target_id, edge.type) as RowEdge | undefined;

          if (record.operation === 'delete') {
            if (existing) {
              const local = recordFromPayload(
                compositeKey,
                'edge',
                'upsert',
                JSON.stringify(existing),
                record.lwwTimestamp,
                'local',
              );
              const { winner } = resolveLWW(local, record);
              if (winner !== record) continue;
            }
            deleteEdge.run(edge.id);
          } else {
            if (existing) {
              const local = recordFromPayload(
                compositeKey,
                'edge',
                'upsert',
                JSON.stringify(existing),
                record.lwwTimestamp,
                'local',
              );
              const { winner } = resolveLWW(local, record);
              if (winner !== record) continue;
            }
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

    // Top tags — defensively parse each row's tags column. A corrupt
    // (non-JSON) tags value would otherwise crash the whole stats() call,
    // which is exactly the BUG 2 production crash we saw today.
    // We skip the bad row and continue, logging via stderr so a curator
    // sweep can find it later.
    const allTags = this.db.prepare("SELECT id, tags FROM entries WHERE irrelevant = 0 AND tags != '[]'").all() as { id: string; tags: string }[];
    const tagCounts = new Map<string, number>();
    let skipped = 0;
    for (const row of allTags) {
      let parsed: string[];
      try {
        parsed = JSON.parse(row.tags) as string[];
      } catch (err) {
        skipped++;
        console.error(`[TimStore.stats] skipping entry ${row.id}: invalid tags JSON (${(err as Error).message})`);
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
    const avgConf = (this.db.prepare('SELECT AVG(confidence) as avg FROM entries WHERE irrelevant = 0').get() as { avg: number }).avg;

    // Temporal
    const oldest = (this.db.prepare('SELECT created_at FROM entries WHERE irrelevant = 0 ORDER BY created_at LIMIT 1').get() as { created_at: string } | undefined)?.created_at ?? null;
    const newest = (this.db.prepare('SELECT created_at FROM entries WHERE irrelevant = 0 ORDER BY created_at DESC LIMIT 1').get() as { created_at: string } | undefined)?.created_at ?? null;

    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400_000).toISOString();
    const stale = (this.db.prepare('SELECT COUNT(*) as c FROM entries WHERE irrelevant = 0 AND accessed_at < ?').get(thirtyDaysAgo) as { c: number }).c;

    return { totalEntries, totalEdges, entriesByDepth, entriesByType, topTags, avgConfidence: avgConf, oldestEntry: oldest, newestEntry: newest, staleCount: stale };
  }

  async getContentStats(
    root?: string,
    kind?: string,
    buckets: number[] = [0, 100, 500, 1000, 5000, 10000, 50000],
  ): Promise<ContentStats> {
    const empty: ContentStats = {
      totalEntries: 0,
      totalContentBytes: 0,
      avgContentChars: 0,
      maxContentChars: 0,
      minContentChars: 0,
      buckets: [],
      byKind: [],
    };

    let scopeSql = '';
    const scopeParams: unknown[] = [];

    if (root) {
      const resolved = await this.resolveProjectLabel(root);
      if (resolved.status !== 'found') return empty;
      const project = await this.read(resolved.label);
      if (!project) return empty;
      scopeSql = ` AND e.id IN (
        WITH RECURSIVE tree(id) AS (
          SELECT id FROM entries WHERE id = ?
          UNION ALL
          SELECT c.id FROM entries c
          INNER JOIN tree t ON c.parent_id = t.id
          WHERE c.tombstoned_at IS NULL
        )
        SELECT id FROM tree
      )`;
      scopeParams.push(project.id);
    }

    const kindSql = kind ? ` AND json_extract(e.metadata, '$.kind') = ?` : '';
    const kindParams = kind ? [kind] : [];

    const baseWhere = `
      FROM entries e
      WHERE e.irrelevant = 0
        AND e.tombstoned_at IS NULL
        ${scopeSql}
        ${kindSql}
    `;

    const agg = this.db.prepare(`
      SELECT
        COUNT(*) AS totalEntries,
        COALESCE(SUM(LENGTH(e.content)), 0) AS totalContentBytes,
        COALESCE(AVG(LENGTH(e.content)), 0) AS avgContentChars,
        COALESCE(MAX(LENGTH(e.content)), 0) AS maxContentChars,
        COALESCE(MIN(LENGTH(e.content)), 0) AS minContentChars
      ${baseWhere}
    `).get(...scopeParams, ...kindParams) as {
      totalEntries: number;
      totalContentBytes: number;
      avgContentChars: number;
      maxContentChars: number;
      minContentChars: number;
    };

    if (agg.totalEntries === 0) return empty;

    const bucketRows = buckets.map(threshold => {
      const row = this.db.prepare(`
        SELECT COUNT(*) AS c
        ${baseWhere}
          AND LENGTH(e.content) <= ?
      `).get(...scopeParams, ...kindParams, threshold) as { c: number };
      return { threshold: String(threshold), count: row.c };
    });

    const byKindRows = this.db.prepare(`
      SELECT
        COALESCE(json_extract(e.metadata, '$.kind'), '') AS kind,
        COUNT(*) AS count,
        COALESCE(SUM(LENGTH(e.content)), 0) AS totalBytes
      ${baseWhere}
      GROUP BY kind
      ORDER BY count DESC, kind ASC
    `).all(...scopeParams, ...kindParams) as { kind: string; count: number; totalBytes: number }[];

    return {
      totalEntries: agg.totalEntries,
      totalContentBytes: agg.totalContentBytes,
      avgContentChars: agg.avgContentChars,
      maxContentChars: agg.maxContentChars,
      minContentChars: agg.minContentChars,
      buckets: bucketRows,
      byKind: byKindRows,
    };
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

  async runDecay(options: DecayOptions): Promise<number> {
    const exclude = new Set(options.exclude ?? []);
    const rows = this.db.prepare(`
      SELECT id FROM entries
      WHERE created_at < ?
        AND irrelevant = 0
        AND tombstoned_at IS NULL
        AND json_extract(metadata, '$.kind') = 'exchange'
    `).all(options.before) as { id: string }[];

    let count = 0;
    for (const row of rows) {
      if (exclude.has(row.id)) continue;
      await this.delete(row.id);
      count++;
    }
    return count;
  }
}

// ─── Row Types (internal) ───────────────────────────────

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

function normalizeProjectAliases(aliases?: string[]): string[] {
  if (!aliases?.length) return [];
  const out: string[] = [];
  for (const raw of aliases) {
    const a = raw.trim().toLowerCase();
    if (!a || out.includes(a)) continue;
    out.push(a);
  }
  return out;
}

function splitTitleBody(content: string, explicitTitle?: string): { title: string; body: string } {
  if (explicitTitle !== undefined) {
    return { title: explicitTitle.trim(), body: content };
  }
  const nl = content.indexOf('\n');
  if (nl === -1) return { title: content.trim(), body: '' };
  return { title: content.slice(0, nl).trim(), body: content.slice(nl + 1).trim() };
}

function rowToEntry(row: RowEntry): Entry {
  return {
    id: row.id,
    parentId: row.parent_id,
    title: row.title ?? '',
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
    favorite: row.favorite === 1,
    tombstonedAt: row.tombstoned_at,
    metadata: parseAndCoerceMetadata(row.metadata),
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
    entityType: row.entity_type as SyncEntity,
    operation: row.operation as SyncOperation,
    payload: row.payload,
    lwwTimestamp: row.lww_timestamp,
    lwwDevice: row.lww_device,
    lwwConfidence: row.lww_confidence,
    acked: row.acked === 1,
  };
}
