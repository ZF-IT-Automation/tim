/** Known metadata keys stored as JSON booleans (legacy data may use 1/0 or "true"/"false"). */
export const BOOLEAN_METADATA_KEYS = [
  'task',
  'archived',
  'pinned',
  'favorite',
  'irrelevant',
  'done',
  'completed',
  'cancelled',
  'in_progress',
] as const;

type BooleanMetadataKey = (typeof BOOLEAN_METADATA_KEYS)[number];

const BOOLEAN_KEY_SET = new Set<string>(BOOLEAN_METADATA_KEYS);

export function normalizeTaskValue(value: unknown): boolean | unknown {
  if (value === 1 || value === 'true') return true;
  if (value === 0 || value === 'false') return false;
  return value;
}

export function isTaskMarker(value: unknown): boolean {
  // Recognizes BOTH the legacy boolean form (task: true / 1 / "true")
  // AND the canonical object form (task: { status: ..., priority: ... }).
  // The object form is what real tasks look like in the DB; the boolean
  // form is what legacy entries (and some tests) use.
  if (normalizeTaskValue(value) === true) return true;
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return true;
  }
  return false;
}

function coerceBooleanValue(value: unknown): unknown {
  if (value === 1 || value === 'true') return true;
  if (value === 0 || value === 'false') return false;
  return value;
}

export function coerceMetadataBooleans(meta: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(meta)) {
    if (BOOLEAN_KEY_SET.has(key)) {
      out[key] = coerceBooleanValue(value);
    } else if (Array.isArray(value)) {
      out[key] = value.map(item =>
        item !== null && typeof item === 'object' && !Array.isArray(item)
          ? coerceMetadataBooleans(item as Record<string, unknown>)
          : item,
      );
    } else if (value !== null && typeof value === 'object') {
      out[key] = coerceMetadataBooleans(value as Record<string, unknown>);
    } else {
      out[key] = value;
    }
  }

  return out;
}

export function metadataNeedsCoercion(meta: Record<string, unknown>): boolean {
  return JSON.stringify(meta) !== JSON.stringify(coerceMetadataBooleans(meta));
}

export function parseAndCoerceMetadata(metadataJson: string): Record<string, unknown> {
  const parsed = JSON.parse(metadataJson) as Record<string, unknown>;
  return coerceMetadataBooleans(parsed);
}

/** @internal type guard for known boolean keys */
export function isBooleanMetadataKey(key: string): key is BooleanMetadataKey {
  return BOOLEAN_KEY_SET.has(key);
}
