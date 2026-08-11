// Clean legacy tags off existing rows: the deprecated status and priority tags, plus the
// retired structural ones (#exchange, #session, #sessions, #exchanges, #checkpoint).
//
// The deprecated half is swept along on purpose rather than filtered out — store.update()
// strips those on every write anyway, so a narrower selector would only skip rows, never
// spare a tag. The structural half is the actual point of the migration, and it is
// stripped only here: those words stay legal as content tags afterwards.
//
// The structural half is scoped to session-tree nodes by metadata.kind, and that scoping is
// load-bearing rather than cosmetic: a dry run against the live database found 3303 rows to
// clean, among them entries whose #checkpoint is plainly subject matter (an hmem-era note on
// memory checkpoints, tagged #hmem #haiku #checkpoint #mcp #claude-cli). An unscoped sweep
// would have deleted those. Idempotent: re-running on a clean DB is a no-op.

import { isDeprecatedTag, RETIRED_STRUCTURAL_TAGS } from 'tim-core';
import type { TimStore } from 'tim-store';

// The write path only strips DEPRECATED_TAGS. The retired structural tags are cleaned here
// and nowhere else — a one-time sweep over what the old write sites left behind, not a
// standing ban on the words (see RETIRED_STRUCTURAL_TAGS).
//
// The kinds the session tree writes. Only these ever got stamped with the structural tags,
// and only on these is a structural tag certainly plumbing rather than subject matter.
const SESSION_TREE_KINDS = new Set([
  'sessions-root',
  'session',
  'session-alias',
  'session-summary-root',
  'batch-summary',
  'exchanges-root',
  'exchange-batch',
  'exchange',
  'checkpoint',
]);

function stripRetiredTags(
  tags: string[],
  isSessionTreeNode: boolean,
): { clean: string[]; removed: string[] } {
  const clean: string[] = [];
  const removed: string[] = [];
  for (const tag of tags) {
    const structural = isSessionTreeNode && RETIRED_STRUCTURAL_TAGS.has(tag.toLowerCase());
    if (isDeprecatedTag(tag) || structural) {
      removed.push(tag);
    } else {
      clean.push(tag);
    }
  }
  return { clean, removed };
}

export interface RetireDeprecatedTagsEntryResult {
  id: string;
  title: string;
  oldTags: string[];
  newTags: string[];
  removed: string[];
  changed: boolean;
}

export interface RetireDeprecatedTagsReport {
  scanned: number;
  migrated: number;
  skipped: number;
  errors: Array<{ id: string; error: string }>;
  sampleChanges: RetireDeprecatedTagsEntryResult[];
}

/**
 * Scan live entries and strip every deprecated tag via store.update (staging/LWW).
 * Explicit opt-in: `tim migrate retire-deprecated-tags`.
 */
export async function migrateRetireDeprecatedTags(
  store: TimStore,
  options: { dryRun?: boolean; sampleLimit?: number } = {},
): Promise<RetireDeprecatedTagsReport> {
  const dryRun = options.dryRun === true;
  const sampleLimit = options.sampleLimit ?? 20;
  const db = store.getDb();

  const rows = db.prepare(`
    SELECT id, title, tags, metadata
    FROM entries
    WHERE irrelevant = 0
      AND tombstoned_at IS NULL
  `).all() as Array<{ id: string; title: string; tags: string; metadata: string }>;

  const report: RetireDeprecatedTagsReport = {
    scanned: rows.length,
    migrated: 0,
    skipped: 0,
    errors: [],
    sampleChanges: [],
  };

  for (const row of rows) {
    let oldTags: string[];
    try {
      const parsed = JSON.parse(row.tags);
      oldTags = Array.isArray(parsed) ? parsed.filter(t => typeof t === 'string') : [];
    } catch {
      oldTags = [];
    }

    let kind: unknown;
    try {
      kind = (JSON.parse(row.metadata) as { kind?: unknown })?.kind;
    } catch {
      kind = undefined;
    }
    const isSessionTreeNode = typeof kind === 'string' && SESSION_TREE_KINDS.has(kind);

    const { clean, removed } = stripRetiredTags(oldTags, isSessionTreeNode);
    if (removed.length === 0) {
      report.skipped++;
      continue;
    }

    const result: RetireDeprecatedTagsEntryResult = {
      id: row.id,
      title: row.title,
      oldTags: [...oldTags],
      newTags: clean,
      removed,
      changed: true,
    };

    if (!dryRun) {
      try {
        await store.update(row.id, { tags: clean });
        report.migrated++;
        if (report.sampleChanges.length < sampleLimit) {
          report.sampleChanges.push(result);
        }
      } catch (err) {
        report.errors.push({
          id: row.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } else {
      report.migrated++;
      if (report.sampleChanges.length < sampleLimit) {
        report.sampleChanges.push(result);
      }
    }
  }

  return report;
}
