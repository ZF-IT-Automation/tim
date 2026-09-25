import type { Entry } from 'tim-core';
import type { TimStore } from './store.js';
import {
  KIND_BATCH,
  KIND_EXCHANGE,
  KIND_EXCHANGE_BATCH,
  KIND_EXCHANGES_ROOT,
  KIND_SESSION,
  KIND_SESSIONS_ROOT,
  KIND_SUMMARY_ROOT,
} from './session-tree.js';

/** Sessions younger than this are never empty-reaped. */
export const EMPTY_SESSION_AGE_FLOOR_MS = 24 * 60 * 60 * 1000;

/**
 * Bound deletes on the automatic path. A start that walked a backlog of
 * hundreds of skeletons would stall the hook on tombstone writes.
 */
export const EMPTY_SESSION_REAP_CAP = 50;

export interface ReapedSession {
  sessionId: string;
  projectId: string;
  childCount: number;
}

export interface SuspiciousEmptySession {
  sessionId: string;
  projectId: string;
}

export interface EmptySessionReapResult {
  reaped: ReapedSession[];
  suspicious: SuspiciousEmptySession[];
}

export interface ReapEmptySessionsOptions {
  /** Project labels or ids. Omit to scan every project that has a sessions root. */
  projectIds?: string[];
  /** Harness session that must not be reaped (the one starting or running). */
  currentSessionId?: string;
  /** Report what would be reaped without tombstoning. */
  dryRun?: boolean;
  /**
   * Stop after this many reaps. The manual command leaves it unset and scans
   * every candidate; session start passes {@link EMPTY_SESSION_REAP_CAP}.
   */
  cap?: number;
  now?: Date;
  ageFloorMs?: number;
}

export interface ReapSessionsByIdOptions {
  currentSessionId?: string;
  dryRun?: boolean;
}

export interface ReapByIdRefusal {
  sessionId: string;
  childCount: number;
  reason: 'running' | 'not-a-session';
}

export interface ReapByIdsResult {
  reaped: Array<{ sessionId: string; childCount: number }>;
  refused: ReapByIdRefusal[];
  missing: string[];
}

type Db = ReturnType<TimStore['getDb']>;

interface IdRow {
  id: string;
}

interface SessionListRow {
  id: string;
}

/**
 * One line for the session-start directive. Null when nothing was reaped,
 * so a quiet start stays quiet.
 */
export function formatEmptySessionReapLine(count: number): string | null {
  if (count <= 0) return null;
  return `reaped ${count} empty sessions`;
}

/**
 * Hard-delete (tombstone) a session and every live descendant.
 *
 * `store.delete` does not cascade. Tombstoning the session alone leaves the
 * Summary and Exchanges nodes in place, still parented to an id nothing walks.
 * Children go first. Already-tombstoned ids are skipped, so a second call
 * writes no further staging deletes.
 */
export async function reapSessionSubtree(store: TimStore, sessionId: string): Promise<number> {
  const ids = liveSubtreePostOrder(store.getDb(), sessionId);
  if (ids.length === 0) return 0;
  await store.deleteBatch(ids, true);
  return ids.length - 1;
}

/**
 * Empty-skeleton predicate. Both the session-start path and `tim sessions reap`
 * go through here — there is no looser copy.
 *
 * A session is reaped only when it has no exchange descendants (irrelevant
 * included), an empty Summary with no batch-summary children, no empty
 * exchange-batch that still has a later sibling batch, an empty body and
 * `task_summary`, and it is neither the running session nor the newest
 * session of its project, and it is at least {@link EMPTY_SESSION_AGE_FLOOR_MS} old.
 *
 * An empty batch with a later sibling is reported and kept: that shape means
 * an exchange went missing, not that the session never logged anything.
 */
export async function reapEmptySessions(
  store: TimStore,
  options: ReapEmptySessionsOptions = {},
): Promise<EmptySessionReapResult> {
  const now = options.now ?? new Date();
  const ageFloorMs = options.ageFloorMs ?? EMPTY_SESSION_AGE_FLOOR_MS;
  const currentCanonical = canonicalSessionId(store, options.currentSessionId);
  const projects = await projectsInScope(store, options.projectIds);
  const reaped: ReapedSession[] = [];
  const suspicious: SuspiciousEmptySession[] = [];

  for (const project of projects) {
    if (options.cap !== undefined && reaped.length >= options.cap) break;
    const sessions = listProjectSessions(store.getDb(), project.id);
    const newestId = sessions.length > 0 ? sessions[sessions.length - 1]!.id : null;

    for (const row of sessions) {
      if (options.cap !== undefined && reaped.length >= options.cap) break;
      const session = await store.read(row.id, { showIrrelevant: true });
      if (!session || session.tombstonedAt || session.metadata.kind !== KIND_SESSION) continue;

      const verdict = classifyEmptySession(store.getDb(), session, {
        now,
        ageFloorMs,
        currentCanonical,
        newestId,
      });
      if (verdict.suspicious) {
        suspicious.push({ sessionId: session.id, projectId: project.label });
      }
      if (verdict.action !== 'reap') continue;

      const ids = liveSubtreePostOrder(store.getDb(), session.id);
      const childCount = Math.max(0, ids.length - 1);
      if (!options.dryRun && ids.length > 0) {
        await store.deleteBatch(ids, true);
      }
      reaped.push({ sessionId: session.id, projectId: project.label, childCount });
    }
  }

  return { reaped, suspicious };
}

