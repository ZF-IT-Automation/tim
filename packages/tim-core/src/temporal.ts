/**
 * Temporal validity metadata — additive `metadata.temporal` contract (#36).
 *
 * Half-open intervals [validFrom, validUntil). Entries without temporal metadata
 * are legacy current records. Supersession fields are system-managed via the
 * validated `supersedes` link operation and cannot be set through ordinary writes.
 */

export interface TemporalMetadata {
  validFrom?: string;
  validUntil?: string;
  supersededAt?: string;
  supersededBy?: string;
}

/** Fields callers may set through write/update/bulk routes. */
export const CALLER_TEMPORAL_FIELDS = ['validFrom', 'validUntil'] as const;

/** Fields only set atomically by the supersedes link operation. */
export const SYSTEM_TEMPORAL_FIELDS = ['supersededAt', 'supersededBy'] as const;

const ISO_WITH_TZ_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.(\d+))?(?:Z|[+-]\d{2}:\d{2})$/;

const MAX_FRACTION_DIGITS = 3;

export type TemporalValidationResult =
  | { ok: true; temporal: TemporalMetadata }
  | { ok: false; errors: string[] };

export type IsoValidationResult =
  | { ok: true; normalized: string; epochMs: number }
  | { ok: false; reason: string };

function isRealCalendarDate(year: number, month: number, day: number): boolean {
  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year
    && probe.getUTCMonth() === month - 1
    && probe.getUTCDate() === day
  );
}

/** Strict ISO 8601 validation with canonical UTC normalization. */
export function validateIsoTimestamp(value: string): IsoValidationResult {
  const match = ISO_WITH_TZ_RE.exec(value);
  if (!match) {
    return { ok: false, reason: 'timezone-qualified ISO 8601 string required' };
  }

  const fraction = match[1];
  if (fraction && fraction.length > MAX_FRACTION_DIGITS) {
    return { ok: false, reason: 'sub-millisecond precision is not supported' };
  }

  const offset = match[2] ?? 'Z';
  if (offset !== 'Z') {
    const offsetHours = Number(offset.slice(1, 3));
    const offsetMinutes = Number(offset.slice(4, 6));
    if (
      offsetHours > 14
      || offsetMinutes > 59
      || (offsetHours === 14 && offsetMinutes > 0)
    ) {
      return { ok: false, reason: 'invalid timezone offset' };
    }
  }

  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const hour = Number(value.slice(11, 13));
  const minute = Number(value.slice(14, 16));
  const second = Number(value.slice(17, 19));

  if (!isRealCalendarDate(year, month, day)) {
    return { ok: false, reason: 'impossible calendar date' };
  }
  if (hour > 23 || minute > 59 || second > 59) {
    return { ok: false, reason: 'invalid time-of-day' };
  }

  const epochMs = Date.parse(value);
  if (!Number.isFinite(epochMs)) {
    return { ok: false, reason: 'unparseable timestamp' };
  }

  return { ok: true, normalized: new Date(epochMs).toISOString(), epochMs };
}

export function isoTimestampToEpochMs(value: string): number | null {
  const result = validateIsoTimestamp(value);
  return result.ok ? result.epochMs : null;
}

export function isTimezoneQualifiedIso(value: string): boolean {
  return validateIsoTimestamp(value).ok;
}

export function normalizeIsoTimestamp(value: string): string | null {
  const result = validateIsoTimestamp(value);
  return result.ok ? result.normalized : null;
}

export function parseIsoTimestamp(value: string): Date | null {
  const result = validateIsoTimestamp(value);
  return result.ok ? new Date(result.epochMs) : null;
}

function validateOptionalIsoField(
  obj: Record<string, unknown>,
  field: string,
  errors: string[],
): string | undefined {
  const raw = obj[field];
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string') {
    errors.push(`temporal.${field}: timezone-qualified ISO 8601 string required`);
    return undefined;
  }
  const validated = validateIsoTimestamp(raw);
  if (!validated.ok) {
    errors.push(`temporal.${field}: ${validated.reason}`);
    return undefined;
  }
  return validated.normalized;
}

/** Structural validator for caller-supplied temporal fields (validFrom/validUntil only). */
export function validateCallerTemporalMetadata(value: unknown): TemporalValidationResult {
  if (value === undefined || value === null) {
    return { ok: true, temporal: {} };
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, errors: ['temporal: must be an object'] };
  }
  const obj = value as Record<string, unknown>;
  const errors: string[] = [];
  const unknown = Object.keys(obj).filter(
    key => !(CALLER_TEMPORAL_FIELDS as readonly string[]).includes(key),
  );
  if (unknown.length) {
    errors.push(
      `temporal: unknown or system-managed fields: ${unknown.join(', ')} ` +
      '(supersession uses tim_link type supersedes)',
    );
  }
  const validFrom = validateOptionalIsoField(obj, 'validFrom', errors);
  const validUntil = validateOptionalIsoField(obj, 'validUntil', errors);
  if (validFrom && validUntil) {
    const fromMs = isoTimestampToEpochMs(validFrom)!;
    const untilMs = isoTimestampToEpochMs(validUntil)!;
    if (fromMs >= untilMs) {
      errors.push('temporal: validFrom must be strictly before validUntil (half-open interval)');
    }
  }
  if (errors.length) return { ok: false, errors };
  const temporal: TemporalMetadata = {};
  if (validFrom) temporal.validFrom = validFrom;
  if (validUntil) temporal.validUntil = validUntil;
  return { ok: true, temporal };
}

