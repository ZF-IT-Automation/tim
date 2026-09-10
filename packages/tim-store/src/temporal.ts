/**
 * Store-level temporal validity and supersession (#36).
 */

import type { Entry, TemporalMetadata } from 'tim-core';
import {
  parseIsoTimestamp,
  parseTemporalMetadata,
  temporalEligibilityAt,
  validateSupersessionEffectiveAt,
} from 'tim-core';
import type Database from 'better-sqlite3';

export function resolveSearchAsOf(asOf?: string): Date {
  if (!asOf) return new Date();
  const parsed = parseIsoTimestamp(asOf);
  if (!parsed) {
    throw new Error(`Invalid asOf: timezone-qualified ISO 8601 string required`);
  }
  return parsed;
}

/** SQL fragment for half-open temporal eligibility at `asOf` (lexicographic ISO compare). */
export function buildTemporalEligibilitySql(
  asOfIso: string,
  entryAlias = 'e',
): string {
  const col = `json_extract(${entryAlias}.metadata, '$.temporal')`;
  return ` AND (
    json_extract(${col}, '$.validFrom') IS NULL
    OR json_extract(${col}, '$.validFrom') <= ?
  ) AND (
    json_extract(${col}, '$.validUntil') IS NULL
    OR json_extract(${col}, '$.validUntil') > ?
  ) AND (
    json_extract(${col}, '$.supersededAt') IS NULL
    OR json_extract(${col}, '$.supersededAt') > ?
  )`;
}

export function temporalEligibilityParams(asOfIso: string): [string, string, string] {
  return [asOfIso, asOfIso, asOfIso];
}

export function entryTemporallyEligibleAt(entry: Entry, at: Date): boolean {
  const temporal = parseTemporalMetadata(entry.metadata.temporal);
  return temporalEligibilityAt(temporal, at).eligible;
}

type RowEntry = {
  id: string;
  metadata: string;
};

/** True when following supersedes edges from `fromId` reaches `toId`. */
export function hasSupersedesPath(
  db: Database.Database,
  fromId: string,
  toId: string,
  maxDepth = 32,
): boolean {
  const visited = new Set<string>();
  const queue = [fromId];
  while (queue.length > 0 && visited.size < maxDepth) {
    const current = queue.shift()!;
    if (current === toId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    const rows = db.prepare(
      `SELECT target_id FROM edges WHERE source_id = ? AND type = 'supersedes'`,
    ).all(current) as Array<{ target_id: string }>;
    for (const row of rows) queue.push(row.target_id);
  }
  return false;
}

export interface SupersessionValidationInput {
  db: Database.Database;
  sourceId: string;
  targetId: string;
  effectiveAt: string;
  getProjectLabel: (entryId: string) => string | null;
  readRow: (id: string) => RowEntry | undefined;
}

export function validateSupersessionLink(input: SupersessionValidationInput): string | null {
  const { db, sourceId, targetId, effectiveAt, getProjectLabel, readRow } = input;
  if (sourceId === targetId) return 'supersedes: source and target must differ';

  const effective = validateSupersessionEffectiveAt(effectiveAt);
  if (!effective.ok) return effective.errors.join('; ');

  const sourceRow = readRow(sourceId);
  const targetRow = readRow(targetId);
  if (!sourceRow) return `supersedes: source entry not found: ${sourceId}`;
  if (!targetRow) return `supersedes: target entry not found: ${targetId}`;

  const sourceProject = getProjectLabel(sourceId);
  const targetProject = getProjectLabel(targetId);
  if (!sourceProject || !targetProject || sourceProject !== targetProject) {
    return 'supersedes: source and target must belong to the same project';
  }

  if (hasSupersedesPath(db, targetId, sourceId)) {
    return 'supersedes: would create a cycle in the supersession chain';
  }

  const targetMeta = JSON.parse(targetRow.metadata) as Record<string, unknown>;
  const targetTemporal = parseTemporalMetadata(targetMeta.temporal);
  const effectiveDate = parseIsoTimestamp(effectiveAt)!;

  if (targetTemporal?.validFrom) {
    const from = parseIsoTimestamp(targetTemporal.validFrom);
    if (from && effectiveDate < from) {
      return 'supersedes: effectiveAt is before target validFrom';
    }
  }
  if (targetTemporal?.validUntil) {
    const until = parseIsoTimestamp(targetTemporal.validUntil);
    if (until && effectiveDate >= until) {
      return 'supersedes: effectiveAt is at or after target validUntil';
    }
  }
  if (targetTemporal?.supersededAt) {
    const existing = parseIsoTimestamp(targetTemporal.supersededAt);
    if (existing && effectiveDate >= existing) {
      return 'supersedes: target is already superseded at or before effectiveAt';
    }
  }

  const sourceMeta = JSON.parse(sourceRow.metadata) as Record<string, unknown>;
  const sourceTemporal = parseTemporalMetadata(sourceMeta.temporal);
  if (sourceTemporal?.validUntil) {
    const until = parseIsoTimestamp(sourceTemporal.validUntil);
    if (until && effectiveDate >= until) {
      return 'supersedes: effectiveAt is at or after source validUntil';
    }
  }

  return null;
}

export function buildSupersessionTargetPatch(
  existingMetadata: Record<string, unknown>,
  sourceId: string,
  effectiveAt: string,
): Record<string, unknown> {
  const existingTemporal = parseTemporalMetadata(existingMetadata.temporal) ?? {};
  const validUntil = existingTemporal.validUntil
    ? (() => {
        const current = parseIsoTimestamp(existingTemporal.validUntil!)!;
        const effective = parseIsoTimestamp(effectiveAt)!;
        return effective < current ? effectiveAt : existingTemporal.validUntil;
      })()
    : effectiveAt;

  const temporal: TemporalMetadata = {
    ...existingTemporal,
    validUntil,
    supersededAt: effectiveAt,
    supersededBy: sourceId,
  };

  return {
    ...existingMetadata,
    temporal,
  };
}

export function buildSupersessionSourcePatch(
  existingMetadata: Record<string, unknown>,
  effectiveAt: string,
): Record<string, unknown> {
  const existingTemporal = parseTemporalMetadata(existingMetadata.temporal) ?? {};
  const temporal: TemporalMetadata = {
    ...existingTemporal,
    validFrom: existingTemporal.validFrom ?? effectiveAt,
  };
  return {
    ...existingMetadata,
    temporal,
  };
}
