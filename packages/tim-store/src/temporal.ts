/**
 * Store-level temporal validity and supersession (#36).
 */

import type { Entry, TemporalMetadata } from 'tim-core';
import {
  isoTimestampToEpochMs,
  parseIsoTimestamp,
  parseTemporalMetadata,
  temporalEligibilityAt,
  validateIsoTimestamp,
  validateSupersessionEffectiveAt,
} from 'tim-core';
import type Database from 'better-sqlite3';

/** Safety cap for supersession graph traversal — fail closed instead of returning false. */
export const SUPERSESSION_GRAPH_LIMIT = 10_000;

export function registerTemporalSqlFunctions(db: Database.Database): void {
  db.function('tim_iso_to_epoch_ms', (iso: unknown) => {
    if (typeof iso !== 'string' || iso.length === 0) return null;
    const epochMs = isoTimestampToEpochMs(iso);
    return epochMs ?? null;
  });
}

export function resolveSearchAsOf(asOf?: string): Date {
  if (!asOf) return new Date();
  const parsed = validateIsoTimestamp(asOf);
  if (!parsed.ok) {
    throw new Error(`Invalid asOf: ${parsed.reason}`);
  }
  return new Date(parsed.epochMs);
}

/** SQL fragment for half-open temporal eligibility at `asOf` (epoch-ms compare). */
export function buildTemporalEligibilitySql(
  asOfEpochMs: number,
  entryAlias = 'e',
): string {
  const col = `json_extract(${entryAlias}.metadata, '$.temporal')`;
  return ` AND (
    json_extract(${col}, '$.validFrom') IS NULL
    OR tim_iso_to_epoch_ms(json_extract(${col}, '$.validFrom')) <= ?
  ) AND (
    json_extract(${col}, '$.validUntil') IS NULL
    OR tim_iso_to_epoch_ms(json_extract(${col}, '$.validUntil')) > ?
  ) AND (
    json_extract(${col}, '$.supersededAt') IS NULL
    OR tim_iso_to_epoch_ms(json_extract(${col}, '$.supersededAt')) > ?
  )`;
}

export function temporalEligibilityParams(asOfEpochMs: number): [number, number, number] {
  return [asOfEpochMs, asOfEpochMs, asOfEpochMs];
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
): boolean {
  const visited = new Set<string>();
  const queue = [fromId];
  while (queue.length > 0) {
    if (visited.size > SUPERSESSION_GRAPH_LIMIT) {
      throw new Error('supersedes: supersession graph exceeds safety limit');
    }
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

  try {
    if (hasSupersedesPath(db, targetId, sourceId)) {
      return 'supersedes: would create a cycle in the supersession chain';
    }
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }

  const normalizedEffectiveAt = validateIsoTimestamp(effectiveAt);
  if (!normalizedEffectiveAt.ok) return `effectiveAt: ${normalizedEffectiveAt.reason}`;
  const effectiveDate = new Date(normalizedEffectiveAt.epochMs);

  const targetMeta = JSON.parse(targetRow.metadata) as Record<string, unknown>;
  const targetTemporal = parseTemporalMetadata(targetMeta.temporal);

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
    if (
      targetTemporal.supersededBy
      && targetTemporal.supersededBy !== sourceId
      && existing
      && effectiveDate < existing
    ) {
      return 'supersedes: target already has an incompatible supersession at a later effective date';
    }
  }

  const sourceMeta = JSON.parse(sourceRow.metadata) as Record<string, unknown>;
  const sourceTemporal = parseTemporalMetadata(sourceMeta.temporal);
  const sourceEligibility = temporalEligibilityAt(sourceTemporal, effectiveDate);
  if (!sourceEligibility.eligible) {
    return `supersedes: replacement is not valid at effectiveAt (${sourceEligibility.state})`;
  }
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
  const normalizedEffective = normalizeSupersessionTimestamp(effectiveAt);
  const validUntil = existingTemporal.validUntil
    ? (() => {
        const current = parseIsoTimestamp(existingTemporal.validUntil!)!;
        const effective = parseIsoTimestamp(normalizedEffective)!;
        return effective < current ? normalizedEffective : existingTemporal.validUntil;
      })()
    : normalizedEffective;

  const temporal: TemporalMetadata = {
    ...existingTemporal,
    validUntil,
    supersededAt: normalizedEffective,
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
  const normalizedEffective = normalizeSupersessionTimestamp(effectiveAt);
  const temporal: TemporalMetadata = {
    ...existingTemporal,
    validFrom: existingTemporal.validFrom ?? normalizedEffective,
  };
  return {
    ...existingMetadata,
    temporal,
  };
}

function normalizeSupersessionTimestamp(value: string): string {
  const validated = validateIsoTimestamp(value);
  if (!validated.ok) {
    throw new Error(`effectiveAt: ${validated.reason}`);
  }
  return validated.normalized;
}
