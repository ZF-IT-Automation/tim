// Read-only projection of the entry tree for `tim viewer`. This module never
// writes; the viewer's tool panel reaches a writable store only by forwarding
// to the MCP server (see viewer-tools.ts), never through here.
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
  /** Visible nodes in this root's full subtree, populated by root-list routes. */
  entryCount?: number;
  /** Children excluded by the store's read paths (irrelevant or tombstoned). */
  hiddenChildCount: number;
  /** This node is itself soft-deleted or tombstoned — the store's read paths skip it. */
  hidden: boolean;
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

export interface ViewerGraphNode {
  id: string;
  title: string;
  kind: string | null;
  type: string | null;
  label: string | null;
  taskStatus: string | null;
  priority?: string;
  tags: string[];
  childCount: number;
  degree: number;
  depth: number | null;
  secret: boolean;
  redacted: boolean;
  external?: true;
  hidden?: boolean;
}

export interface ViewerGraphLink {
  source: string;
  target: string;
  type: string;
  weight: number;
}

export interface ViewerGraph {
  root: string;
  nodes: ViewerGraphNode[];
  links: ViewerGraphLink[];
  truncated: boolean;
  total: number;
}

export interface ViewerGraphOptions {
  includeHidden?: boolean;
  includeSessions?: boolean;
  includeTags?: boolean;
  includeCrossLinks?: boolean;
  depth?: number;
  limit?: number;
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

/** High-volume conversation and checkpoint records omitted from the graph by default. */
export const GRAPH_SESSION_KINDS: ReadonlySet<string> = new Set([
  'sessions-root',
  'session',
  'session-summary-root',
  'batch-summary',
  'exchanges-root',
  'exchange-batch',
  'exchange',
  'checkpoint',
  'checkpoint-summary',
  'log-turn',
  'session-alias',
]);

function graphPriority(metadata: Record<string, unknown>): string | null {
  for (const key of ['task', 'bug', 'idea']) {
    const nested = metadata[key];
    if (nested && typeof nested === 'object') {
      const record = nested as Record<string, unknown>;
      for (const name of ['priority', 'severity']) {
        const value = record[name];
        if (typeof value === 'string' || typeof value === 'number') return String(value);
      }
    }
  }
  for (const value of [metadata.priority, metadata.severity]) {
    if (typeof value === 'string' || typeof value === 'number') return String(value);
  }
  return null;
}

function entryIsSecret(entry: ParsedEntry): boolean {
  return entry.metadata.secret === true || Number(entry.metadata.secret) === 1;
}

function isGraphSessionKind(kind: string | null): boolean {
  if (!kind) return false;
  return GRAPH_SESSION_KINDS.has(kind) ||
    /(?:session|exchange|batch|summary|checkpoint|log[-_]turn)/i.test(kind);
}

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

  /** Visible entry totals for a batch of roots, including each root itself. */
  private subtreeEntryCounts(rootIds: string[]): Map<string, number> {
    if (!rootIds.length) return new Map();
    const counts = new Map<string, number>();
    const placeholders = rootIds.map(() => '?').join(',');
    const rows = this.db.prepare(`
      WITH RECURSIVE subtree(root_id, id, path) AS (
        SELECT id, id, '|' || id || '|'
        FROM entries WHERE id IN (${placeholders})
        UNION ALL
        SELECT subtree.root_id, child.id, subtree.path || child.id || '|'
        FROM entries child JOIN subtree ON child.parent_id = subtree.id
        WHERE child.irrelevant = 0 AND child.tombstoned_at IS NULL
          AND instr(subtree.path, '|' || child.id || '|') = 0
      )
      SELECT root_id, COUNT(*) AS entry_count FROM subtree GROUP BY root_id
    `).all(...rootIds) as Array<{ root_id: string; entry_count: number }>;
    for (const row of rows) counts.set(row.root_id, row.entry_count);
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
      hidden: row.irrelevant === 1 || row.tombstoned_at !== null,
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
    const rootIds = projects.map(p => p.row.id);
    const counts = this.childCounts(rootIds);
    const totals = this.subtreeEntryCounts(rootIds);
    return projects.map(p => ({
      ...this.toNode(
        p,
        counts.get(p.row.id) ?? { visible: 0, hidden: 0 },
        isSecret(this.db, p.row.id),
      ),
      entryCount: totals.get(p.row.id) ?? 1,
    }));
  }