/** Parse stored temporal metadata without throwing. */
export function parseTemporalMetadata(value: unknown): TemporalMetadata | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) return undefined;
  const obj = value as Record<string, unknown>;
  const temporal: TemporalMetadata = {};

  for (const field of CALLER_TEMPORAL_FIELDS) {
    const raw = obj[field];
    if (typeof raw === 'string') {
      const normalized = normalizeIsoTimestamp(raw);
      if (normalized) temporal[field] = normalized;
    }
  }

  const supersededAtRaw = obj.supersededAt;
  if (typeof supersededAtRaw === 'string') {
    const normalized = normalizeIsoTimestamp(supersededAtRaw);
    if (normalized) temporal.supersededAt = normalized;
  }

  const supersededByRaw = obj.supersededBy;
  if (typeof supersededByRaw === 'string' && supersededByRaw.length > 0) {
    temporal.supersededBy = supersededByRaw;
  }

  return Object.keys(temporal).length > 0 ? temporal : undefined;
}

/** Merge caller temporal patches while preserving system-managed supersession fields. */
export function mergeCallerTemporalMetadata(
  existing: TemporalMetadata,
  patch: TemporalMetadata,
): TemporalMetadata {
  const merged: TemporalMetadata = { ...existing, ...patch };
  if (existing.supersededAt !== undefined) merged.supersededAt = existing.supersededAt;
  if (existing.supersededBy !== undefined) merged.supersededBy = existing.supersededBy;
  return merged;
}

/** Reject patches that would clear managed supersession state. */
export function rejectTemporalManagedFieldClearing(
  existingMetadata: Record<string, unknown> | undefined,
  patchMetadata: Record<string, unknown> | undefined,
): void {
  const existing = parseTemporalMetadata(existingMetadata?.temporal);
  if (!existing?.supersededAt && !existing?.supersededBy) return;
  if (patchMetadata?.temporal === undefined) return;

  if (patchMetadata.temporal === null) {
    throw new Error(
      'Invalid metadata.temporal: cannot clear temporal metadata while supersession state exists',
    );
  }
  if (typeof patchMetadata.temporal !== 'object' || Array.isArray(patchMetadata.temporal)) {
    return;
  }

  const patch = patchMetadata.temporal as Record<string, unknown>;
  if (Object.keys(patch).length === 0) {
    throw new Error(
      'Invalid metadata.temporal: cannot clear supersession state via empty temporal patch',
    );
  }

  for (const field of SYSTEM_TEMPORAL_FIELDS) {
    if (patch[field] === null) {
      throw new Error(
        `Invalid metadata.temporal.${field}: supersession state is system-managed`,
      );
    }
  }
}

export type TemporalEligibilityState =
  | 'current'
  | 'superseded'
  | 'not_yet_valid'
  | 'expired';

/** Half-open [validFrom, validUntil) eligibility at a point in time. */
export function temporalEligibilityAt(
  temporal: TemporalMetadata | undefined,
  at: Date,
): { eligible: boolean; state: TemporalEligibilityState } {
  if (temporal?.validFrom) {
    const from = parseIsoTimestamp(temporal.validFrom);
    if (from && at < from) {
      return { eligible: false, state: 'not_yet_valid' };
    }
  }
  if (temporal?.supersededAt) {
    const superseded = parseIsoTimestamp(temporal.supersededAt);
    if (superseded && at >= superseded) {
      return { eligible: false, state: 'superseded' };
    }
  }
  if (temporal?.validUntil) {
    const until = parseIsoTimestamp(temporal.validUntil);
    if (until && at >= until) {
      return { eligible: false, state: 'expired' };
    }
  }
  return { eligible: true, state: 'current' };
}

export function assertValidCallerTemporalMetadata(
  metadata: Record<string, unknown> | undefined,
): void {
  if (!metadata || metadata.temporal === undefined) return;
  const result = validateCallerTemporalMetadata(metadata.temporal);
  if (!result.ok) {
    throw new Error(`Invalid metadata.temporal: ${result.errors.join('; ')}`);
  }
}

/** Reject forged supersession fields on direct metadata patches. */
export function rejectForgedTemporalSupersession(
  metadata: Record<string, unknown> | undefined,
): void {
  if (!metadata?.temporal || typeof metadata.temporal !== 'object' || Array.isArray(metadata.temporal)) {
    return;
  }
  const obj = metadata.temporal as Record<string, unknown>;
  for (const field of SYSTEM_TEMPORAL_FIELDS) {
    if (obj[field] !== undefined) {
      throw new Error(
        `Invalid metadata.temporal.${field}: supersession must use tim_link type supersedes`,
      );
    }
  }
}

export function validateSupersessionEffectiveAt(value: unknown): TemporalValidationResult {
  if (typeof value !== 'string') {
    return { ok: false, errors: ['effectiveAt: timezone-qualified ISO 8601 string required'] };
  }
  const validated = validateIsoTimestamp(value);
  if (!validated.ok) {
    return { ok: false, errors: [`effectiveAt: ${validated.reason}`] };
  }
  return { ok: true, temporal: {} };
}