/**
 * Tombstone the named sessions without the emptiness predicate.
 * The running session is refused. Missing ids are reported, not created.
 */
export async function reapSessionsById(
  store: TimStore,
  sessionIds: string[],
  options: ReapSessionsByIdOptions = {},
): Promise<ReapByIdsResult> {
  const currentCanonical = canonicalSessionId(store, options.currentSessionId);
  const seen = new Set<string>();
  const reaped: Array<{ sessionId: string; childCount: number }> = [];
  const refused: ReapByIdRefusal[] = [];
  const missing: string[] = [];

  for (const raw of sessionIds) {
    const sessionId = raw.trim();
    if (!sessionId || seen.has(sessionId)) continue;
    seen.add(sessionId);

    const entry = await store.read(sessionId, { showIrrelevant: true });
    if (!entry || entry.tombstonedAt) {
      missing.push(sessionId);
      continue;
    }

    const ids = liveSubtreePostOrder(store.getDb(), entry.id);
    const childCount = Math.max(0, ids.length - 1);
    const canonical = store.resolveSessionAlias(entry.id);
    if (currentCanonical && (entry.id === currentCanonical || canonical === currentCanonical)) {
      refused.push({ sessionId: entry.id, childCount, reason: 'running' });
      continue;
    }
    if (entry.metadata.kind !== KIND_SESSION) {
      refused.push({ sessionId: entry.id, childCount, reason: 'not-a-session' });
      continue;
    }

    if (!options.dryRun && ids.length > 0) {
      await store.deleteBatch(ids, true);
    }
    reaped.push({ sessionId: entry.id, childCount });
  }

  return { reaped, refused, missing };
}

interface ClassifyContext {
  now: Date;
  ageFloorMs: number;
  currentCanonical: string | undefined;
  newestId: string | null;
}

function classifyEmptySession(
  db: Db,
  session: Entry,
  ctx: ClassifyContext,
): { action: 'reap' | 'keep'; suspicious: boolean } {
  const suspicious = hasEmptyInteriorBatch(db, session.id);
  if (suspicious) return { action: 'keep', suspicious: true };
  if (countExchangeDescendants(db, session.id) > 0) return { action: 'keep', suspicious: false };
  if (summaryBlocksReap(db, session.id)) return { action: 'keep', suspicious: false };
  if (!textEmpty(session.content)) return { action: 'keep', suspicious: false };
  if (!metadataTextEmpty(session.metadata.task_summary)) return { action: 'keep', suspicious: false };
  if (ctx.currentCanonical && session.id === ctx.currentCanonical) {
    return { action: 'keep', suspicious: false };
  }
  if (ctx.newestId && session.id === ctx.newestId) return { action: 'keep', suspicious: false };
  const createdMs = Date.parse(session.createdAt);
  if (!Number.isFinite(createdMs)) return { action: 'keep', suspicious: false };
  if (ctx.now.getTime() - createdMs < ctx.ageFloorMs) return { action: 'keep', suspicious: false };
  return { action: 'reap', suspicious: false };
}

function textEmpty(value: string | null | undefined): boolean {
  return (value ?? '').trim() === '';
}

function metadataTextEmpty(value: unknown): boolean {
  if (value == null) return true;
  if (typeof value === 'string') return value.trim() === '';
  return false;
}

function canonicalSessionId(store: TimStore, sessionId: string | undefined): string | undefined {
  const trimmed = sessionId?.trim();
  if (!trimmed) return undefined;
  return store.resolveSessionAlias(trimmed);
}

interface ScopedProject {
  id: string;
  label: string;
}

