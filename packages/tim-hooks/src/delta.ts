import type { Entry } from 'tim-core';
import type { TimStore } from 'tim-store';

const DEFAULT_TIMEOUT_MS = 500;
const MAX_LINES = 5;

const DELTA_EXCLUDE_KINDS = new Set([
  'session',
  'exchange',
  'exchanges',
  'exchanges-root',
  'exchange-batch',
  'batch',
  'batch-summary',
  'session-summary',
  'session-summary-root',
  'checkpoint',
  'summary-root',
  'sessions-root',
  'commits-root',
]);

const DELTA_EXCLUDE_TAGS = new Set([
  'session',
  'exchange',
  'exchanges',
  'batch',
  'batch-summary',
  'session-summary',
  'checkpoint',
  'summary-root',
]);

export interface DeltaBriefingOptions {
  timeoutMs?: number;
  sessionId?: string;
}

function isExcludedKindOrTag(entry: { title: string; metadata: Record<string, unknown>; tags?: string[] }): boolean {
  const kind = typeof entry.metadata.kind === 'string' ? entry.metadata.kind : '';
  if (kind && DELTA_EXCLUDE_KINDS.has(kind)) return true;
  for (const tag of entry.tags ?? []) {
    const normalized = tag.replace(/^#/, '').toLowerCase();
    if (DELTA_EXCLUDE_TAGS.has(normalized)) return true;
  }
  return false;
}

async function isUnderSessionsOrCommitsRoot(store: TimStore, entry: Entry): Promise<boolean> {
  let parentId = entry.parentId;
  while (parentId) {
    const parent = await store.read(parentId, { includeChildren: false });
    if (!parent) break;
    const kind = String(parent.metadata.kind ?? '');
    if (kind === 'sessions-root' || kind === 'commits-root') return true;
    parentId = parent.parentId;
  }
  return false;
}

/** True when an entry is session/bookkeeping noise, not project news (G7). */
export async function isDeltaBookkeepingEntry(store: TimStore, entry: Entry): Promise<boolean> {
  if (isExcludedKindOrTag(entry)) return true;
  return isUnderSessionsOrCommitsRoot(store, entry);
}

async function filterDeltaEntries(
  store: TimStore,
  entries: Entry[],
): Promise<Entry[]> {
  const out: Entry[] = [];
  for (const entry of entries) {
    if (!(await isDeltaBookkeepingEntry(store, entry))) out.push(entry);
  }
  return out;
}

function formatDeltaBlock(delta: {
  created: { title: string; metadata: Record<string, unknown>; tags?: string[] }[];
  updated: { title: string; metadata: Record<string, unknown>; tags?: string[] }[];
  deleted: { title: string; metadata: Record<string, unknown>; tags?: string[] }[];
}): string {
  const lines: string[] = [
    `[Since last session] ${delta.created.length} new, ${delta.updated.length} updated, ${delta.deleted.length} deleted`,
  ];

  const highlights = [...delta.created, ...delta.updated, ...delta.deleted]
    .slice(0, MAX_LINES - 1)
    .map(e => {
      const kind = typeof e.metadata.kind === 'string' ? e.metadata.kind : 'entry';
      const title = e.title?.trim() || kind;
      return `• ${title}`;
    });

  lines.push(...highlights);
  return lines.slice(0, MAX_LINES).join('\n');
}

export async function computeDeltaBriefing(
  store: TimStore,
  projectId: string,
  sessionId?: string,
): Promise<string | null> {
  const projEntry = await store.read(projectId, { includeChildren: false });
  if (!projEntry || projEntry.metadata.kind !== 'project') return null;

  const prev = await store.getPreviousSession(projEntry.id, sessionId ?? null);
  const cutoff = prev
    ? prev.updatedAt
    : new Date(Date.now() - 7 * 86400_000).toISOString();

  const raw = await store.getChangedSince(projEntry.id, cutoff);
  const created = await filterDeltaEntries(store, raw.created);
  const updated = await filterDeltaEntries(store, raw.updated);
  const deleted = await filterDeltaEntries(store, raw.deleted);
  const total = created.length + updated.length + deleted.length;
  if (total === 0) return null;

  return formatDeltaBlock({ created, updated, deleted });
}

/**
 * Short delta block for SessionStart briefing. Returns null when nothing
 * changed or on timeout/error — never throws.
 */
function raceWithTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    promise.then((v) => { clearTimeout(timer); resolve(v); }, () => { clearTimeout(timer); resolve(null); });
  });
}

export async function getDeltaBriefing(
  store: TimStore,
  projectId: string,
  opts: DeltaBriefingOptions = {},
): Promise<string | null> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  try {
    return await raceWithTimeout(computeDeltaBriefing(store, projectId, opts.sessionId), timeoutMs);
  } catch {
    return null;
  }
}
