import type { TimStore } from 'tim-store';

const DEFAULT_TIMEOUT_MS = 500;
const MAX_LINES = 5;

export interface DeltaBriefingOptions {
  timeoutMs?: number;
  sessionId?: string;
}

function formatDeltaBlock(delta: {
  created: { title: string; metadata: Record<string, unknown> }[];
  updated: { title: string; metadata: Record<string, unknown> }[];
  deleted: { title: string; metadata: Record<string, unknown> }[];
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

async function computeDeltaBriefing(
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

  const delta = await store.getChangedSince(projEntry.id, cutoff);
  const total = delta.created.length + delta.updated.length + delta.deleted.length;
  if (total === 0) return null;

  return formatDeltaBlock(delta);
}

/**
 * Short delta block for SessionStart briefing. Returns null when nothing
 * changed or on timeout/error — never throws.
 */
export async function getDeltaBriefing(
  store: TimStore,
  projectId: string,
  opts: DeltaBriefingOptions = {},
): Promise<string | null> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  try {
    const result = await Promise.race([
      computeDeltaBriefing(store, projectId, opts.sessionId),
      new Promise<null>(resolve => setTimeout(() => resolve(null), timeoutMs)),
    ]);
    return result;
  } catch {
    return null;
  }
}
