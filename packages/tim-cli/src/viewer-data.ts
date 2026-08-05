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

import Database from 'better-sqlite3';
import { isSecret, parseAndCoerceMetadata } from 'tim-store';

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
] as const;

export const REDACTED_TITLE = '[secret — redacted]';

interface EntryRow {
  id: string;
  parent_id: string | null;
  title: string | null;
  content: string;
  content_type: string;
  depth: number;
  confidence: number;
  created_at: string;
  accessed_at: string;
  updated_at: string;
  visibility: number;
  tags: string;
  irrelevant: number;
  favorite: number;
  tombstoned_at: string | null;
  metadata: string;
}

interface ParsedEntry {
  row: EntryRow;
  tags: string[];
  metadata: Record<string, unknown>;
}

export interface ViewerNode {
  id: string;
  parentId: string | null;
  title: string;
  kind: string | null;
  type: string | null;
  label: string | null;
  /** Raw metadata.render_depth — null when the node does not set one. */
  renderDepth: unknown;
  order: unknown;
  seq: unknown;
  batchIndex: unknown;
  taskStatus: string | null;
  tags: string[];
  contentChars: number;
  childCount: number;
  /** Children excluded by the store's read paths (irrelevant or tombstoned). */
  hiddenChildCount: number;
  secret: boolean;
  redacted: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ViewerNodeDetail extends ViewerNode {
  content: string | null;
  contentType: string;
  metadata: Record<string, unknown>;
  depth: number;
  confidence: number;
  visibility: number;
  favorite: boolean;
  irrelevant: boolean;
  accessedAt: string;
  path: ViewerCrumb[];
}

export interface ViewerCrumb {
  id: string;
  title: string;
  kind: string | null;
  label: string | null;
}

export interface ViewerChildren {
  parent: ViewerNode;
  children: ViewerNode[];
}

export interface ViewerStats {
  databasePath: string;
  readOnly: boolean;
  /** Schema version recorded in the file. */
  schemaVersion: number;
  showSecrets: boolean;
  projectCount: number;
  totalEntries: number;
  hiddenEntries: number;
  secretEntries: number;
  edgeCount: number;
}

export interface ViewerDataOptions {
  /** When false (default) secret subtrees are structure-only. */
  showSecrets?: boolean;
}

interface ChildCount {
  visible: number;
  hidden: number;
}

const ENTRY_COLUMNS =
  'id, parent_id, title, content, content_type, depth, confidence, created_at,' +
  ' accessed_at, updated_at, visibility, tags, irrelevant, favorite, tombstoned_at, metadata';

/** Mirrors store.ts rowToEntry: metadata coerced, tags parsed defensively. */
function parseRow(row: EntryRow): ParsedEntry {
  let tags: string[] = [];
  try {
    const parsed = JSON.parse(row.tags) as unknown;
    if (Array.isArray(parsed)) tags = parsed as string[];
  } catch {
    tags = [];
  }
  let metadata: Record<string, unknown> = {};
  try {
    metadata = parseAndCoerceMetadata(row.metadata);
  } catch {
    metadata = {};
  }
  return { row, tags, metadata };
}

function metaString(entry: ParsedEntry, key: string): string | null {
  const value = entry.metadata[key];
  return typeof value === 'string' ? value : null;
}

function taskStatusOf(entry: ParsedEntry): string | null {
  const task = entry.metadata.task;
  if (task && typeof task === 'object') {
    const status = (task as Record<string, unknown>).status;
    if (typeof status === 'string') return status;
  }
  return null;
}

function structuralMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of STRUCTURAL_METADATA_KEYS) {
    if (metadata[key] !== undefined) out[key] = metadata[key];
  }
  return out;
}

export class ViewerData {
  private readonly db: Database.Database;
  private readonly showSecrets: boolean;
  private readonly databasePath: string;

  constructor(db: Database.Database, options: ViewerDataOptions = {}) {
    this.db = db;
    this.showSecrets = options.showSecrets === true;
    this.databasePath = db.name;
  }