  /**
   * Top-level entries that are not projects. `listProjects` only ever offered
   * `kind='project'` as an entry point, which left every other parentless
   * entry — imports, stray roots, sections whose project was retired —
   * invisible in the tree even though the store still holds them.
   *
   * IFNULL, not a bare `!= 'project'`: json_extract returns NULL when the key
   * is absent, and `NULL != 'project'` is NULL, so the plain comparison would
   * filter out exactly the kind-less roots this exists to surface.
   */
  otherRoots(): ViewerNode[] {
    const rows = this.db.prepare(`
      SELECT ${ENTRY_COLUMNS} FROM entries
      WHERE parent_id IS NULL
        AND IFNULL(json_extract(metadata, '$.kind'), '') != 'project'
        AND irrelevant = 0
        AND tombstoned_at IS NULL
      ORDER BY created_at ASC
    `).all() as EntryRow[];

    const roots = rows.map(parseRow);
    const rootIds = roots.map(r => r.row.id);
    const counts = this.childCounts(rootIds);
    const totals = this.subtreeEntryCounts(rootIds);
    return roots.map(r => ({
      ...this.toNode(
        r,
        counts.get(r.row.id) ?? { visible: 0, hidden: 0 },
        isSecret(this.db, r.row.id),
      ),
      entryCount: totals.get(r.row.id) ?? 1,
    }));
  }

