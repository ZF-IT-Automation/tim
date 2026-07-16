// TIM Store — v0.1.0-alpha
// SQLite-backed MemoryInterface implementation.

import Database from 'better-sqlite3';
import * as path from 'node:path';
import { ulid } from 'ulid';
import { formatEntryId } from './entry-id.js';
import type {
  Entry, Edge, EdgeType, ReadOptions, WriteOptions, DecayOptions,
  SearchOptions, MemoryInterface, HealthReport, MemoryStats, ContentStats,
  AgentIdentity, StagingRecord, ContentType,
  SyncEntity, SyncOperation, EventBus, EventType,
  ResolveProjectResult, ResolveSectionResult, SectionCandidate,
} from 'tim-core';
import { stripDeprecatedTags, resolveLWW, SCHEMA_KINDS, staleDays, isStale } from 'tim-core';
import { runMigrations, createTriggers, getCurrentVersion } from './schema.js';
import { CurateManager } from './curate.js';
import { ConsolidationManager } from './consolidate.js';
import { metadataNeedsCoercion, parseAndCoerceMetadata } from './metadata-coerce.js';
import { recordFromPayload, entryLocalLwwTimestamp, edgeLocalLwwTimestamp } from './sync-methods.js';
import { parentIsSecret } from './secret.js';

/**
 * Sanitize a user-supplied query string into a safe FTS5 MATCH expression.
 *
 * Strategy: each whitespace-separated token is emitted as an FTS5 quoted
 * string (`"token"`). Inside the quotes FTS5 treats operators (AND/OR/
 * NOT/NEAR) and punctuation (`. / @ + % # -`) as literal text to
 * tokenize — the whole blocklist arms race disappears. Column filters
 * `title:`/`content:`/`tags:` survive as `column:"value"`.
 *
 * Trade-off: a user phrase originally quoted across spaces (`"foo bar"`)
 * degrades to `"foo" "bar"` (AND instead of phrase) — acceptable.
 * Tokens with no alphanumeric content are dropped (a fully-punctuation
 * quoted string would match nothing or error).
 */
export function sanitizeFtsQuery(query: string): string {
  if (!query) return '';
  // FTS5 columns defined in schema.ts — the ONLY names a `token:value`
  // filter may reference. Anything else would crash ("no such column: X").
  const REAL_COLUMNS = new Set(['title', 'content', 'tags']);
  const out: string[] = [];

  const quoteTerm = (term: string): string | null => {
    // Embedded double quotes would terminate the FTS5 string — strip them.
    const cleaned = term.replace(/"/g, ' ').trim();
    // A quoted string with no tokenizable content matches nothing (or errors).
    if (!/[0-9A-Za-zÀ-￿]/.test(cleaned)) return null;
    return `"${cleaned}"`;
  };

  for (const raw of query.split(/\s+/)) {
    if (!raw) continue;
    const m = raw.match(/^([A-Za-z_][A-Za-z0-9_]*):(.+)$/);
    if (m && REAL_COLUMNS.has(m[1].toLowerCase())) {
      const q = quoteTerm(m[2]);
      if (q) out.push(`${m[1].toLowerCase()}:${q}`);
      continue;
    }
    if (m) {
      // Bogus column filter: keep both sides as plain search terms.
      const a = quoteTerm(m[1]);
      if (a) out.push(a);
      const b = quoteTerm(m[2]);
      if (b) out.push(b);
      continue;
    }
    const q = quoteTerm(raw);
    if (q) out.push(q);
  }

  // Implicit FTS5 AND — quoted terms joined by space.
  return out.join(' ');
}

/**
 * Jaccard overlap of lowercase word-token sets. 1.0 = same word set.
 * Single-char tokens are dropped — they are almost always punctuation
 * noise ("v2", "a") and inflate similarity between unrelated titles.
 */
export function titleSimilarity(a: string, b: string): number {
  const tokens = (s: string): Set<string> =>
    new Set(
      s.toLowerCase().split(/[^0-9a-zà-öø-ÿ]+/).filter(w => w.length > 1),
    );
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let intersection = 0;
  for (const w of ta) if (tb.has(w)) intersection++;
  return intersection / (ta.size + tb.size - intersection);
}

export interface TimStoreOptions {
  emitter?: Pick<EventBus, 'emit'>;
  agentId?: string;
  /** Stable device id for LWW tiebreaks. Default 'local'. */
  deviceId?: string;
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

interface EntryIdRewrite {
  sourceId: string;
  targetId: string;
  entryIds: string[];
  edgeIds: string[];
}

function rewriteExactJsonReferences(raw: string, sourceId: string, targetId: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }

  let changed = false;
  const visit = (value: unknown): unknown => {
    if (value === sourceId) {
      changed = true;
      return targetId;
    }
    if (Array.isArray(value)) return value.map(visit);
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, child]) => [key, visit(child)]),
      );
    }
    return value;
  };
  const rewritten = visit(parsed);
  return changed ? JSON.stringify(rewritten) : raw;
}

export class TimStore implements MemoryInterface {
  private db: Database.Database;
  private emitter?: Pick<EventBus, 'emit'>;
  private agentId: string;
  private deviceId: string;

  constructor(dbPath: string, options: TimStoreOptions = {}) {
    this.db = new Database(dbPath);
    this.emitter = options.emitter;
    this.agentId = options.agentId ?? 'system';
    this.deviceId = options.deviceId ?? 'local';
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

    const suppressPatterns = options.enforceSuppression
      ? this.loadActiveSuppressPatterns()
      : [];
    if (TimStore.matchesSuppressed(suppressPatterns, result)) return null;

    // Optionally include children (for tim_read with depth)
    if (options.includeChildren && options.depth !== 1) {
      const depth = options.depth ?? 2;
      const children = this.loadChildrenRecursive(result.id, depth, 1, suppressPatterns);
      (result as any).children = children;
    }

    return result;
  }

  private loadChildrenRecursive(
    parentId: string,
    maxDepth: number,
    currentDepth: number,
    suppressPatterns: string[] = [],
  ): Entry[] {
    if (currentDepth > maxDepth) return [];

    const rows = this.db.prepare(`
      SELECT * FROM entries
      WHERE parent_id = ?
        AND irrelevant = 0
        AND tombstoned_at IS NULL
      ORDER BY COALESCE(CAST(json_extract(metadata, '$.order') AS INTEGER), 999999), created_at ASC
    `).all(parentId) as RowEntry[];

    const result: Entry[] = [];
    for (const row of rows) {
      const child = rowToEntry(row);
      if (TimStore.matchesSuppressed(suppressPatterns, child)) continue;
      if (currentDepth < maxDepth) {
        const grandkids = this.loadChildrenRecursive(child.id, maxDepth, currentDepth + 1, suppressPatterns);
        if (grandkids.length > 0) (child as any).children = grandkids;
      }
      result.push(child);
    }
    return result;
  }

  /** Find auto-created project bound to an exact filesystem path. */
  async findProjectByPath(projectPath: string): Promise<Entry | null> {
    const resolved = path.resolve(projectPath);
    const row = this.db.prepare(`
      SELECT * FROM entries
      WHERE json_extract(metadata, '$.kind') = 'project'
        AND json_extract(metadata, '$.path') = ?
        AND irrelevant = 0
        AND tombstoned_at IS NULL
    `).get(resolved) as RowEntry | undefined;
    return row ? rowToEntry(row) : null;
  }

