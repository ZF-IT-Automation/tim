/**
 * Store-level temporal validity and supersession (#36).
 */

import type { Entry, TemporalMetadata } from 'tim-core';
import {
  isoTimestampToEpochMs,
  parseIsoTimestamp,
  parseTemporalMetadata,
  temporalEligibilityAt,
  validateCallerTemporalMetadata,
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
  if (asOf === undefined) return new Date();
  const parsed = validateIsoTimestamp(asOf);
  if (!parsed.ok) {
    throw new Error(`Invalid asOf: ${parsed.reason}`);
  }
  return new Date(parsed.epochMs);
}

/**
 * SQL fragment for half-open temporal eligibility at `asOf` (epoch-ms compare).
 * Uses path-based json_extract so non-object temporal values never raise; unusable
 * timestamp fields are ignored (fail open), matching parseTemporalMetadata in JS.
 */
export function buildTemporalEligibilitySql(
  asOfEpochMs: number,
  entryAlias = 'e',
): string {
  const fieldPath = (field: string) =>
    `json_extract(${entryAlias}.metadata, '$.temporal.${field}')`;
  const fieldEpoch = (field: string) => `tim_iso_to_epoch_ms(${fieldPath(field)})`;
  const boundOk = (field: string, op: '<=' | '>') => `(
    ${fieldPath(field)} IS NULL
    OR ${fieldEpoch(field)} IS NULL
    OR ${fieldEpoch(field)} ${op} ?
  )`;
  return ` AND (
    ${boundOk('validFrom', '<=')}
    AND ${boundOk('validUntil', '>')}
    AND ${boundOk('supersededAt', '>')}
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

/** Caller validity snapshot stored on supersedes edges for undo. */
export interface SupersessionValiditySnapshot {
  validFrom?: string;
  validUntil?: string;
}

export interface SupersessionEdgeSnapshots {
  priorTarget: SupersessionValiditySnapshot;
  priorSource: SupersessionValiditySnapshot;
}

export function captureSupersessionSnapshots(
  sourceMeta: Record<string, unknown>,
  targetMeta: Record<string, unknown>,
): SupersessionEdgeSnapshots {
  const sourceTemporal = parseTemporalMetadata(sourceMeta.temporal);
  const targetTemporal = parseTemporalMetadata(targetMeta.temporal);
  return {
    priorTarget: {
      ...(targetTemporal?.validFrom !== undefined ? { validFrom: targetTemporal.validFrom } : {}),
      ...(targetTemporal?.validUntil !== undefined ? { validUntil: targetTemporal.validUntil } : {}),
    },
    priorSource: {
      ...(sourceTemporal?.validFrom !== undefined ? { validFrom: sourceTemporal.validFrom } : {}),
    },
  };
}

export interface SupersessionUnlinkInput {
  edgeId: string;
  sourceId: string;
  targetId: string;
  effectiveAt: string;
  snapshots?: SupersessionEdgeSnapshots;
  targetValidity?: SupersessionValiditySnapshot;
  sourceRow: RowEntry;
  targetRow: RowEntry;
  otherSupersedesOnTarget: number;
}

export function validateSupersessionUnlink(input: SupersessionUnlinkInput): string | null {
  const {
    sourceId,
    targetId,
    effectiveAt,
    snapshots,
    targetValidity,
    sourceRow,
    targetRow,
    otherSupersedesOnTarget,
  } = input;

  if (otherSupersedesOnTarget > 0) {
    return 'supersedes undo: dependent supersession edges must be resolved first';
  }

  if (snapshots) {
    for (const snapshot of [snapshots.priorSource, snapshots.priorTarget]) {
      const validated = validateCallerTemporalMetadata(snapshot);
      if (!validated.ok) return `supersedes undo: invalid prior validity snapshot (${validated.errors.join('; ')})`;
    }
    if (targetValidity !== undefined) {
      return 'supersedes undo: targetValidity is only supported for legacy edges without snapshots';
    }
  }

  const normalizedEffective = validateIsoTimestamp(effectiveAt);
  if (!normalizedEffective.ok) {
    return `supersedes undo: invalid edge effectiveAt (${normalizedEffective.reason})`;
  }

  const targetMeta = JSON.parse(targetRow.metadata) as Record<string, unknown>;
  const sourceMeta = JSON.parse(sourceRow.metadata) as Record<string, unknown>;
  const targetTemporal = parseTemporalMetadata(targetMeta.temporal);
  const sourceTemporal = parseTemporalMetadata(sourceMeta.temporal);

  if (!targetTemporal?.supersededAt || !targetTemporal.supersededBy) {
    return 'supersedes undo: target is not superseded';
  }
  if (targetTemporal.supersededBy !== sourceId) {
    return 'supersedes undo: target supersededBy does not match this edge source';
  }

  const targetSupersededAt = parseIsoTimestamp(targetTemporal.supersededAt);
  const edgeEffective = parseIsoTimestamp(normalizedEffective.normalized);
  if (!targetSupersededAt || !edgeEffective || targetSupersededAt.getTime() !== edgeEffective.getTime()) {
    return 'supersedes undo: target supersededAt no longer matches this edge effectiveAt';
  }

  const introducedSourceValidFrom = snapshots !== undefined && !snapshots.priorSource.validFrom;
  if (
    introducedSourceValidFrom
    && sourceTemporal?.validFrom !== normalizedEffective.normalized
  ) {
    return 'supersedes undo: source validFrom was changed after this supersession';
  }

  if (snapshots && targetTemporal.validFrom !== snapshots.priorTarget.validFrom) {
    return 'supersedes undo: target validFrom was changed after this supersession';
  }

  const expectedTargetUntil = normalizedEffective.normalized;
  if (
    targetTemporal.validUntil !== expectedTargetUntil
  ) {
    return 'supersedes undo: target validUntil was changed after this supersession';
  }

  if (!snapshots && targetValidity === undefined) {
    return 'supersedes undo: edge lacks prior validity snapshot; pass targetValidity explicitly';
  }

  if (targetValidity !== undefined) {
    const validated = validateCallerTemporalMetadata(targetValidity);
    if (!validated.ok) {
      return `supersedes undo: ${validated.errors.join('; ')}`;
    }
  }

  return null;
}

export function buildSupersessionUndoTargetPatch(
  existingMetadata: Record<string, unknown>,
  effectiveAt: string,
  snapshots?: SupersessionEdgeSnapshots,
  explicitTargetValidity?: SupersessionValiditySnapshot,
): Record<string, unknown> {
  const existingTemporal = parseTemporalMetadata(existingMetadata.temporal) ?? {};
  const restored: TemporalMetadata = { ...existingTemporal };
  delete restored.supersededAt;
  delete restored.supersededBy;

  const prior = snapshots?.priorTarget ?? explicitTargetValidity ?? {};
  if (prior.validFrom !== undefined) restored.validFrom = prior.validFrom;
  else delete restored.validFrom;
  if (prior.validUntil !== undefined) restored.validUntil = prior.validUntil;
  else delete restored.validUntil;

  const temporal = Object.keys(restored).length > 0 ? restored : undefined;
  const next = { ...existingMetadata };
  if (temporal) next.temporal = temporal;
  else delete next.temporal;
  return next;
}

export function buildSupersessionUndoSourcePatch(
  existingMetadata: Record<string, unknown>,
  effectiveAt: string,
  snapshots?: SupersessionEdgeSnapshots,
): Record<string, unknown> {
  const existingTemporal = parseTemporalMetadata(existingMetadata.temporal) ?? {};
  const normalizedEffective = normalizeSupersessionTimestamp(effectiveAt);
  const introducedValidFrom = snapshots !== undefined && !snapshots.priorSource.validFrom
    && existingTemporal.validFrom === normalizedEffective;

  if (!introducedValidFrom) {
    return existingMetadata;
  }

  const restored: TemporalMetadata = { ...existingTemporal };
  if (snapshots?.priorSource.validFrom !== undefined) {
    restored.validFrom = snapshots.priorSource.validFrom;
  } else {
    delete restored.validFrom;
  }

  const temporal = Object.keys(restored).length > 0 ? restored : undefined;
  const next = { ...existingMetadata };
  if (temporal) next.temporal = temporal;
  else delete next.temporal;
  return next;
}