  /**
   * Children of `id` — all of them, in tree order. `id` may be an entry id
   * or a project label.
   *
   * `includeHidden` drops the store's visibility filter so soft-deleted and
   * tombstoned children come back too, flagged rather than merely counted:
   * the viewer exists to explain what the store does, and "42 hidden" is not
   * an answer to which 42.
   */
  children(id: string, options: { includeHidden?: boolean } = {}): ViewerChildren | null {
    const parent = this.readEntry(id);
    if (!parent) return null;

    // Same visibility filter as store.getChildren(), unless asked otherwise.
    const visibility = options.includeHidden === true
      ? ''
      : 'AND irrelevant = 0 AND tombstoned_at IS NULL';
    const rows = this.db.prepare(`
      SELECT ${ENTRY_COLUMNS} FROM entries
      WHERE parent_id = ?
        ${visibility}
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

  /**
   * Build a bounded, breadth-first graph from this read-only database handle.
   * Filtered conversation nodes remain traversable so their non-session
   * descendants can still appear in the graph.
   */
  graph(rootId: string, options: ViewerGraphOptions = {}): ViewerGraph | null {
    const root = this.readEntry(rootId);
    if (!root) return null;

    const includeHidden = options.includeHidden === true;
    if (!includeHidden && (root.row.irrelevant === 1 || root.row.tombstoned_at !== null)) {
      return null;
    }

    const limit = Math.max(1, Math.min(5000, Math.floor(options.limit ?? 1500)));
    const depthLimit = options.depth === undefined ? Number.POSITIVE_INFINITY : options.depth;
    const candidates: Array<{ entry: ParsedEntry; depth: number; secret: boolean }> = [];
    const visited = new Set<string>([root.row.id]);
    const rootSecret = isSecret(this.db, root.row.id);

    type FrontierEntry = { entry: ParsedEntry; depth: number; secret: boolean };
    let frontier: FrontierEntry[] = [{ entry: root, depth: 0, secret: rootSecret }];
    const addCandidate = (item: FrontierEntry): void => {
      const kind = metaString(item.entry, 'kind');
      if (options.includeSessions === true || !isGraphSessionKind(kind)) {
        candidates.push(item);
      }
    };
    addCandidate(frontier[0]);

    const visibility = includeHidden ? '' : 'AND irrelevant = 0 AND tombstoned_at IS NULL';
    while (frontier.length > 0) {
      const parents = frontier.filter(item => item.depth < depthLimit);
      if (!parents.length) break;
      const rowsByParent = new Map<string, ParsedEntry[]>();
      for (let i = 0; i < parents.length; i += 400) {
        const chunk = parents.slice(i, i + 400);
        const ids = chunk.map(item => item.entry.row.id);
        const placeholders = ids.map(() => '?').join(',');
        const rows = this.db.prepare(`
          SELECT ${ENTRY_COLUMNS} FROM entries
          WHERE parent_id IN (${placeholders}) ${visibility}
        `).all(...ids) as EntryRow[];
        for (const row of rows) {
          const list = rowsByParent.get(row.parent_id ?? '') ?? [];
          list.push(parseRow(row));
          rowsByParent.set(row.parent_id ?? '', list);
        }
      }

      const next: FrontierEntry[] = [];
      for (const parent of parents) {
        const parentId = parent.entry.row.id;
        const ordered = sortChildren(rowsByParent.get(parentId) ?? []);
        for (const entry of ordered) {
          if (visited.has(entry.row.id)) continue;
          visited.add(entry.row.id);
          const secret = parent.secret || entryIsSecret(entry);
          const child = { entry, depth: parent.depth + 1, secret };
          addCandidate(child);
          next.push(child);
        }
      }
      frontier = next;
    }

    const candidateIds = new Set(candidates.map(item => item.entry.row.id));
    const edgeById = new Map<string, {
      id: string;
      source_id: string;
      target_id: string;
      type: string;
      weight: number | null;
    }>();
    const candidateIdList = Array.from(candidateIds);
    for (let i = 0; i < candidateIdList.length; i += 400) {
      const ids = candidateIdList.slice(i, i + 400);
      const placeholders = ids.map(() => '?').join(',');
      const rows = this.db.prepare(`
        SELECT id, source_id, target_id, type, weight FROM edges
        WHERE source_id IN (${placeholders}) OR target_id IN (${placeholders})
        ORDER BY id
      `).all(...ids, ...ids) as Array<{
        id: string;
        source_id: string;
        target_id: string;
        type: string;
        weight: number | null;
      }>;
      for (const row of rows) edgeById.set(row.id, row);
    }
    const relationEdges = Array.from(edgeById.values()).sort((a, b) => a.id.localeCompare(b.id));

    const externalEntries = new Map<string, ParsedEntry | null>();
    const ghostAllowed = (id: string): boolean => {
      const allowed = (entry: ParsedEntry | null): boolean => {
        if (!entry) return true;
        if (!includeHidden && (entry.row.irrelevant === 1 || entry.row.tombstoned_at !== null)) return false;
        if (options.includeSessions !== true && isGraphSessionKind(metaString(entry, 'kind'))) return false;
        return true;
      };
      if (externalEntries.has(id)) {
        return allowed(externalEntries.get(id) ?? null);
      }
      const entry = this.readEntry(id);
      externalEntries.set(id, entry);
      return allowed(entry);
    };

    const allTags = new Set<string>();
    for (const item of candidates) {
      if (item.secret && !this.showSecrets) continue;
      for (const tag of item.entry.tags) if (typeof tag === 'string') allTags.add(tag);
    }

    const allGhosts = new Set<string>();
    if (options.includeCrossLinks === true) {
      for (const edge of relationEdges) {
        const sourceInside = candidateIds.has(edge.source_id);
        const targetInside = candidateIds.has(edge.target_id);
        if (sourceInside !== targetInside) {
          const outside = sourceInside ? edge.target_id : edge.source_id;
          if (ghostAllowed(outside)) allGhosts.add(outside);
        }
      }
    }

    const total = candidates.length +
      (options.includeTags === true ? allTags.size : 0) + allGhosts.size;
    let selected = candidates.slice(0, limit);

    const extrasFor = (items: typeof candidates): { tags: string[]; ghosts: string[] } => {
      const ids = new Set(items.map(item => item.entry.row.id));
      const tagSet = new Set<string>();
      if (options.includeTags === true) {
        for (const item of items) {
          if (item.secret && !this.showSecrets) continue;
          for (const tag of item.entry.tags) if (typeof tag === 'string') tagSet.add(tag);
        }
      }
      const ghostSet = new Set<string>();
      if (options.includeCrossLinks === true) {
        for (const edge of relationEdges) {
          const sourceInside = ids.has(edge.source_id);
          const targetInside = ids.has(edge.target_id);
          if (sourceInside === targetInside) continue;
          const outside = sourceInside ? edge.target_id : edge.source_id;
          if (ghostAllowed(outside)) ghostSet.add(outside);
        }
      }
      return { tags: Array.from(tagSet).sort(), ghosts: Array.from(ghostSet).sort() };
    };

    let extras = extrasFor(selected);
    while (selected.length > 1 && selected.length + extras.tags.length + extras.ghosts.length > limit) {
      selected = selected.slice(0, -1);
      extras = extrasFor(selected);
    }
    // If root alone plus optional nodes exceeds a very small requested cap,
    // preserve root, then keep tags before external ghosts.
    const extraCapacity = Math.max(0, limit - selected.length);
    const selectedTags = extras.tags.slice(0, extraCapacity);
    const selectedGhosts = extras.ghosts.slice(0, Math.max(0, extraCapacity - selectedTags.length));

    const counts = this.childCounts([
      ...selected.map(item => item.entry.row.id),
      ...selectedGhosts.filter(id => externalEntries.get(id)),
    ]);
    const nodes: ViewerGraphNode[] = [];
    const nodeById = new Map<string, ViewerGraphNode>();
    const addEntryNode = (
      item: { entry: ParsedEntry; depth: number; secret: boolean },
      external = false,
    ): ViewerGraphNode => {
      const count = counts.get(item.entry.row.id) ?? { visible: 0, hidden: 0 };
      const base = this.toNode(item.entry, count, item.secret);
      const node: ViewerGraphNode = {
        id: base.id,
        title: base.title,
        kind: base.kind,
        type: base.type,
        label: base.label,
        taskStatus: base.taskStatus,
        tags: base.tags,
        childCount: base.childCount,
        degree: 0,
        depth: external ? null : item.depth,
        secret: base.secret,
        redacted: base.redacted,
      };
      const priority = base.redacted ? null : graphPriority(item.entry.metadata);
      if (priority !== null) node.priority = priority;
      if (external) node.external = true;
      if (base.hidden) node.hidden = true;
      return node;
    };

    for (const item of selected) {
      const node = addEntryNode(item);
      nodes.push(node);
      nodeById.set(node.id, node);
    }

    for (const tag of selectedTags) {
      const node: ViewerGraphNode = {
        id: `tag:${tag}`,
        title: tag,
        kind: 'tag',
        type: 'tag',
        label: null,
        taskStatus: null,
        tags: [],
        childCount: 0,
        degree: 0,
        depth: null,
        secret: false,
        redacted: false,
      };
      nodes.push(node);
      nodeById.set(node.id, node);
    }

    for (const id of selectedGhosts) {
      const entry = externalEntries.get(id) ?? null;
      let node: ViewerGraphNode;
      if (entry) {
        const secret = isSecret(this.db, id);
        node = addEntryNode({ entry, depth: 0, secret }, true);
      } else {
        node = {
          id,
          title: 'Outside subtree',
          kind: null,
          type: null,
          label: null,
          taskStatus: null,
          tags: [],
          childCount: 0,
          degree: 0,
          depth: null,
          secret: false,
          redacted: false,
          external: true,
        };
      }
      nodes.push(node);
      nodeById.set(node.id, node);
    }

    const links: ViewerGraphLink[] = [];
    const addLink = (source: string, target: string, type: string, weight: number): void => {
      if (!nodeById.has(source) || !nodeById.has(target)) return;
      links.push({ source, target, type, weight });
      nodeById.get(source)!.degree += 1;
      nodeById.get(target)!.degree += 1;
    };

    const selectedIds = new Set(selected.map(item => item.entry.row.id));
    for (const item of selected) {
      const parentId = item.entry.row.parent_id;
      if (parentId && selectedIds.has(parentId)) addLink(parentId, item.entry.row.id, 'child', 1);
    }
    for (const edge of relationEdges) {
      const sourceInside = selectedIds.has(edge.source_id);
      const targetInside = selectedIds.has(edge.target_id);
      if (sourceInside && targetInside) {
        addLink(edge.source_id, edge.target_id, edge.type, edge.weight ?? 1);
      } else if (options.includeCrossLinks === true && sourceInside !== targetInside) {
        const outside = sourceInside ? edge.target_id : edge.source_id;
        if (selectedGhosts.includes(outside)) {
          addLink(edge.source_id, edge.target_id, edge.type, edge.weight ?? 1);
        }
      }
    }
    for (const item of selected) {
      const node = nodeById.get(item.entry.row.id)!;
      for (const tag of new Set(node.tags)) addLink(node.id, `tag:${tag}`, 'tag', 1);
    }

    return {
      root: root.row.id,
      nodes,
      links,
      truncated: nodes.length < total,
      total,
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
