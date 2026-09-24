// One-off migration: flag legacy harness-only user exchanges with metadata.system_turn.
// Idempotent — re-running on a clean DB is a no-op.

import type { TimStore } from 'tim-store';
import { isHarnessOnlyPrompt } from 'tim-store';

export interface SystemTurnProjectCount {
  projectId: string;
  label: string;
  flagged: number;
}

export interface SystemTurnMigrationReport {
  scanned: number;
  flagged: number;
  skippedAlreadyFlagged: number;
  skippedNotHarness: number;
  byProject: SystemTurnProjectCount[];
  dryRun: boolean;
}

function entryText(title: string, content: string): string {
  const parts = [title.trim(), content.trim()].filter(Boolean);
  return parts.join('\n');
}

function parseMeta(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function resolveProjectLabel(
  db: ReturnType<TimStore['getDb']>,
  sessionId: string | null,
): { projectId: string; label: string } | null {
  if (!sessionId) return null;
  const row = db.prepare(`
    SELECT p.id AS projectId, json_extract(p.metadata, '$.label') AS label
    FROM entries session
    JOIN entries sr ON session.parent_id = sr.id
    JOIN entries p ON sr.parent_id = p.id
    WHERE session.id = ?
      AND json_extract(session.metadata, '$.kind') = 'session'
      AND json_extract(sr.metadata, '$.kind') = 'sessions-root'
      AND json_extract(p.metadata, '$.kind') = 'project'
    LIMIT 1
  `).get(sessionId) as { projectId: string; label: string } | undefined;
  return row ?? null;
}

/**
 * Set metadata.system_turn = true on user exchanges whose stored text is
 * harness-only per isHarnessOnlyPrompt. Content is untouched; nothing deleted.
 */
export async function migrateSystemTurn(
  store: TimStore,
  options: { dryRun?: boolean } = {},
): Promise<SystemTurnMigrationReport> {
  const dryRun = options.dryRun === true;
  const db = store.getDb();

  const rows = db.prepare(`
    SELECT id, title, content, metadata
    FROM entries
    WHERE tombstoned_at IS NULL
      AND irrelevant = 0
      AND json_extract(metadata, '$.kind') = 'exchange'
      AND json_extract(metadata, '$.role') = 'user'
  `).all() as Array<{ id: string; title: string; content: string; metadata: string }>;

  const byProject = new Map<string, SystemTurnProjectCount>();
  let flagged = 0;
  let skippedAlreadyFlagged = 0;
  let skippedNotHarness = 0;

  const toFlag: Array<{ id: string; projectId: string; label: string }> = [];

  for (const row of rows) {
    const meta = parseMeta(row.metadata);
    if (meta.system_turn === true) {
      skippedAlreadyFlagged += 1;
      continue;
    }

    const text = entryText(row.title ?? '', row.content ?? '');
    if (!isHarnessOnlyPrompt(text)) {
      skippedNotHarness += 1;
      continue;
    }

    const sessionId = typeof meta.sessionId === 'string' ? meta.sessionId : null;
    const project = resolveProjectLabel(db, sessionId);
    const projectId = project?.projectId ?? '_unknown';
    const label = project?.label ?? '_unknown';

    toFlag.push({ id: row.id, projectId, label });
  }

  if (!dryRun && toFlag.length > 0) {
    const update = db.prepare(`
      UPDATE entries
      SET metadata = json_set(metadata, '$.system_turn', json('true'))
      WHERE id = ?
        AND json_extract(metadata, '$.system_turn') IS NOT 1
    `);
    store.runExclusive(() => {
      db.transaction(() => {
        for (const row of toFlag) {
          update.run(row.id);
        }
      })();
    });
  }

  for (const row of toFlag) {
    flagged += 1;
    const known = byProject.get(row.projectId);
    if (known) {
      known.flagged += 1;
    } else {
      byProject.set(row.projectId, { projectId: row.projectId, label: row.label, flagged: 1 });
    }
  }

  const byProjectList = [...byProject.values()].sort((a, b) => a.label.localeCompare(b.label));

  return {
    scanned: rows.length,
    flagged,
    skippedAlreadyFlagged,
    skippedNotHarness,
    byProject: byProjectList,
    dryRun,
  };
}