  /** Open the viewer's own read-only handle. Never migrates, never writes. */
  static open(dbPath: string, options: ViewerDataOptions = {}): ViewerData {
    return new ViewerData(new Database(dbPath, { readonly: true, fileMustExist: true }), options);
  }

  getDb(): Database.Database {
    return this.db;
  }

  close(): void {
    this.db.close();
  }

  /**
   * Resolve an entry by id, with the same label fallback store.read() has
   * (so "P0001" works as well as a raw entry id).
   */
  private readEntry(id: string): ParsedEntry | null {
    let row = this.db
      .prepare(`SELECT ${ENTRY_COLUMNS} FROM entries WHERE id = ?`)
      .get(id) as EntryRow | undefined;
    if (!row && /^[A-Z]\d{4}$/.test(id)) {
      row = this.db.prepare(
        `SELECT ${ENTRY_COLUMNS} FROM entries
         WHERE json_extract(metadata, '$.label') = ? AND tombstoned_at IS NULL`,
      ).get(id) as EntryRow | undefined;
    }
    return row ? parseRow(row) : null;
  }

  /**
   * Counted in one grouped query per batch of parents rather than a count
   * per node — a project's Exchanges subtree can be thousands wide.
   * `hidden` is what the store's read paths filter out (soft-deleted or
   * tombstoned): reported as a number so nothing is silently invisible.
   */
  private childCounts(parentIds: string[]): Map<string, ChildCount> {
    const counts = new Map<string, ChildCount>();
    if (parentIds.length === 0) return counts;
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
      `).all(...chunk) as { pid: string; visible: number; hidden: number }[];
      for (const row of rows) {
        counts.set(row.pid, { visible: row.visible ?? 0, hidden: row.hidden ?? 0 });
      }
    }
    return counts;
  }

  private toNode(entry: ParsedEntry, counts: ChildCount, secret: boolean): ViewerNode {
    const redacted = secret && !this.showSecrets;
    const row = entry.row;
    return {
      id: row.id,
      parentId: row.parent_id,
      title: redacted ? REDACTED_TITLE : (row.title ?? ''),
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
  listProjects(): ViewerNode[] {
    const rows = this.db.prepare(`
      SELECT ${ENTRY_COLUMNS} FROM entries
      WHERE json_extract(metadata, '$.kind') = 'project'
        AND irrelevant = 0
        AND tombstoned_at IS NULL
      ORDER BY json_extract(metadata, '$.label') ASC, created_at ASC
    `).all() as EntryRow[];

    const projects = rows.map(parseRow);
    const counts = this.childCounts(projects.map(p => p.row.id));
    return projects.map(p =>
      this.toNode(
        p,
        counts.get(p.row.id) ?? { visible: 0, hidden: 0 },
        isSecret(this.db, p.row.id),
      ),
    );
  }

  /**
   * Children of `id` — all of them, in tree order. `id` may be an entry id
   * or a project label.
   */
  children(id: string): ViewerChildren | null {
    const parent = this.readEntry(id);
    if (!parent) return null;

    // Same visibility filter as store.getChildren().
    const rows = this.db.prepare(`
      SELECT ${ENTRY_COLUMNS} FROM entries
      WHERE parent_id = ?
        AND irrelevant = 0
        AND tombstoned_at IS NULL
    `).all(parent.row.id) as EntryRow[];

    const children = sortChildren(rows.map(parseRow));
    const counts = this.childCounts([parent.row.id, ...children.map(c => c.row.id)]);
    // Secrecy is inherited: resolve the parent chain once, then a child is
    // secret iff the parent is or it carries its own flag.
    const parentSecret = isSecret(this.db, parent.row.id);

    return {
      parent: this.toNode(
        parent,
        counts.get(parent.row.id) ?? { visible: 0, hidden: 0 },
        parentSecret,
      ),
      children: children.map(child =>
        this.toNode(
          child,
          counts.get(child.row.id) ?? { visible: 0, hidden: 0 },
          parentSecret || child.metadata.secret === true,
        ),
      ),
    };
  }

  node(id: string): ViewerNodeDetail | null {
    const entry = this.readEntry(id);
    if (!entry) return null;

    const secret = isSecret(this.db, entry.row.id);
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
  private ancestors(entry: ParsedEntry): ViewerCrumb[] {
    const crumbs: ViewerCrumb[] = [];
    const seen = new Set<string>([entry.row.id]);
    let parentId = entry.row.parent_id;

    while (parentId && !seen.has(parentId)) {
      seen.add(parentId);
      const row = this.db
        .prepare('SELECT id, parent_id, title, metadata FROM entries WHERE id = ?')
        .get(parentId) as
        | { id: string; parent_id: string | null; title: string | null; metadata: string }
        | undefined;
      if (!row) break;
      let meta: Record<string, unknown> = {};
      try {
        meta = JSON.parse(row.metadata) as Record<string, unknown>;
      } catch {
        meta = {};
      }
      const crumbSecret = meta.secret === true || Number(meta.secret) === 1;
      crumbs.unshift({
        id: row.id,
        title: crumbSecret && !this.showSecrets ? REDACTED_TITLE : (row.title ?? ''),
        kind: typeof meta.kind === 'string' ? meta.kind : null,
        label: typeof meta.label === 'string' ? meta.label : null,
      });
      parentId = row.parent_id;
    }

    return crumbs;
  }

  stats(): ViewerStats {
    const one = (sql: string): number =>
      (this.db.prepare(sql).get() as { c: number } | undefined)?.c ?? 0;

    return {
      databasePath: this.databasePath,
      readOnly: this.db.readonly,
      schemaVersion: this.schemaVersion(),
      showSecrets: this.showSecrets,
      projectCount: one(
        "SELECT COUNT(*) AS c FROM entries WHERE json_extract(metadata, '$.kind') = 'project'" +
          ' AND irrelevant = 0 AND tombstoned_at IS NULL',
      ),
      totalEntries: one(
        'SELECT COUNT(*) AS c FROM entries WHERE irrelevant = 0 AND tombstoned_at IS NULL',
      ),
      hiddenEntries: one(
        'SELECT COUNT(*) AS c FROM entries WHERE irrelevant = 1 OR tombstoned_at IS NOT NULL',
      ),
      secretEntries: one(
        "SELECT COUNT(*) AS c FROM entries WHERE json_extract(metadata, '$.secret') = 1",
      ),
      edgeCount: one('SELECT COUNT(*) AS c FROM edges'),
    };
  }

  /** Schema version recorded in the file (0 when the table is absent). */
  private schemaVersion(): number {
    try {
      const row = this.db.prepare('SELECT version FROM _schema_version').get() as
        | { version: number }
        | undefined;
      return row?.version ?? 0;
    } catch {
      return 0;
    }
  }
}

/**
 * Tree order. store.getChildren() sorts by metadata.order, but the store
 * auto-assigns `order` from insertion sequence, while session turns and
 * batch summaries carry their own authoritative seq / batch_index. Those
 * win when present, so Exchanges → Batch N → turns reads in true
 * conversation order; created_at breaks remaining ties.
 */
export function sortChildren(children: ParsedEntry[]): ParsedEntry[] {
  const rank = (entry: ParsedEntry): number => {
    for (const key of ['seq', 'batch_index', 'order']) {
      const raw = entry.metadata[key];
      if (raw === undefined || raw === null) continue;
      const num = typeof raw === 'number' ? raw : Number(raw);
      if (Number.isFinite(num)) return num;
    }
    return Number.POSITIVE_INFINITY;
  };
  return [...children].sort((a, b) => {
    const diff = rank(a) - rank(b);
    // Infinity - Infinity is NaN: both unranked, fall through to created_at.
    if (Number.isFinite(diff) && diff !== 0) return diff;
    return a.row.created_at.localeCompare(b.row.created_at);
  });
}