async function projectsInScope(
  store: TimStore,
  projectIds: string[] | undefined,
): Promise<ScopedProject[]> {
  if (projectIds && projectIds.length > 0) {
    const out: ScopedProject[] = [];
    for (const id of projectIds) {
      const project = await store.requireProject(id);
      out.push({ id: project.id, label: projectLabel(project) });
    }
    return out;
  }

  const rows = store.getDb().prepare(`
    SELECT DISTINCT parent_id AS id
    FROM entries
    WHERE json_extract(metadata, '$.kind') = ?
      AND tombstoned_at IS NULL
      AND parent_id IS NOT NULL
    ORDER BY parent_id ASC
  `).all(KIND_SESSIONS_ROOT) as IdRow[];

  const out: ScopedProject[] = [];
  for (const row of rows) {
    const project = await store.read(row.id, { showIrrelevant: true });
    if (!project || project.tombstonedAt) continue;
    out.push({ id: project.id, label: projectLabel(project) });
  }
  out.sort((a, b) => a.label.localeCompare(b.label));
  return out;
}

function projectLabel(project: Entry): string {
  const label = project.metadata.label;
  return typeof label === 'string' && label.trim() ? label : project.id;
}

function listProjectSessions(db: Db, projectId: string): SessionListRow[] {
  return db.prepare(`
    SELECT e.id AS id
    FROM entries e
    INNER JOIN entries root ON e.parent_id = root.id
    WHERE root.parent_id = ?
      AND json_extract(root.metadata, '$.kind') = ?
      AND root.tombstoned_at IS NULL
      AND json_extract(e.metadata, '$.kind') = ?
      AND e.tombstoned_at IS NULL
    ORDER BY e.created_at ASC, e.rowid ASC
  `).all(projectId, KIND_SESSIONS_ROOT, KIND_SESSION) as SessionListRow[];
}

function childrenByKind(db: Db, parentId: string, kind: string): IdRow[] {
  return db.prepare(`
    SELECT id
    FROM entries
    WHERE parent_id = ?
      AND json_extract(metadata, '$.kind') = ?
      AND tombstoned_at IS NULL
    ORDER BY COALESCE(
      CAST(json_extract(metadata, '$.batch_index') AS INTEGER),
      CAST(json_extract(metadata, '$.order') AS INTEGER),
      999999
    ), created_at ASC, rowid ASC
  `).all(parentId, kind) as IdRow[];
}

function countExchangeDescendants(db: Db, rootId: string): number {
  const row = db.prepare(`
    WITH RECURSIVE sub(id) AS (
      SELECT id FROM entries WHERE parent_id = ? AND tombstoned_at IS NULL
      UNION ALL
      SELECT e.id FROM entries e
      INNER JOIN sub ON e.parent_id = sub.id
      WHERE e.tombstoned_at IS NULL
    )
    SELECT COUNT(*) AS n
    FROM entries e
    INNER JOIN sub ON sub.id = e.id
    WHERE json_extract(e.metadata, '$.kind') = ?
  `).get(rootId, KIND_EXCHANGE) as { n: number };
  return row.n;
}

function hasEmptyInteriorBatch(db: Db, sessionId: string): boolean {
  for (const exchanges of childrenByKind(db, sessionId, KIND_EXCHANGES_ROOT)) {
    const batches = childrenByKind(db, exchanges.id, KIND_EXCHANGE_BATCH);
    for (let i = 0; i < batches.length - 1; i++) {
      if (countExchangeDescendants(db, batches[i]!.id) === 0) return true;
    }
  }
  return false;
}

function summaryBlocksReap(db: Db, sessionId: string): boolean {
  const summaries = childrenByKind(db, sessionId, KIND_SUMMARY_ROOT);
  if (summaries.length === 0) return true;
  for (const summary of summaries) {
    const row = db.prepare(
      'SELECT content, metadata FROM entries WHERE id = ?',
    ).get(summary.id) as { content: string | null; metadata: string } | undefined;
    if (!row) return true;
    if (!textEmpty(row.content)) return true;
    let metadata: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(row.metadata) as unknown;
      if (parsed && typeof parsed === 'object') metadata = parsed as Record<string, unknown>;
    } catch {
      return true;
    }
    if (!metadataTextEmpty(metadata.summary)) return true;
    if (childrenByKind(db, summary.id, KIND_BATCH).length > 0) return true;
  }
  return false;
}

/** Deepest descendants first, then the root. Tombstoned rows are omitted. */
function liveSubtreePostOrder(db: Db, rootId: string): string[] {
  const rows = db.prepare(`
    WITH RECURSIVE sub(id, depth) AS (
      SELECT id, 0 FROM entries WHERE id = ? AND tombstoned_at IS NULL
      UNION ALL
      SELECT e.id, sub.depth + 1
      FROM entries e
      INNER JOIN sub ON e.parent_id = sub.id
      WHERE e.tombstoned_at IS NULL
    )
    SELECT id FROM sub ORDER BY depth DESC, id ASC
  `).all(rootId) as IdRow[];
  return rows.map(row => row.id);
}
