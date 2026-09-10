import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { SCHEMA_KINDS, entrySearchStatusSql } from 'tim-core';

/** Text slice embedded by hooks and query encoding (device-local contract). */
export function embeddingText(title: string, content: string): string {
  return `${title}\n${content}`.slice(0, 2000);
}

/** Fingerprint of indexed meaning — invalid when title/body changes (#33 validity seam). */
export function vectorContentFingerprint(title: string, content: string): string {
  return createHash('sha256').update(title).update('\0').update(content).digest('hex').slice(0, 32);
}

export function assertValidVector(vector: Float32Array, expectedDimension: number): void {
  if (vector.length !== expectedDimension) {
    throw new Error(
      `vector dimension mismatch: expected ${expectedDimension}, got ${vector.length}`,
    );
  }
  for (let i = 0; i < vector.length; i++) {
    if (!Number.isFinite(vector[i])) {
      throw new Error(`vector contains non-finite value at index ${i}`);
    }
  }
}

/** Drop device-local vector row — content/title/import/sync changed meaning. */
export function invalidateEntryVector(db: Database.Database, entryId: string): void {
  db.prepare('DELETE FROM entry_vectors WHERE entry_id = ?').run(entryId);
}

export function isUnrestrictedProjectScope(project?: string): boolean {
  return !project || project === '' || project.toLowerCase() === 'all';
}

export interface SearchEligibilityFilters {
  project?: string;
  scopeRootId?: string;
  type?: string;
  tag?: string;
  status?: string;
  confidenceAbove?: number;
  visibilityMask?: number;
}

/**
 * Shared SQL fragment + params for scoped retrieval eligibility (#32 + #33).
 * Applies project subtree, type, tag, status, confidence, visibility BEFORE limits.
 */
export function buildSearchEligibilitySql(
  filters: SearchEligibilityFilters,
  params: unknown[],
  entryAlias = 'e',
): string {
  let sql = '';
  if (filters.scopeRootId) {
    sql += ` AND ${entryAlias}.id IN (
      WITH RECURSIVE tree(id) AS (
        SELECT id FROM entries WHERE id = ?
        UNION ALL
        SELECT c.id FROM entries c
        INNER JOIN tree t ON c.parent_id = t.id
        WHERE c.tombstoned_at IS NULL
      )
      SELECT id FROM tree
    )`;
    params.push(filters.scopeRootId);
  }
  const kindHoles = [...SCHEMA_KINDS].map(() => '?').join(', ');
  sql += ` AND (json_extract(${entryAlias}.metadata, '$.kind') IS NULL
             OR json_extract(${entryAlias}.metadata, '$.kind') NOT IN (${kindHoles}))`;
  params.push(...SCHEMA_KINDS);
  if (filters.type) {
    sql += ` AND json_extract(${entryAlias}.metadata, '$.type') = ?`;
    params.push(filters.type);
  }
  if (filters.tag) {
    const needle = filters.tag.startsWith('#') ? filters.tag : `#${filters.tag}`;
    const rawTag = filters.tag.startsWith('#') ? filters.tag.slice(1) : filters.tag;
    sql += ` AND EXISTS (
      SELECT 1 FROM json_each(${entryAlias}.tags) je
      WHERE je.value = ? OR je.value = ?
    )`;
    params.push(needle, rawTag);
  }
  if (filters.status) {
    sql += ` AND (${entrySearchStatusSql(`${entryAlias}.metadata`)}) = ?`;
    params.push(filters.status);
  }
  if (filters.confidenceAbove !== undefined) {
    sql += ` AND ${entryAlias}.confidence >= ?`;
    params.push(filters.confidenceAbove);
  }
  if (filters.visibilityMask !== undefined) {
    sql += ` AND (${entryAlias}.visibility & ?) != 0`;
    params.push(filters.visibilityMask);
  }
  return sql;
}

export interface SemanticIndexHealthReport {
  providerState: 'enabled' | 'disabled' | 'unavailable' | 'unknown';
  configuredModel: string | null;
  supportedModel: boolean;
  vectorCount: number;
  unembeddedCount: number;
  staleVectorCount: number;
  wrongModelCount: number;
}

/**
 * Non-generating index health for #37 — counts only, never loads a model.
 * Absence of vectors is not reported as success when provider is enabled.
 */
export function querySemanticIndexHealth(
  db: Database.Database,
  configuredModel: string | null,
  providerState: 'enabled' | 'disabled' | 'unavailable' | 'unknown',
  supportedModel: boolean,
): SemanticIndexHealthReport {
  const scopesKinds = [...SCHEMA_KINDS].map(() => '?').join(', ');
  const baseEligible = `
    e.tombstoned_at IS NULL AND e.irrelevant = 0
    AND (json_extract(e.metadata, '$.kind') IS NULL
         OR json_extract(e.metadata, '$.kind') NOT IN (${scopesKinds}))`;

  const vectorCount = (
    db.prepare(`SELECT COUNT(*) AS c FROM entry_vectors`).get() as { c: number }
  ).c;

  const unembeddedCount = configuredModel === null
    ? 0
    : (
      db.prepare(`
        SELECT COUNT(*) AS c FROM entries e
        LEFT JOIN entry_vectors v ON v.entry_id = e.id
        WHERE ${baseEligible}
          AND (v.entry_id IS NULL OR v.model != ?)
      `).get(...SCHEMA_KINDS, configuredModel) as { c: number }
    ).c;

  const wrongModelCount = configuredModel === null
    ? 0
    : (
      db.prepare(`
        SELECT COUNT(*) AS c FROM entry_vectors v
        INNER JOIN entries e ON e.id = v.entry_id
        WHERE v.model != ? AND ${baseEligible}
      `).get(configuredModel, ...SCHEMA_KINDS) as { c: number }
    ).c;

  // Stale count requires per-row fingerprint — compute in JS for correctness.
  const staleRows = db.prepare(`
    SELECT e.title, e.content, v.content_hash FROM entry_vectors v
    INNER JOIN entries e ON e.id = v.entry_id
    WHERE ${baseEligible}
      AND v.content_hash != ''
  `).all(...SCHEMA_KINDS) as Array<{ title: string; content: string; content_hash: string }>;
  let staleCount = 0;
  for (const row of staleRows) {
    if (row.content_hash !== vectorContentFingerprint(row.title, row.content)) staleCount++;
  }

  return {
    providerState,
    configuredModel,
    supportedModel,
    vectorCount,
    unembeddedCount,
    staleVectorCount: staleCount,
    wrongModelCount,
  };
}
