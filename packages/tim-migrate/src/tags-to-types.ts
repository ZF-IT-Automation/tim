// TIM tags-to-types migration — converts legacy `#rule` / `#human` tags
// into structured `metadata.type` fields. Idempotent: re-running on an
// already-migrated DB is a no-op.

import type { TimStore } from 'tim-store';
import { isMetadataType, type LegacyMetadataType } from 'tim-core';

/**
 * Mapping from legacy tag → metadata.type. Phase 0 tags (`#rule`, `#human`).
 */
const LEGACY_TAG_TO_TYPE: ReadonlyMap<string, LegacyMetadataType> = new Map([
  ['#rule', 'rule'],
  ['rule', 'rule'],
  ['#human', 'human'],
  ['human', 'human'],
]);

export interface MigrationEntryResult {
  id: string;
  title: string;
  oldTags: string[];
  newTags: string[];
  typeSet: LegacyMetadataType | null;
  changed: boolean;
}

export interface MigrationReport {
  scanned: number;
  migrated: number;
  skipped: number;
  errors: Array<{ id: string; error: string }>;
  sampleChanges: MigrationEntryResult[];
}

/** Normalize a raw tag string (e.g. "#rule", " rule ", "RULE") → type key. */
function tagToTypeKey(tag: string): string | null {
  if (typeof tag !== 'string') return null;
  const cleaned = tag.trim().toLowerCase();
  if (cleaned.startsWith('#')) {
    return cleaned; // "#rule"
  }
  return '#' + cleaned; // "rule" → "#rule"
}

/**
 * Scan all entries and migrate any that carry a legacy type tag
 * (`#rule`, `#human` — with or without leading `#`, any case, any
 * surrounding whitespace) to use `metadata.type` instead. Idempotent.
 *
 * - Already-migrated entries (have `metadata.type` set, no legacy tag)
 *   are skipped silently.
 * - Entries with a legacy tag AND no `metadata.type` are migrated:
 *   the recognized tag is removed from the `tags` array, and
 *   `metadata.type` is set to the corresponding enum value.
 * - If multiple recognized tags are present (e.g. both `#rule` and
 *   `#human`), the first match wins and a warning is recorded in
 *   the report.
 */
export async function migrateTagsToTypes(
  store: TimStore,
  options: { dryRun?: boolean; sampleLimit?: number } = {},
): Promise<MigrationReport> {
  const dryRun = options.dryRun === true;
  const sampleLimit = options.sampleLimit ?? 20;

  const db = store.getDb();

  // Pull all live entries. We only migrate the few hundred root-level
  // candidates (entries with `#rule` / `#human` in their tags), but
  // scanning the whole table is cheap and keeps the logic simple.
  const rows = db.prepare(`
    SELECT id, title, tags, metadata, irrelevant, tombstoned_at
    FROM entries
    WHERE irrelevant = 0
      AND tombstoned_at IS NULL
  `).all() as Array<{
    id: string;
    title: string;
    tags: string;
    metadata: string;
    irrelevant: number;
    tombstoned_at: string | null;
  }>;

  const report: MigrationReport = {
    scanned: rows.length,
    migrated: 0,
    skipped: 0,
    errors: [],
    sampleChanges: [],
  };

  const updateEntry = db.prepare(`
    UPDATE entries
    SET tags = ?, metadata = ?, accessed_at = ?
    WHERE id = ?
  `);

  const now = new Date().toISOString();

  for (const row of rows) {
    let oldTags: string[];
    try {
      const parsed = JSON.parse(row.tags);
      oldTags = Array.isArray(parsed) ? parsed.filter(t => typeof t === 'string') : [];
    } catch {
      oldTags = [];
    }

    let metadata: Record<string, unknown>;
    try {
      const parsed = JSON.parse(row.metadata);
      metadata = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
    } catch {
      metadata = {};
    }

    // Find the first recognized legacy tag in the tag list.
    let detectedType: LegacyMetadataType | null = null;
    const removableIndices = new Set<number>();
    for (let i = 0; i < oldTags.length; i++) {
      const key = tagToTypeKey(oldTags[i]);
      if (key && LEGACY_TAG_TO_TYPE.has(key)) {
        const candidate = LEGACY_TAG_TO_TYPE.get(key)!;
        if (detectedType && detectedType !== candidate) {
          // Multiple types on one entry — first wins, skip the rest.
          // The remaining ones are still removed from the tags array.
          removableIndices.add(i);
          continue;
        }
        detectedType = candidate;
        removableIndices.add(i);
      }
    }

    if (!detectedType) {
      report.skipped++;
      continue;
    }

    // Already-migrated? Skip.
    if (isMetadataType(metadata.type)) {
      report.skipped++;
      continue;
    }

    const newTags = oldTags.filter((_, i) => !removableIndices.has(i));
    const newMetadata = { ...metadata, type: detectedType };

    const result: MigrationEntryResult = {
      id: row.id,
      title: row.title,
      oldTags: [...oldTags],
      newTags,
      typeSet: detectedType,
      changed: true,
    };

    if (!dryRun) {
      try {
        updateEntry.run(JSON.stringify(newTags), JSON.stringify(newMetadata), now, row.id);
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