  /**
   * Allocate the next P-label under an immediate SQLite transaction lock.
   * Skips reserved labels P0000 and P9999.
   */
  allocateNextProjectLabel(): string {
    const tx = this.db.transaction(() => {
      const rows = this.db.prepare(`
        SELECT json_extract(metadata, '$.label') AS label FROM entries
        WHERE json_extract(metadata, '$.kind') = 'project'
          AND tombstoned_at IS NULL
      `).all() as { label: string }[];
      let maxNum = 0;
      for (const row of rows) {
        const match = /^P(\d{4})$/.exec(row.label);
        if (!match) continue;
        const num = parseInt(match[1]!, 10);
        if (row.label === 'P0000' || row.label === 'P9999') continue;
        if (num > maxNum) maxNum = num;
      }
      let candidateNum = maxNum + 1;
      while (candidateNum < 9999) {
        const candidate = `P${String(candidateNum).padStart(4, '0')}`;
        if (candidate === 'P0000' || candidate === 'P9999') {
          candidateNum++;
          continue;
        }
        const dup = this.db.prepare(`
          SELECT id FROM entries
          WHERE json_extract(metadata, '$.kind') = 'project'
            AND json_extract(metadata, '$.label') = ?
            AND tombstoned_at IS NULL
        `).get(candidate) as { id: string } | undefined;
        if (!dup) return candidate;
        candidateNum++;
      }
      throw new Error('No available project labels');
    });
    return tx.immediate();
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

    const timestamp = Date.now();
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
      this.insertStagingSync(entry, timestamp, 1.0);
      return entry;
    });

    const entry = tx.immediate(label);

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

    const suppressPatterns = this.loadActiveSuppressPatterns();

    const matchesSection = (entry: Entry): boolean => {
      if (!sections?.length) return true;
      const entryLabel = entry.metadata.label as string | undefined;
      const entryTitle = entry.title.toLowerCase();
      return sections.some(section =>
        section === entry.id ||
        section === entryLabel ||
        section.toLowerCase() === entryTitle,
      );
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
        if (TimStore.matchesSuppressed(suppressPatterns, child)) continue;
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

  /** Resolve a harness session id to its canonical session node id.
   *  All session-id consumers should route through this (or readSession). */
  resolveSessionId(harnessId: string): string {
    return this.resolveSessionAlias(harnessId);
  }

  /** Read a session entry after alias resolution. */
  async readSession(sessionId: string, options: ReadOptions = {}): Promise<Entry | null> {
    const canonical = this.resolveSessionAlias(sessionId);
    const entry = await this.read(canonical, options);
    if (!entry || entry.metadata.kind !== 'session') return null;
    return entry;
  }

  /** Record an O(1) alias mapping when the alias id is not already a session node. */
  upsertSessionAlias(aliasId: string, canonicalId: string): void {
    if (aliasId === canonicalId) return;

    const existing = this.readSync(aliasId);
    if (existing?.metadata.kind === 'session') {
      // Convert empty harness session node to session-alias for O(1) lookup.
      // Direct metadata replacement (not merge via updateSync) to drop stale session fields.
      const cleanMeta = JSON.stringify({ kind: 'session-alias', canonical: canonicalId });
      const now = new Date().toISOString();
      this.db.prepare(
        'UPDATE entries SET metadata = ?, updated_at = ?, accessed_at = ?, lww_device = ? WHERE id = ?'
      ).run(cleanMeta, now, now, this.deviceId, aliasId);
      return;
    }

    const metadata = { kind: 'session-alias', canonical: canonicalId };
    if (existing?.metadata.kind === 'session-alias') {
      this.updateSync(aliasId, { metadata });
      return;
    }
    if (existing) return;

    this.writeSync(aliasId, {
      id: aliasId,
      title: aliasId,
      metadata,
    });
  }

  /** Resolve a harness session id to its canonical session node id.
   *  Identity for non-aliased ids (including canonical session ids). */
  resolveSessionAlias(harnessId: string): string {
    const aliasRow = this.db.prepare(`
      SELECT json_extract(metadata, '$.canonical') AS canonical FROM entries
      WHERE id = ?
        AND json_extract(metadata, '$.kind') = 'session-alias'
        AND tombstoned_at IS NULL
    `).get(harnessId) as { canonical: string } | undefined;
    if (aliasRow?.canonical) return aliasRow.canonical;

    const aliasOwner = this.db.prepare(`
      SELECT id FROM entries
      WHERE json_extract(metadata, '$.kind') = 'session'
        AND tombstoned_at IS NULL
        AND id != ?
        AND EXISTS (
          SELECT 1 FROM json_each(json_extract(metadata, '$.resumed_by'))
          WHERE json_each.value = ?
        )
      LIMIT 1
    `).get(harnessId, harnessId) as { id: string } | undefined;
    if (aliasOwner) return aliasOwner.id;

    const direct = this.db.prepare(`
      SELECT id FROM entries
      WHERE id = ?
        AND json_extract(metadata, '$.kind') = 'session'
        AND tombstoned_at IS NULL
    `).get(harnessId) as { id: string } | undefined;
    if (direct) return harnessId;

    return harnessId;
  }

  /** Sessions under a project's sessions-root, newest activity first.
   *  Activity = latest insert (rowid) anywhere in the session subtree. */
  listProjectSessionsByActivity(
    projectId: string,
    limit = 10,
  ): Array<{ id: string; lastActivity: string }> {
    const sessionsRoot = this.db.prepare(`
      SELECT id FROM entries
      WHERE parent_id = ?
        AND json_extract(metadata, '$.kind') = 'sessions-root'
        AND tombstoned_at IS NULL
    `).get(projectId) as { id: string } | undefined;
    if (!sessionsRoot) return [];

    const rows = this.db.prepare(`
      WITH RECURSIVE sub AS (
        SELECT id, id AS root, created_at, rowid AS rid FROM entries
        WHERE parent_id = ?
          AND json_extract(metadata, '$.kind') = 'session'
          AND tombstoned_at IS NULL
          AND irrelevant = 0
        UNION ALL
        SELECT e.id, sub.root, e.created_at, e.rowid FROM entries e
        INNER JOIN sub ON e.parent_id = sub.id
        WHERE e.tombstoned_at IS NULL
      )
      SELECT root, MAX(created_at) AS last, MAX(rid) AS lastRid FROM sub
      GROUP BY root
      ORDER BY lastRid DESC
      LIMIT ?
    `).all(sessionsRoot.id, limit) as Array<{ root: string; last: string; lastRid: number }>;

    return rows.map(r => ({ id: r.root, lastActivity: r.last }));
  }

  /** Count live descendants of a project node + latest created_at. */
  getProjectEntryStats(projectId: string): { count: number; lastActivity: string } {
    const row = this.db.prepare(`
      WITH RECURSIVE descendants AS (
        SELECT id, created_at FROM entries
        WHERE parent_id = ?
          AND tombstoned_at IS NULL
          AND irrelevant = 0
        UNION ALL
        SELECT e.id, e.created_at FROM entries e
        INNER JOIN descendants d ON e.parent_id = d.id
        WHERE e.tombstoned_at IS NULL AND e.irrelevant = 0
      )
      SELECT COUNT(*) AS n, MAX(created_at) AS last FROM descendants
    `).get(projectId) as { n: number; last: string | null };
    return {
      count: row.n ?? 0,
      lastActivity: row.last ?? new Date(0).toISOString(),
    };
  }

  async getChildren(
    parentId: string,
    filter?: { metadataKind?: string; enforceSuppression?: boolean },
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
    const entries = rows.map(rowToEntry);
    return filter?.enforceSuppression ? this.filterSuppressed(entries) : entries;
  }

  /** Drop entries matching active suppress patterns — for retrieval paths
   *  that assemble result sets outside read()/search() (e.g. tim_show). */
  filterSuppressed(entries: Entry[]): Entry[] {
    const patterns = this.loadActiveSuppressPatterns();
    if (patterns.length === 0) return entries;
    return entries.filter(e => !TimStore.matchesSuppressed(patterns, e));
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

  /**
   * Projects ordered by most recent session activity — used by the
   * tim_session_start Inbox fallback to offer a binding choice when no
   * `.tim-project` marker resolved. Groups kind=session entries by their
   * `project_ref` label and joins the project entry for its title; labels
   * whose project entry is deleted (soft or hard) drop out with the join.
   * The Inbox itself ('P0000' — literal to avoid a session-tree → store
   * import cycle) is excluded: falling back to it is what triggered the call.
   */
  async recentActiveProjects(
    limit: number = 5,
  ): Promise<{ label: string; title: string | null; lastActive: string }[]> {
    const rows = this.db.prepare(`
      SELECT sub.label AS label, sub.last_active AS lastActive, p.title AS title
      FROM (
        SELECT json_extract(metadata, '$.project_ref') AS label,
               MAX(created_at) AS last_active
        FROM entries
        WHERE json_extract(metadata, '$.kind') = 'session'
          AND json_extract(metadata, '$.project_ref') IS NOT NULL
          AND irrelevant = 0
          AND tombstoned_at IS NULL
        GROUP BY label
      ) sub
      INNER JOIN entries p
        ON json_extract(p.metadata, '$.kind') = 'project'
        AND json_extract(p.metadata, '$.label') = sub.label
        AND p.tombstoned_at IS NULL
        AND p.irrelevant = 0
      WHERE sub.label != 'P0000'
      ORDER BY sub.last_active DESC
      LIMIT ?
    `).all(limit) as { label: string; title: string | null; lastActive: string }[];
    return rows;
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
        COALESCE(CAST(json_extract(e.metadata, '$.task.order') AS INTEGER), 999999),
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

  private extractTaskOrder(entry: Entry): number | undefined {
    const task = entry.metadata.task;
    if (typeof task === 'object' && task !== null && !Array.isArray(task)) {
      const order = (task as Record<string, unknown>).order;
      if (typeof order === 'number' && Number.isFinite(order)) return order;
    }
    return undefined;
  }

  private extractTaskStatus(meta: Record<string, unknown>): string | null {
    const task = meta.task;
    if (typeof task === 'object' && task !== null && !Array.isArray(task)) {
      const st = (task as Record<string, unknown>).status;
      if (typeof st === 'string') return st;
    } else if (task === true) {
      const st = meta.status;
      if (typeof st === 'string') return st;
    }
    return null;
  }

  private async getOrderedProjectTasks(
    projectLabel: string,
    excludeId?: string,
  ): Promise<Array<{ id: string; order: number }>> {
    const allTasks = await this.getTasks();
    const projectTasks = allTasks.filter(
      t => t.project_label === projectLabel && t.status !== 'done' && t.id !== excludeId,
    );
    const result: Array<{ id: string; order: number }> = [];
    for (const t of projectTasks) {
      const e = this.readSync(t.id);
      if (!e) continue;
      const order = this.extractTaskOrder(e);
      if (order !== undefined) {
        result.push({ id: t.id, order });
      }
    }
    result.sort((a, b) => a.order - b.order);
    return result;
  }

  private async renumberProjectTasks(projectLabel: string): Promise<void> {
    const allTasks = await this.getTasks();
    const projectTasks = allTasks.filter(
      t => t.project_label === projectLabel && t.status !== 'done',
    );
    const items: Array<{ id: string; order: number; createdAt: string }> = [];
    for (const t of projectTasks) {
      const e = this.readSync(t.id);
      if (!e) continue;
      items.push({
        id: t.id,
        order: this.extractTaskOrder(e) ?? 999999,
        createdAt: e.createdAt,
      });
    }
    items.sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt));
    for (let i = 0; i < items.length; i++) {
      await this.update(items[i].id, { metadata: { task: { order: (i + 1) * 100 } } });
    }
  }

  private taskOrderFromId(ordered: Array<{ id: string; order: number }>, id: string): number {
    const e = this.readSync(id);
    if (!e) throw new Error(`Task not found: ${id}`);
    const order = this.extractTaskOrder(e);
    if (order !== undefined) return order;
    const found = ordered.find(t => t.id === id);
    if (found) return found.order;
    throw new Error(`Task has no order: ${id}`);
  }

  private async computeTaskOrder(
    taskId: string,
    projectLabel: string,
    beforeId?: string,
    afterId?: string,
  ): Promise<number> {
    let ordered = await this.getOrderedProjectTasks(projectLabel, taskId);

    if (!beforeId && !afterId) {
      if (ordered.length === 0) return 100;
      return Math.max(...ordered.map(t => t.order)) + 100;
    }

    const recomputeAfterRenumber = async (): Promise<Array<{ id: string; order: number }>> => {
      await this.renumberProjectTasks(projectLabel);
      return this.getOrderedProjectTasks(projectLabel, taskId);
    };

    if (beforeId && afterId) {
      let beforeOrder = this.taskOrderFromId(ordered, beforeId);
      let afterOrder = this.taskOrderFromId(ordered, afterId);
      if (beforeOrder >= afterOrder) {
        throw new Error('beforeId must come before afterId in task order');
      }
      let newOrder = Math.floor((afterOrder + beforeOrder) / 2);
      if (afterOrder - beforeOrder === 1 || newOrder === beforeOrder || newOrder === afterOrder) {
        ordered = await recomputeAfterRenumber();
        beforeOrder = this.taskOrderFromId(ordered, beforeId);
        afterOrder = this.taskOrderFromId(ordered, afterId);
        newOrder = Math.floor((afterOrder + beforeOrder) / 2);
      }
      return newOrder;
    }

    if (beforeId) {
      let beforeOrder = this.taskOrderFromId(ordered, beforeId);
      let idx = ordered.findIndex(t => t.id === beforeId);
      if (idx < 0) {
        ordered = await recomputeAfterRenumber();
        beforeOrder = this.taskOrderFromId(ordered, beforeId);
        idx = ordered.findIndex(t => t.id === beforeId);
      }
      if (idx <= 0) {
        let newOrder = Math.max(100, Math.floor(beforeOrder / 2));
        if (newOrder >= beforeOrder) {
          ordered = await recomputeAfterRenumber();
          beforeOrder = this.taskOrderFromId(ordered, beforeId);
          newOrder = Math.max(100, Math.floor(beforeOrder / 2));
        }
        return newOrder;
      }
      const prevOrder = ordered[idx - 1].order;
      let newOrder = Math.floor((prevOrder + beforeOrder) / 2);
      if (
        beforeOrder - prevOrder === 1 ||
        newOrder === prevOrder ||
        newOrder === beforeOrder
      ) {
        ordered = await recomputeAfterRenumber();
        beforeOrder = this.taskOrderFromId(ordered, beforeId);
        idx = ordered.findIndex(t => t.id === beforeId);
        if (idx <= 0) {
          return Math.max(100, Math.floor(beforeOrder / 2));
        }
        newOrder = Math.floor((ordered[idx - 1].order + beforeOrder) / 2);
      }
      return newOrder;
    }

    // afterId only
    let afterOrder = this.taskOrderFromId(ordered, afterId!);
    let idx = ordered.findIndex(t => t.id === afterId);
    if (idx < 0) {
      ordered = await recomputeAfterRenumber();
      afterOrder = this.taskOrderFromId(ordered, afterId!);
      idx = ordered.findIndex(t => t.id === afterId);
    }
    if (idx < 0 || idx >= ordered.length - 1) {
      return afterOrder + 100;
    }
    const nextOrder = ordered[idx + 1].order;
    let newOrder = Math.floor((afterOrder + nextOrder) / 2);
    if (
      nextOrder - afterOrder === 1 ||
      newOrder === afterOrder ||
      newOrder === nextOrder
    ) {
      ordered = await recomputeAfterRenumber();
      afterOrder = this.taskOrderFromId(ordered, afterId!);
      idx = ordered.findIndex(t => t.id === afterId);
      if (idx < 0 || idx >= ordered.length - 1) {
        return afterOrder + 100;
      }
      newOrder = Math.floor((afterOrder + ordered[idx + 1].order) / 2);
    }
    return newOrder;
  }

  async setTaskOrder(taskId: string, beforeId?: string, afterId?: string): Promise<Entry> {
    const entry = this.readSync(taskId);
    if (!entry) throw new Error(`Entry not found: ${taskId}`);

    const projectLabel = this.getProjectLabel(taskId);
    if (!projectLabel) throw new Error(`Task has no project: ${taskId}`);

    const newOrder = await this.computeTaskOrder(taskId, projectLabel, beforeId, afterId);
    return this.update(taskId, { metadata: { task: { order: newOrder } } });
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
    return new CurateManager(this.db, this.deviceId);
  }

  consolidate(): ConsolidationManager {
    return new ConsolidationManager(this.db, this);
  }

  /** @internal Exposed for tests */
  getDb(): Database.Database {
    return this.db;
  }

  /** Run `fn` inside a single exclusive DB transaction (serializes concurrent callers). */
  runExclusive<T>(fn: () => T): T {
    return this.db.transaction(fn).exclusive();
  }

  /** Synchronous write for use inside `runExclusive` transactions. */
  writeSync(content: string, options: WriteOptions = {}): Entry {
    if (options.parentId && parentIsSecret(this.db, options.parentId)) {
      options = {
        ...options,
        metadata: { ...(options.metadata ?? {}), secret: true },
      };
    }
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

  readSync(id: string): Entry | null {
    const row = this.db.prepare('SELECT * FROM entries WHERE id = ?').get(id) as RowEntry | undefined;
    return row && !row.tombstoned_at ? rowToEntry(row) : null;
  }

  /** Synchronous raw-id read for repair paths; includes irrelevant and tombstoned rows. */
  readIncludingTombstoneSync(id: string): Entry | null {
    const row = this.db.prepare('SELECT * FROM entries WHERE id = ?').get(id) as RowEntry | undefined;
    return row ? rowToEntry(row) : null;
  }

  /** Find every physical row carrying a logical metadata label, including suppressed rows. */
  findByMetadataLabelIncludingTombstoneSync(label: string): Entry[] {
    const rows = this.db.prepare(
      `SELECT * FROM entries
       WHERE json_extract(metadata, '$.label') = ?
       ORDER BY created_at ASC, rowid ASC`,
    ).all(label) as RowEntry[];
    return rows.map(rowToEntry);
  }

  /**
   * Canonicalize a physical entry id without changing its payload. Must be called
   * inside runExclusive; rewrites all local references before removing oldId.
   */
  canonicalizeEntryIdSync(oldId: string, newId: string): {
    entry: Entry;
    rewrite: EntryIdRewrite | null;
  } {
    if (oldId === newId) {
      const existing = this.readIncludingTombstoneSync(oldId);
      if (!existing) throw new Error(`Entry not found: ${oldId}`);
      return { entry: existing, rewrite: null };
    }
    const existing = this.db.prepare('SELECT * FROM entries WHERE id = ?').get(oldId) as RowEntry | undefined;
    if (!existing) throw new Error(`Entry not found: ${oldId}`);
    if (this.db.prepare('SELECT 1 FROM entries WHERE id = ?').get(newId)) {
      throw new Error(`Entry already exists: ${newId}`);
    }

    this.db.prepare(`
      INSERT INTO entries (id, parent_id, title, content, content_type, depth, confidence,
        created_at, accessed_at, updated_at, decay_rate, visibility, tags, irrelevant, favorite,
        tombstoned_at, metadata, lww_device)
      SELECT ?, parent_id, title, content, content_type, depth, confidence,
        created_at, accessed_at, updated_at, decay_rate, visibility, tags, irrelevant, favorite,
        tombstoned_at, metadata, lww_device
      FROM entries WHERE id = ?
    `).run(newId, oldId);

    const rewrite = this.repointEntryReferencesSync(oldId, newId);
    this.db.prepare('UPDATE entry_usage SET entry_id = ? WHERE entry_id = ?').run(newId, oldId);
    this.db.prepare('UPDATE entry_vectors SET entry_id = ? WHERE entry_id = ?').run(newId, oldId);

    this.db.prepare('DELETE FROM entries WHERE id = ?').run(oldId);
    return { entry: this.readIncludingTombstoneSync(newId)!, rewrite };
  }

  /** Repoint every structural reference to targetId, then remove sourceId without staging. */
  mergeEntryReferencesAndDeleteSync(sourceId: string, targetId: string): EntryIdRewrite | null {
    if (sourceId === targetId) return null;
    if (!this.db.prepare('SELECT 1 FROM entries WHERE id = ?').get(sourceId)) {
      throw new Error(`Entry not found: ${sourceId}`);
    }
    if (!this.db.prepare('SELECT 1 FROM entries WHERE id = ?').get(targetId)) {
      throw new Error(`Entry not found: ${targetId}`);
    }

    const rewrite = this.repointEntryReferencesSync(sourceId, targetId);
    this.db.prepare('UPDATE entry_usage SET entry_id = ? WHERE entry_id = ?').run(targetId, sourceId);
    this.db.prepare('DELETE FROM entry_vectors WHERE entry_id = ?').run(sourceId);
    this.db.prepare('DELETE FROM entries WHERE id = ?').run(sourceId);
    return rewrite;
  }

  /** Emit the syncable state transition for physical-id rewrites after the target is final. */
  stageEntryIdRewritesSync(targetId: string, rewrites: EntryIdRewrite[]): void {
    if (rewrites.length === 0) return;
    const target = this.db.prepare('SELECT * FROM entries WHERE id = ?').get(targetId) as RowEntry | undefined;
    if (!target) throw new Error(`Entry not found: ${targetId}`);

    const maxTimestamp = this.db.prepare(
      'SELECT COALESCE(MAX(lww_timestamp), 0) AS value FROM staging',
    ).get() as { value: number };
    let timestamp = Math.max(Date.now(), maxTimestamp.value + 1);

    this.db.prepare(
      `DELETE FROM staging
       WHERE acked = 0 AND key = ? AND entity_type = 'entry' AND operation = 'upsert'`,
    ).run(targetId);
    this.insertStagingSync(target, timestamp++, target.confidence);

    const entryIds = new Set<string>();
    const edgeIds = new Set<string>();
    for (const rewrite of rewrites) {
      const deletedAt = new Date(timestamp).toISOString();
      this.db.prepare(`INSERT INTO staging (key, entity_type, operation, payload,
        lww_timestamp, lww_device, lww_confidence)
        VALUES (?, 'entry', 'delete', ?, ?, ?, 1.0)`).run(
        rewrite.sourceId,
        JSON.stringify({
          id: rewrite.sourceId,
          tombstoned_at: deletedAt,
          lww_device: this.deviceId,
        }),
        timestamp++,
        this.deviceId,
      );
      rewrite.entryIds.forEach(id => entryIds.add(id));
      rewrite.edgeIds.forEach(id => edgeIds.add(id));
    }

    for (const id of entryIds) {
      const entry = this.db.prepare('SELECT * FROM entries WHERE id = ?').get(id) as RowEntry | undefined;
      if (entry) this.insertStagingSync(entry, timestamp++, entry.confidence);
    }
    for (const id of edgeIds) {
      const edge = this.db.prepare('SELECT * FROM edges WHERE id = ?').get(id) as RowEdge | undefined;
      if (!edge) continue;
      const key = `${edge.source_id}|${edge.target_id}|${edge.type}`;
      this.db.prepare(`INSERT INTO staging (key, entity_type, operation, payload,
        lww_timestamp, lww_device, lww_confidence)
        VALUES (?, 'edge', 'upsert', ?, ?, ?, 1.0)`).run(
        key, JSON.stringify(edge), timestamp++, this.deviceId,
      );
    }
  }

  private repointEntryReferencesSync(sourceId: string, targetId: string): EntryIdRewrite {
    const entryIds = new Set(
      (this.db.prepare('SELECT id FROM entries WHERE parent_id = ?').all(sourceId) as Array<{ id: string }>)
        .map(row => row.id),
    );
    const edgeIds = new Set(
      (this.db.prepare(
        'SELECT id FROM edges WHERE source_id = ? OR target_id = ?',
      ).all(sourceId, sourceId) as Array<{ id: string }>).map(row => row.id),
    );

    this.db.prepare('UPDATE edges SET source_id = ? WHERE source_id = ?').run(targetId, sourceId);
    this.db.prepare('UPDATE edges SET target_id = ? WHERE target_id = ?').run(targetId, sourceId);
    this.db.prepare('UPDATE entries SET parent_id = ? WHERE parent_id = ?').run(targetId, sourceId);

    const rewriteJsonColumn = (
      table: 'entries' | 'edges',
      column: 'metadata',
      affected: Set<string>,
    ): void => {
      const rows = this.db.prepare(
        `SELECT id, ${column} AS value FROM ${table} WHERE ${column} LIKE '%' || ? || '%'`,
      ).all(sourceId) as Array<{ id: string; value: string }>;
      const update = this.db.prepare(`UPDATE ${table} SET ${column} = ? WHERE id = ?`);
      for (const row of rows) {
        const rewritten = rewriteExactJsonReferences(row.value, sourceId, targetId);
        if (rewritten === row.value) continue;
        update.run(rewritten, row.id);
        affected.add(row.id);
      }
    };
    rewriteJsonColumn('entries', 'metadata', entryIds);
    rewriteJsonColumn('edges', 'metadata', edgeIds);
    entryIds.delete(sourceId);
    entryIds.delete(targetId);

    this.db.prepare('UPDATE suppressed SET pattern = ? WHERE pattern = ?').run(targetId, sourceId);
    this.db.prepare('UPDATE suppressed SET suppressed_by = ? WHERE suppressed_by = ?')
      .run(targetId, sourceId);

    return {
      sourceId,
      targetId,
      entryIds: [...entryIds],
      edgeIds: [...edgeIds],
    };
  }

  /**
   * Persist a reserved system-entry repair without normalizing legacy user data.
   * Callers must supply the complete preserved title, tags, and metadata payload.
   */
  repairSystemEntrySync(
    id: string,
    patch: Pick<Entry, 'title' | 'content' | 'tags' | 'metadata' | 'irrelevant' | 'tombstonedAt'>,
  ): Entry {
    const existing = this.db.prepare('SELECT * FROM entries WHERE id = ?').get(id) as RowEntry | undefined;
    if (!existing) throw new Error(`Entry not found: ${id}`);

    const now = new Date().toISOString();
    const timestamp = Date.now();
    const updated: RowEntry = {
      ...existing,
      title: patch.title,
      content: patch.content,
      tags: JSON.stringify(patch.tags),
      irrelevant: patch.irrelevant ? 1 : 0,
      tombstoned_at: patch.tombstonedAt,
      metadata: JSON.stringify(patch.metadata),
      accessed_at: now,
      updated_at: now,
      lww_device: this.deviceId,
    };

    this.db.transaction(() => {
      this.db.prepare(`UPDATE entries
        SET title = ?, content = ?, tags = ?, irrelevant = ?, tombstoned_at = ?, metadata = ?,
            accessed_at = ?, updated_at = ?, lww_device = ?
        WHERE id = ?`).run(
        updated.title,
        updated.content,
        updated.tags,
        updated.irrelevant,
        updated.tombstoned_at,
        updated.metadata,
        updated.accessed_at,
        updated.updated_at,
        updated.lww_device,
        id,
      );
      this.insertStagingSync(updated, timestamp, updated.confidence);
    })();

    return rowToEntry(updated);
  }

  /** Synchronous update for use inside `runExclusive` transactions. */
  updateSync(id: string, patch: Partial<Entry>): Entry {
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
      irrelevant: patch.irrelevant === undefined ? existing.irrelevant : (patch.irrelevant ? 1 : 0),
      tombstoned_at: patch.tombstonedAt === undefined ? existing.tombstoned_at : patch.tombstonedAt,
      metadata: (() => {
        if (!patch.metadata) return existing.metadata;
        const existingMeta = JSON.parse(existing.metadata || '{}') as Record<string, unknown>;
        const patchMeta = JSON.parse(JSON.stringify(patch.metadata)) as Record<string, unknown>;
        const SYSTEM_FIELDS = ['verified_at', 'provenance'] as const;
        for (const f of SYSTEM_FIELDS) {
          if (existingMeta[f] !== undefined && patchMeta[f] === undefined) {
            patchMeta[f] = existingMeta[f];
          }
        }
        if (
          typeof existingMeta.task === 'object' && existingMeta.task !== null &&
          typeof patchMeta.task === 'object' && patchMeta.task !== null
        ) {
          patchMeta.task = {
            ...(existingMeta.task as Record<string, unknown>),
            ...(patchMeta.task as Record<string, unknown>),
          };
        }
        const merged = { ...existingMeta, ...patchMeta };
        const oldStatus = this.extractTaskStatus(existingMeta);
        const newStatus = this.extractTaskStatus(merged);
        if (newStatus === 'done' && oldStatus !== 'done') {
          if (typeof merged.task === 'object' && merged.task !== null && !Array.isArray(merged.task)) {
            const taskObj = { ...(merged.task as Record<string, unknown>) };
            delete taskObj.order;
            merged.task = taskObj;
          }
        }
        return JSON.stringify(merged);
      })(),
      accessed_at: now,
      updated_at: now,
      lww_device: this.deviceId,
    };

    this.db.transaction(() => {
      this.db.prepare(`UPDATE entries SET title=?, content=?, content_type=?, confidence=?,
        decay_rate=?, visibility=?, tags=?, irrelevant=?, tombstoned_at=?, metadata=?,
        accessed_at=?, updated_at=?, lww_device=? WHERE id=?`).run(
        updated.title, updated.content, updated.content_type, updated.confidence,
        updated.decay_rate, updated.visibility, updated.tags,
        updated.irrelevant, updated.tombstoned_at, updated.metadata,
        updated.accessed_at, updated.updated_at, updated.lww_device, id
      );
      this.insertStagingSync(updated, timestamp, updated.confidence);
    })();

    return rowToEntry(updated);
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
      updated_at: now,
      decay_rate: options.decayRate ?? 0.0,
      visibility: options.visibility ?? 1,
      tags: JSON.stringify(options.tags ?? []),
      irrelevant: 0,
      favorite: 0,
      tombstoned_at: null,
      metadata: JSON.stringify(metadata),
      lww_device: this.deviceId,
    };

    return { entry, now, timestamp };
  }

  private insertEntrySync(entry: RowEntry): void {
    this.db.prepare(`INSERT INTO entries (id, parent_id, title, content, content_type, depth,
      confidence, created_at, accessed_at, updated_at, decay_rate, visibility, tags, irrelevant,
      favorite, tombstoned_at, metadata, lww_device) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      entry.id, entry.parent_id, entry.title, entry.content, entry.content_type, entry.depth,
      entry.confidence, entry.created_at, entry.accessed_at, entry.updated_at, entry.decay_rate,
      entry.visibility, entry.tags, entry.irrelevant, entry.favorite, entry.tombstoned_at, entry.metadata,
      entry.lww_device,
    );
  }

  private insertStagingSync(entry: RowEntry, timestamp: number, confidence: number): void {
    this.db.prepare(`INSERT INTO staging (key, entity_type, operation, payload,
      lww_timestamp, lww_device, lww_confidence)
      VALUES (?, 'entry', 'upsert', ?, ?, ?, ?)`).run(
      entry.id, JSON.stringify(entry), timestamp, this.deviceId, confidence
    );
  }

  /** Atomically insert entry + staging row (rollback on either failure). */
  private writeEntryWithStaging(entry: RowEntry, timestamp: number, confidence: number): void {
    this.db.transaction(() => {
      this.insertEntrySync(entry);
      this.insertStagingSync(entry, timestamp, confidence);
    })();
  }

  async write(content: string, options: WriteOptions = {}): Promise<Entry> {
    const { clean: cleanTags, removed: removedTags } = stripDeprecatedTags(options.tags ?? []);
    if (removedTags.length > 0) {
      console.warn(`[tim-store] Deprecated status/priority tags stripped: ${removedTags.join(', ')}`);
    }
    options = { ...options, tags: cleanTags };

    if (options.parentId && parentIsSecret(this.db, options.parentId)) {
      options = {
        ...options,
        metadata: { ...(options.metadata ?? {}), secret: true },
      };
    }

    const { entry, now, timestamp } = this.buildEntryRow(content, options);
    this.writeEntryWithStaging(entry, timestamp, options.confidence ?? 1.0);

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
    const result = this.updateSync(id, patch);
    this.emit('memory:updated', { entry: result, agentId: this.agentId, timestamp: result.accessedAt });
    return result;
  }

  async delete(id: string, hard: boolean = false): Promise<void> {
    const existing = this.db.prepare('SELECT * FROM entries WHERE id = ?').get(id) as RowEntry | undefined;
    if (!existing) return;

    const now = new Date().toISOString();
    this.db.transaction(() => {
      if (hard) {
        this.db.prepare('UPDATE entries SET tombstoned_at = ? WHERE id = ?').run(now, id);
        this.db.prepare(`INSERT INTO staging (key, entity_type, operation, payload,
          lww_timestamp, lww_device, lww_confidence)
          VALUES (?, 'entry', 'delete', ?, ?, ?, ?)`).run(
          id, JSON.stringify({ id, tombstoned_at: now, lww_device: this.deviceId }), Date.now(), this.deviceId, 1.0
        );
      } else {
        const timestamp = Date.now();
        const updated = {
          ...existing,
          irrelevant: 1,
          accessed_at: now,
          updated_at: now,
          lww_device: this.deviceId,
        };
        this.db.prepare('UPDATE entries SET irrelevant = 1, accessed_at = ?, updated_at = ?, lww_device = ? WHERE id = ?').run(now, now, this.deviceId, id);
        this.insertStagingSync(updated, timestamp, updated.confidence);
      }
    })();

    this.emit('memory:deleted', {
      entry: rowToEntry(existing),
      agentId: this.agentId,
      timestamp: now,
    });
  }

  /** Hard/soft delete multiple ids in one transaction; skips missing or tombstoned ids. */
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
        existing.id, JSON.stringify({ id: existing.id, tombstoned_at: now, lww_device: this.deviceId }), Date.now(), this.deviceId, 1.0
      );
    } else {
      const timestamp = Date.now();
      const updated = {
        ...existing,
        irrelevant: 1,
        accessed_at: now,
        updated_at: now,
        lww_device: this.deviceId,
      };
      this.db.prepare('UPDATE entries SET irrelevant = 1, accessed_at = ?, updated_at = ?, lww_device = ? WHERE id = ?').run(now, now, this.deviceId, existing.id);
      this.db.prepare(`INSERT INTO staging (key, entity_type, operation, payload,
        lww_timestamp, lww_device, lww_confidence)
        VALUES (?, 'entry', 'upsert', ?, ?, ?, ?)`).run(
        existing.id, JSON.stringify(updated), timestamp, this.deviceId, updated.confidence
      );
    }
  }

  // ─── Search ────────────────────────────────────────────

  async search(options: SearchOptions): Promise<Entry[]> {
    const topK = options.topK ?? 10;
    const searchType = options.searchType ?? 'hybrid';
    const patterns = this.loadActiveSuppressPatterns();
    const candidates = (await this.searchFts(options.query, topK * 3))
      .filter(e => !TimStore.matchesSuppressed(patterns, e));

    if (searchType === 'fts') {
      const ftsOnly = this.rankByUsage(candidates, topK);
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
        if (proj && !TimStore.matchesSuppressed(patterns, proj) && !ftsOnly.some(e => e.id === proj.id)) {
          return [proj, ...ftsOnly].slice(0, topK);
        }
      }
      return ftsOnly;
    }

    let queryVector: Float32Array | null = null;
    try {
      const useVectors = searchType === 'vector' || searchType === 'hybrid';
      if (useVectors && process.env.TIM_EMBEDDING_DISABLED !== '1' && candidates.length > 0) {
        const placeholders = candidates.map(() => '?').join(', ');
        const hasVectors = this.db.prepare(`
          SELECT 1 FROM entry_vectors
          WHERE entry_id IN (${placeholders})
          LIMIT 1
        `).get(...candidates.map(e => e.id));
        if (hasVectors) {
          const { EmbeddingModel, FlagEmbedding } = await import('fastembed');
          const modelName = process.env.TIM_EMBEDDING_MODEL ?? 'all-MiniLM-L6-v2';
          const resolved = modelName === 'all-MiniLM-L6-v2' ? EmbeddingModel.AllMiniLML6V2 : EmbeddingModel.AllMiniLML6V2;
          const embedder = await FlagEmbedding.init({ model: resolved });
          const batch = await embedder.embed([options.query], 1).next();
          if (batch.value?.[0]) {
            queryVector = new Float32Array(batch.value[0]);
          }
        }
      }
    } catch {
      // No fastembed — use pure FTS + usage
    }

    const fts = searchType === 'vector' && !queryVector
      ? []
      : await this.rankByHybrid(candidates, queryVector, topK);
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
      if (proj && !TimStore.matchesSuppressed(patterns, proj) && !fts.some(e => e.id === proj.id)) {
        return [proj, ...fts].slice(0, topK);
      }
    }
    return fts;
  }

  /**
   * Deterministic usage boost on top of FTS order: an entry's score is its
   * FTS position minus 2·log2(1 + referencedCount); ascending. Referenced
   * 1× → +2 positions, 3× → +4, 7× → +6. No wall-clock, no randomness.
   */
  private rankByUsage(entries: Entry[], topK: number): Entry[] {
    if (process.env.TIM_USAGE_RANKING === '0' || entries.length <= 1) {
      return entries.slice(0, topK);
    }
    const counts = this.getReferenceCounts(entries.map(e => e.id));
    return entries
      .map((e, i) => ({ e, score: i - 2 * Math.log2(1 + (counts.get(e.id) ?? 0)) }))
      .sort((a, b) => a.score - b.score)
      .map(x => x.e)
      .slice(0, topK);
  }

  /**
   * Hybrid re-rank combining three signals:
   *   1. FTS5 position (the raw order)
   *   2. Cosine similarity (embedding distance to query vector)
   *   3. Graph/usage/staleness boost (from Plan 8/10)
   */
  private async rankByHybrid(
    entries: Entry[],
    queryVector: Float32Array | null,
    topK: number,
  ): Promise<Entry[]> {
    if (process.env.TIM_EMBEDDING_DISABLED === '1' || !queryVector) {
      return this.rankByUsage(entries, topK);
    }

    const raw = (process.env.TIM_HYBRID_WEIGHTS ?? '1.0,2.0,0.5').split(',');
    const wFts = Number(raw[0]) || 1;
    const wEmbed = Number(raw[1]) || 2;
    const wGraph = Number(raw[2]) || 0.5;

    const days = staleDays();
    const counts = this.getReferenceCounts(entries.map(e => e.id));

    if (entries.length === 0) return [];

    const vecRows = this.db.prepare(`
      SELECT entry_id, vector, model FROM entry_vectors
      WHERE entry_id IN (${entries.map(() => '?').join(', ')})
    `).all(...entries.map(e => e.id)) as Array<{
      entry_id: string; vector: Buffer; model: string;
    }>;

    if (vecRows.length === 0) {
      return this.rankByUsage(entries, topK);
    }

    const vecMap = new Map<string, Float32Array>();
    for (const row of vecRows) {
      vecMap.set(row.entry_id, new Float32Array(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength / 4));
    }

    const scored = entries.map((e, i) => {
      let score = i * wFts;

      const vec = vecMap.get(e.id);
      if (vec) {
        const similarity = cosineSimilarity(queryVector, vec);
        score -= similarity * wEmbed;
      }

      const refCount = counts.get(e.id) ?? 0;
      const stale = isStale(e, days) ? 1 : 0;
      score -= (refCount * 0.5 - stale * 0.3) * wGraph;

      return { e, score };
    });

    return scored
      .sort((a, b) => a.score - b.score)
      .map(x => x.e)
      .slice(0, topK);
  }

  async searchFts(query: string, limit: number = 10): Promise<Entry[]> {
    // Sanitize FTS5 query — quote tokens; drop quoted FTS operator literals before MATCH.
    // See sanitizeFtsQuery() in store-utils for rationale.
    const sanitized = sanitizeFtsQuery(query)
      .replace(/"(?:AND|OR|NOT|NEAR)"/gi, '')
      .replace(/\s+/g, ' ')
      .trim();
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

  /**
   * Near-duplicate candidates for a title, for the tim_write dedup gate.
   * FTS narrows to plausible candidates; Jaccard token overlap on the
   * title decides. Suppressed/irrelevant/tombstoned entries are already
   * excluded by searchFts.
   */
  async findSimilar(
    title: string,
    opts: { projectLabel?: string; threshold?: number; limit?: number } = {},
  ): Promise<Array<{ id: string; title: string; similarity: number }>> {
    const threshold = opts.threshold ?? 0.6;
    // FTS5 AND-matches every token — drop version suffixes (v2, v10) that
    // Jaccard scoring tolerates but would exclude otherwise-good candidates.
    const ftsQuery = title
      .replace(/\bv\d+\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const candidates = await this.searchFts(ftsQuery || title, 25);
    const hits: Array<{ id: string; title: string; similarity: number }> = [];
    for (const c of candidates) {
      if (opts.projectLabel && this.getProjectLabel(c.id) !== opts.projectLabel) continue;
      const similarity = titleSimilarity(title, c.title);
      if (similarity >= threshold) {
        hits.push({ id: c.id, title: c.title, similarity: Number(similarity.toFixed(2)) });
      }
    }
    return hits.sort((x, y) => y.similarity - x.similarity).slice(0, opts.limit ?? 5);
  }

  /**
   * Negative-memory lookup for the tim_guard pre-action check: FTS over
   * the query, filtered to failure knowledge (kind error/learning, or
   * #error/#learning tagged). Over-fetches because most FTS hits are not
   * failures. Plain-language actions are split into keywords (OR semantics)
   * because FTS5 AND-matching every token is too strict for guard queries.
   */
  async searchFailures(
    query: string,
    opts: { projectLabel?: string; limit?: number } = {},
  ): Promise<Entry[]> {
    const limit = opts.limit ?? 5;
    const STOP = new Set([
      'the', 'and', 'for', 'with', 'from', 'this', 'that', 'via', 'into',
      'your',
      // German function words — actions often mix DE/EN (Finding 2 established DE matters)
      'der', 'die', 'das', 'und', 'mit', 'von', 'für', 'auf', 'ist', 'nicht',
    ]);
    const keywords = query
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(w => w.length >= 3 && !STOP.has(w));
    const terms = keywords.length > 0 ? keywords : [query.trim()].filter(Boolean);

    const seen = new Set<string>();
    const hits: Entry[] = [];
    for (const term of terms) {
      for (const e of await this.searchFts(term, 50)) {
        if (seen.has(e.id)) continue;
        seen.add(e.id);
        hits.push(e);
      }
    }

    const failures = hits.filter(e => {
      const kind = typeof e.metadata.kind === 'string' ? e.metadata.kind : '';
      return kind === 'error' || kind === 'learning'
        || e.tags.includes('#error') || e.tags.includes('#learning');
    });
    if (!opts.projectLabel) return failures.slice(0, limit);
    return failures
      .filter(e => this.getProjectLabel(e.id) === opts.projectLabel)
      .slice(0, limit);
  }

  /**
   * All entries in the project subtree touched since the cutoff, for the
   * tim_delta session briefing supplement. Tombstoned entries appear as
   * "deleted" (their reads are otherwise filtered). Capped at 500 —
   * beyond that, a delta is no longer a briefing.
   */
  async getChangedSince(
    projectId: string,
    sinceIso: string,
  ): Promise<{ created: Entry[]; updated: Entry[]; deleted: Entry[] }> {
    const rows = this.db.prepare(`
      WITH RECURSIVE sub(id) AS (
        SELECT id FROM entries WHERE id = ?
        UNION ALL
        SELECT e.id FROM entries e JOIN sub ON e.parent_id = sub.id
      )
      SELECT e.* FROM entries e
      WHERE e.id IN (SELECT id FROM sub)
        AND e.id != ?
        AND (
          e.created_at >= ?
          OR e.updated_at >= ?
          OR (e.tombstoned_at IS NOT NULL AND e.tombstoned_at >= ?)
        )
      ORDER BY e.updated_at DESC, e.rowid DESC
      LIMIT 500
    `).all(projectId, projectId, sinceIso, sinceIso, sinceIso) as RowEntry[];

    const created: Entry[] = [];
    const updated: Entry[] = [];
    const deleted: Entry[] = [];
    for (const row of rows) {
      const entry = rowToEntry(row);
      if (row.tombstoned_at) deleted.push(entry);
      else if (row.created_at >= sinceIso) created.push(entry);
      else updated.push(entry);
    }
    return { created, updated, deleted };
  }

  /** Newest session entry in the project subtree, excluding the current session. */
  async getPreviousSession(
    projectId: string,
    excludeSessionId?: string | null,
  ): Promise<Entry | null> {
    const excluded = excludeSessionId
      ? this.resolveSessionAlias(excludeSessionId)
      : excludeSessionId;
    const row = this.db.prepare(`
      WITH RECURSIVE sub(id) AS (
        SELECT id FROM entries WHERE id = ?
        UNION ALL
        SELECT e.id FROM entries e JOIN sub ON e.parent_id = sub.id
      )
      SELECT e.* FROM entries e
      WHERE e.id IN (SELECT id FROM sub)
        AND json_extract(e.metadata, '$.kind') = 'session'
        AND e.tombstoned_at IS NULL
        AND e.id != COALESCE(?, '')
      ORDER BY e.created_at DESC, e.rowid DESC
      LIMIT 1
    `).get(projectId, excluded ?? null) as RowEntry | undefined;
    return row ? rowToEntry(row) : null;
  }

  // ─── Edges ─────────────────────────────────────────────

  async link(
    sourceId: string, targetId: string, type: EdgeType,
    weight: number = 1.0, metadata: Record<string, unknown> = {}
  ): Promise<Edge> {
    const id = ulid();
    const ts = Date.now();

    const edgeRow = {
      id,
      source_id: sourceId,
      target_id: targetId,
      type,
      weight,
      metadata: JSON.stringify(metadata),
      updated_at: new Date(ts).toISOString(),
    };

    const edgeKey = `${sourceId}|${targetId}|${type}`;
    this.db.transaction(() => {
      this.db.prepare(`INSERT INTO edges (id, source_id, target_id, type, weight, metadata, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        edgeRow.id, edgeRow.source_id, edgeRow.target_id,
        edgeRow.type, edgeRow.weight, edgeRow.metadata, edgeRow.updated_at,
      );
      this.db.prepare(`INSERT INTO staging (key, entity_type, operation, payload,
        lww_timestamp, lww_device, lww_confidence)
        VALUES (?, 'edge', 'upsert', ?, ?, ?, ?)`).run(
        edgeKey, JSON.stringify(edgeRow), ts, this.agentId, 1.0,
      );
    })();

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
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM edges WHERE id = ?').run(edgeId);
      this.db.prepare(`INSERT INTO staging (key, entity_type, operation, payload,
        lww_timestamp, lww_device, lww_confidence)
        VALUES (?, 'edge', 'delete', ?, ?, ?, ?)`).run(
        edgeKey, JSON.stringify(edgeRow), ts, this.agentId, 1.0,
      );
    })();

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
       accessed_at, updated_at, decay_rate, visibility, tags, irrelevant, favorite, tombstoned_at, metadata, lww_device)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

    const upsertEdge = this.db.prepare(`INSERT OR REPLACE INTO edges
      (id, source_id, target_id, type, weight, metadata, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);

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
                entryLocalLwwTimestamp(existing),
                String(existing.lww_device ?? 'local'),
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
                entryLocalLwwTimestamp(existing),
                String(existing.lww_device ?? 'local'),
                Number(existing.confidence ?? 1),
              );
              const { winner } = resolveLWW(local, record);
              if (winner !== record) continue;
            }
            // Slot-collision guard for batch-summaries (see sync-methods.ts applyRemoteEntry)
            let slotCollisionEntry: RowEntry | undefined;
            if (entry.metadata) {
              const meta = typeof entry.metadata === 'string' ? JSON.parse(entry.metadata) : entry.metadata;
              if (meta.kind === 'batch-summary' && meta.batch_index !== undefined && entry.parent_id) {
                slotCollisionEntry = this.db.prepare(
                  `SELECT * FROM entries
                   WHERE parent_id = ? AND json_extract(metadata, '$.batch_index') = ?
                     AND json_extract(metadata, '$.kind') = 'batch-summary'
                     AND id != ?`,
                ).get(entry.parent_id, meta.batch_index, entry.id) as RowEntry | undefined;
                if (slotCollisionEntry) {
                  const localSlot = recordFromPayload(
                    slotCollisionEntry.id, 'entry',
                    slotCollisionEntry.tombstoned_at ? 'delete' : 'upsert',
                    JSON.stringify(slotCollisionEntry),
                    entryLocalLwwTimestamp(slotCollisionEntry),
                    String(slotCollisionEntry.lww_device ?? 'local'),
                    Number(slotCollisionEntry.confidence ?? 1),
                  );
                  const { winner } = resolveLWW(localSlot, record);
                  if (winner === localSlot) continue;
                  deleteEntry.run(slotCollisionEntry.id);
                }
              }
            }
            const appliedUpdatedAt = new Date(record.lwwTimestamp).toISOString();
            upsertEntry.run(
              entry.id, entry.parent_id, entry.title ?? '', entry.content, entry.content_type,
              entry.depth, entry.confidence, entry.created_at, entry.accessed_at,
              appliedUpdatedAt,
              entry.decay_rate, entry.visibility, entry.tags,
              entry.irrelevant, entry.favorite ?? 0, entry.tombstoned_at, entry.metadata,
              record.lwwDevice,
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
                edgeLocalLwwTimestamp(existing),
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
                edgeLocalLwwTimestamp(existing),
                'local',
              );
              const { winner } = resolveLWW(local, record);
              if (winner !== record) continue;
            }
            upsertEdge.run(
              edge.id, edge.source_id, edge.target_id,
              edge.type, edge.weight, edge.metadata,
              new Date(record.lwwTimestamp).toISOString(),
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

  // ─── Retrieval usage feedback (device-local, never synced) ─────

  private usageGcDone = false;

  /** Record that these entries were surfaced to the agent (read or search hit). */
  recordRead(entryIds: string[], sessionId: string | null): void {
    if (entryIds.length === 0) return;
    // Opportunistic GC, once per process: usage older than 180 days is noise.
    if (!this.usageGcDone) {
      this.usageGcDone = true;
      const cutoff = new Date(Date.now() - 180 * 86400_000).toISOString();
      this.db.prepare('DELETE FROM entry_usage WHERE read_at < ?').run(cutoff);
    }
    const now = new Date().toISOString();
    const stmt = this.db.prepare(
      'INSERT INTO entry_usage (entry_id, session_id, read_at) VALUES (?, ?, ?)',
    );
    this.db.transaction(() => {
      for (const id of new Set(entryIds)) stmt.run(id, sessionId, now);
    })();
  }

  /**
   * Mark previously-read entries as actually used (linked, updated, or
   * cited in a later write). Only flips rows of the same session — a
   * reference without a prior read in that session is not a retrieval win.
   */
  markReferenced(entryIds: string[], sessionId: string | null): number {
    if (entryIds.length === 0 || !sessionId) return 0;
    const unique = [...new Set(entryIds)];
    const placeholders = unique.map(() => '?').join(', ');
    const info = this.db.prepare(`
      UPDATE entry_usage SET referenced = 1
      WHERE session_id = ? AND referenced = 0 AND entry_id IN (${placeholders})
    `).run(sessionId, ...unique);
    return info.changes;
  }

  getSessionReadIds(sessionId: string): string[] {
    const rows = this.db.prepare(
      'SELECT DISTINCT entry_id FROM entry_usage WHERE session_id = ?',
    ).all(sessionId) as Array<{ entry_id: string }>;
    return rows.map(r => r.entry_id);
  }

  getReferenceCounts(entryIds: string[]): Map<string, number> {
    if (entryIds.length === 0) return new Map();
    const unique = [...new Set(entryIds)];
    const placeholders = unique.map(() => '?').join(', ');
    const rows = this.db.prepare(`
      SELECT entry_id, COUNT(DISTINCT session_id) AS c FROM entry_usage
      WHERE referenced = 1 AND entry_id IN (${placeholders})
      GROUP BY entry_id
    `).all(...unique) as Array<{ entry_id: string; c: number }>;
    return new Map(rows.map(r => [r.entry_id, r.c]));
  }

  // ─── Embedding vectors (device-local, never synced) ─────

  /**
   * Entries that need embedding (no vector yet, newest content first).
   * Schema kinds (sessions, sections, …) are skipped — they don't need
   * semantic search.
   */
  async getUnembedded(count: number): Promise<Entry[]> {
    const scopesKinds = [...SCHEMA_KINDS].map(() => '?').join(', ');
    const rows = this.db.prepare(`
      SELECT e.* FROM entries e
      LEFT JOIN entry_vectors v ON v.entry_id = e.id
      WHERE v.entry_id IS NULL
        AND e.tombstoned_at IS NULL
        AND e.irrelevant = 0
        AND (json_extract(e.metadata, '$.kind') IS NULL
             OR json_extract(e.metadata, '$.kind') NOT IN (${scopesKinds}))
      ORDER BY e.updated_at DESC, e.rowid DESC
      LIMIT ?
    `).all(...SCHEMA_KINDS, count) as RowEntry[];
    return rows.map(rowToEntry);
  }

  /** Store an embedding vector for an entry. Upserts — second call replaces. */
  setVectors(entryId: string, vector: Float32Array, model: string): void {
    const blob = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
    this.db.prepare(
      `INSERT INTO entry_vectors (entry_id, model, vector)
       VALUES (?, ?, ?)
       ON CONFLICT(entry_id) DO UPDATE SET model = excluded.model, vector = excluded.vector`,
    ).run(entryId, model, blob);
  }

  // ─── Health ────────────────────────────────────────────

  async health(): Promise<HealthReport> {
    const issues: string[] = [];
    const blockers: string[] = [];
    const warnings: string[] = [];

    // Broken links: edges referencing deleted/tombstoned entries
    const brokenLinks = this.db.prepare(`
      SELECT COUNT(*) as count FROM edges e
      LEFT JOIN entries s ON e.source_id = s.id
      LEFT JOIN entries t ON e.target_id = t.id
      WHERE s.id IS NULL OR s.tombstoned_at IS NOT NULL
         OR t.id IS NULL OR t.tombstoned_at IS NOT NULL
    `).get() as { count: number };
    if (brokenLinks.count > 0) {
      const message = `${brokenLinks.count} broken links`;
      warnings.push(message);
      issues.push(message);
    }

    // Orphan entries: live entries whose parent_id references a missing or
    // tombstoned parent. Leaves without edges are normal tree nodes, NOT
    // orphans — the old metric counted those and produced numbers larger
    // than the entry count.
    const orphans = this.db.prepare(`
      SELECT COUNT(*) as count FROM entries e
      WHERE e.tombstoned_at IS NULL
        AND e.parent_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM entries p
          WHERE p.id = e.parent_id AND p.tombstoned_at IS NULL
        )
    `).get() as { count: number };
    if (orphans.count > 0) {
      const message = `${orphans.count} orphan entries`;
      warnings.push(message);
      issues.push(message);
    }

    // FTS integrity
    let ftsOk = true;
    try {
      this.db.prepare("INSERT INTO fts_entries(fts_entries) VALUES ('integrity-check')").run();
    } catch {
      ftsOk = false;
      const message = 'FTS5 index integrity failure';
      blockers.push(message);
      issues.push(message);
    }

    // Counts
    const totalEntries = (this.db.prepare('SELECT COUNT(*) as count FROM entries WHERE irrelevant = 0').get() as { count: number }).count;
    const totalEdges = (this.db.prepare('SELECT COUNT(*) as count FROM edges').get() as { count: number }).count;

    // Stale knowledge: non-schema entries not verified/edited within the
    // threshold. Schema entries (sessions, sections, …) are structure and
    // don't go stale. Day count uses Math.floor — same as tim-core isStale().
    const threshold = staleDays();
    const kindList = [...SCHEMA_KINDS].map(() => '?').join(', ');
    const stale = this.db.prepare(`
      SELECT COUNT(*) as count FROM entries
      WHERE irrelevant = 0 AND tombstoned_at IS NULL
        AND (json_extract(metadata, '$.kind') IS NULL
             OR json_extract(metadata, '$.kind') NOT IN (${kindList}))
        AND CAST(
          (strftime('%s','now') - strftime('%s', COALESCE(
            json_extract(metadata, '$.verified_at'),
            COALESCE(NULLIF(updated_at, ''), created_at)
          ))) / 86400.0 AS INTEGER) > ?
    `).get(...SCHEMA_KINDS, threshold) as { count: number };
    if (stale.count > 0) {
      const message = `${stale.count} stale entries (older than ${threshold}d, unverified)`;
      warnings.push(message);
      issues.push(message);
    }

    const status = blockers.length > 0 ? 'BLOCKER' : warnings.length > 0 ? 'WARN' : 'OK';

    return {
      status,
      blockers,
      warnings,
      brokenLinks: brokenLinks.count,
      orphanEntries: orphans.count,
      ftsIntegrity: ftsOk,
      totalEntries,
      totalEdges,
      staleEntries: stale.count,
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

  /**
   * Re-confirm entries as still valid without editing them. Stamps
   * metadata.verified_at and bumps updated_at (a verification is a
   * meaningful, syncable change — the staging upsert carries it to
   * other devices). Staleness elsewhere is verified_at ?? updated_at.
   */
  async touchVerified(ids: string[]): Promise<{ verified: string[]; missing: string[] }> {
    const now = new Date().toISOString();
    const timestamp = Date.now();
    const verified: string[] = [];
    const missing: string[] = [];

    this.db.transaction(() => {
      for (const id of [...new Set(ids)]) {
        const existing = this.db.prepare('SELECT * FROM entries WHERE id = ?').get(id) as
          RowEntry | undefined;
        if (!existing || existing.tombstoned_at) {
          missing.push(id);
          continue;
        }
        const metadata = JSON.stringify({
          ...JSON.parse(existing.metadata || '{}'),
          verified_at: now,
        });
        const updated = { ...existing, metadata, accessed_at: now, updated_at: now };
        this.db.prepare(
          'UPDATE entries SET metadata = ?, accessed_at = ?, updated_at = ? WHERE id = ?',
        ).run(metadata, now, now, id);
        this.db.prepare(`INSERT INTO staging (key, entity_type, operation, payload,
          lww_timestamp, lww_device, lww_confidence)
          VALUES (?, 'entry', 'upsert', ?, ?, 'local', ?)`).run(
          id, JSON.stringify(updated), timestamp, existing.confidence,
        );
        verified.push(id);
      }
    })();

    return { verified, missing };
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

  /** Active (non-expired) suppress patterns, lowercased. Loaded once per retrieval call. */
  private loadActiveSuppressPatterns(): string[] {
    const now = new Date().toISOString();
    const rows = this.db.prepare(
      'SELECT pattern FROM suppressed WHERE expires_at IS NULL OR expires_at > ?',
    ).all(now) as { pattern: string }[];
    return rows.map(r => r.pattern.toLowerCase());
  }

  private static matchesSuppressed(
    patterns: string[],
    entry: { title: string; content: string },
  ): boolean {
    if (patterns.length === 0) return false;
    const text = `${entry.title}\n${entry.content}`.toLowerCase();
    return patterns.some(p => text.includes(p));
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

export interface GoldenQuery {
  query: string;
  expectedIds: string[];
}

export interface BenchmarkResult {
  query: string;
  precisionAt3: number;
  recallAt5: number;
  mrr: number;
  found: string[];
  missing: string[];
}

export async function runBenchmark(
  store: TimStore,
  queries: GoldenQuery[],
): Promise<BenchmarkResult[]> {
  const results: BenchmarkResult[] = [];
  for (const q of queries) {
    const hits = await store.search({ query: q.query, topK: 10 });
    const hitIds = hits.map(e => e.id);
    const found = q.expectedIds.filter(id => hitIds.includes(id));
    const missing = q.expectedIds.filter(id => !hitIds.includes(id));

    const top3 = hitIds.slice(0, 3);
    const relevantTop3 = q.expectedIds.filter(id => top3.includes(id));
    const precisionAt3 = top3.length > 0 ? relevantTop3.length / top3.length : 0;

    const top5 = hitIds.slice(0, 5);
    const relevantTop5 = q.expectedIds.filter(id => top5.includes(id));
    const recallAt5 = q.expectedIds.length > 0 ? relevantTop5.length / q.expectedIds.length : 1;

    let mrr = 0;
    for (let i = 0; i < hitIds.length; i++) {
      if (q.expectedIds.includes(hitIds[i])) {
        mrr = 1 / (i + 1);
        break;
      }
    }

    results.push({ query: q.query, precisionAt3, recallAt5, mrr, found, missing });
  }
  return results;
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
  updated_at: string;
  decay_rate: number;
  visibility: number;
  tags: string;
  irrelevant: number;
  favorite: number;
  tombstoned_at: string | null;
  metadata: string;
  lww_device: string;
}

interface RowEdge {
  id: string;
  source_id: string;
  target_id: string;
  type: string;
  weight: number;
  metadata: string;
  updated_at: string;
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

export function splitTitleBody(content: string, explicitTitle?: string): { title: string; body: string } {
  if (explicitTitle !== undefined) {
    return { title: explicitTitle.trim(), body: content };
  }
  const nl = content.indexOf('\n');
  if (nl === -1) return { title: content.trim(), body: '' };
  return { title: content.slice(0, nl).trim(), body: content.slice(nl + 1).trim() };
}

/** Cosine similarity between two same-length vectors. Range: [-1, 1]. */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
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
