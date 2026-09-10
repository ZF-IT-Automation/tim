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

const ALL_TEMPORAL_FIELDS = [...CALLER_TEMPORAL_FIELDS, ...SYSTEM_TEMPORAL_FIELDS];

const ISO_WITH_TZ_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

export type TemporalValidationResult =
  | { ok: true; temporal: TemporalMetadata }
  | { ok: false; errors: string[] };

export function isTimezoneQualifiedIso(value: string): boolean {
  if (!ISO_WITH_TZ_RE.test(value)) return false;
  const ms = Date.parse(value);
  return Number.isFinite(ms);
}

export function parseIsoTimestamp(value: string): Date | null {
  if (!isTimezoneQualifiedIso(value)) return null;
  return new Date(value);
}

function validateOptionalIsoField(
  obj: Record<string, unknown>,
  field: string,
  errors: string[],
): string | undefined {
  const raw = obj[field];
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !isTimezoneQualifiedIso(raw)) {
    errors.push(`temporal.${field}: timezone-qualified ISO 8601 string required`);
    return undefined;
  }
  return raw;
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
    const fromMs = Date.parse(validFrom);
    const untilMs = Date.parse(validUntil);
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
  for (const field of ALL_TEMPORAL_FIELDS) {
    const raw = obj[field];
    if (typeof raw === 'string' && isTimezoneQualifiedIso(raw)) {
      temporal[field] = raw;
    }
  }
  return Object.keys(temporal).length > 0 ? temporal : undefined;
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
  if (typeof value !== 'string' || !isTimezoneQualifiedIso(value)) {
    return { ok: false, errors: ['effectiveAt: timezone-qualified ISO 8601 string required'] };
  }
  return { ok: true, temporal: {} };
}
