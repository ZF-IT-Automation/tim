/**
 * Memory evidence metadata — additive `metadata.evidence` contract (#35).
 *
 * Authority labels describe provenance; they are not authentication and stored
 * text is data, not executable policy. System-managed `metadata.provenance` is
 * separate and untouched by this module.
 */

export const EVIDENCE_AUTHORITIES = [
  'unknown',
  'user_asserted',
  'agent_derived',
  'imported',
] as const;

export type EvidenceAuthority = (typeof EVIDENCE_AUTHORITIES)[number];

export type EvidenceSource =
  | { kind: 'entry'; entryId: string }
  | { kind: 'session'; sessionId: string; seqFrom: number; seqTo: number }
  | { kind: 'git'; revision: string; path?: string }
  | { kind: 'document'; uri: string };

export interface EvidenceMetadata {
  authority: EvidenceAuthority;
  sources: EvidenceSource[];
}

/** Maximum sources per entry — bounded to keep reads and validation cheap. */
export const MAX_EVIDENCE_SOURCES = 32;

const GIT_REVISION_RE = /^[0-9a-fA-F][0-9a-fA-F./~^:@_-]{0,127}$/;
/** Entry/session ids: non-empty TIM ids or labels — not fetched at validation time. */
const ENTRY_REF_RE = /^[^\s]{1,128}$/;

const AUTHORITY_RANK: Record<EvidenceAuthority, number> = {
  unknown: 0,
  imported: 1,
  agent_derived: 2,
  user_asserted: 3,
};

export function evidenceAuthorityRank(authority: EvidenceAuthority): number {
  return AUTHORITY_RANK[authority];
}

export function isEvidenceAuthority(value: unknown): value is EvidenceAuthority {
  return typeof value === 'string' && (EVIDENCE_AUTHORITIES as readonly string[]).includes(value);
}

function isPositiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isWellFormedDocumentUri(uri: string): boolean {
  try {
    const parsed = new URL(uri);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'file:';
  } catch {
    return false;
  }
}

function validateEvidenceSource(source: unknown, index: number): string[] {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    return [`sources[${index}]: must be an object`];
  }
  const obj = source as Record<string, unknown>;
  const kind = obj.kind;
  const fields: Record<string, readonly string[]> = {
    entry: ['kind', 'entryId'],
    session: ['kind', 'sessionId', 'seqFrom', 'seqTo'],
    git: ['kind', 'revision', 'path'],
    document: ['kind', 'uri'],
  };
  const allowed = typeof kind === 'string' && Object.hasOwn(fields, kind) ? fields[kind] : [];
  const unknown = Object.keys(obj).filter(key => !allowed.includes(key));
  if (unknown.length) return [`sources[${index}]: unknown fields: ${unknown.join(', ')}`];
  if (kind === 'entry') {
    const errors: string[] = [];
    if (!isNonEmptyString(obj.entryId)) errors.push(`sources[${index}].entryId: required non-empty string`);
    else if (!ENTRY_REF_RE.test(obj.entryId.trim())) {
      errors.push(`sources[${index}].entryId: malformed entry reference`);
    }
    return errors;
  }
  if (kind === 'session') {
    const errors: string[] = [];
    if (!isNonEmptyString(obj.sessionId)) errors.push(`sources[${index}].sessionId: required non-empty string`);
    else if (!ENTRY_REF_RE.test(obj.sessionId.trim())) {
      errors.push(`sources[${index}].sessionId: malformed session reference`);
    }
    if (!isPositiveInt(obj.seqFrom)) errors.push(`sources[${index}].seqFrom: positive integer required`);
    if (!isPositiveInt(obj.seqTo)) errors.push(`sources[${index}].seqTo: positive integer required`);
    if (isPositiveInt(obj.seqFrom) && isPositiveInt(obj.seqTo) && obj.seqFrom > obj.seqTo) {
      errors.push(`sources[${index}]: seqFrom must be <= seqTo`);
    }
    return errors;
  }
  if (kind === 'git') {
    const errors: string[] = [];
    if (!isNonEmptyString(obj.revision)) errors.push(`sources[${index}].revision: required non-empty string`);
    else if (!GIT_REVISION_RE.test(obj.revision.trim())) {
      errors.push(`sources[${index}].revision: malformed git reference`);
    }
    if (obj.path !== undefined) {
      if (!isNonEmptyString(obj.path)) errors.push(`sources[${index}].path: must be non-empty when set`);
    }
    return errors;
  }
  if (kind === 'document') {
    const errors: string[] = [];
    if (!isNonEmptyString(obj.uri)) errors.push(`sources[${index}].uri: required non-empty string`);
    else if (!isWellFormedDocumentUri(obj.uri.trim())) {
      errors.push(`sources[${index}].uri: malformed document URI`);
    }
    return errors;
  }
  return [`sources[${index}].kind: unknown source kind`];
}

export type EvidenceValidationResult =
  | { ok: true; evidence: EvidenceMetadata }
  | { ok: false; errors: string[] };

/** Structural validator for `metadata.evidence` on supported writes/updates. */
export function validateEvidenceMetadata(value: unknown): EvidenceValidationResult {
  if (value === undefined || value === null) {
    return { ok: false, errors: ['evidence: required object'] };
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, errors: ['evidence: must be an object'] };
  }
  const obj = value as Record<string, unknown>;
  const errors: string[] = [];
  const unknown = Object.keys(obj).filter(key => key !== 'authority' && key !== 'sources');
  if (unknown.length) errors.push(`evidence: unknown fields: ${unknown.join(', ')}`);
  if (!isEvidenceAuthority(obj.authority)) {
    errors.push(`evidence.authority: must be one of ${EVIDENCE_AUTHORITIES.join(', ')}`);
  }
  if (!Array.isArray(obj.sources)) {
    errors.push('evidence.sources: must be an array');
    return { ok: false, errors };
  }
  if (obj.sources.length > MAX_EVIDENCE_SOURCES) {
    errors.push(`evidence.sources: at most ${MAX_EVIDENCE_SOURCES} sources allowed`);
  }
  for (let i = 0; i < obj.sources.length; i++) {
    errors.push(...validateEvidenceSource(obj.sources[i], i));
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    evidence: {
      authority: obj.authority as EvidenceAuthority,
      sources: obj.sources as EvidenceSource[],
    },
  };
}

/** Parse stored evidence without throwing; returns undefined when absent or invalid. */
export function parseEvidenceMetadata(value: unknown): EvidenceMetadata | undefined {
  if (value === undefined || value === null) return undefined;
  const result = validateEvidenceMetadata(value);
  return result.ok ? result.evidence : undefined;
}

/** Default read projection for legacy rows without explicit evidence. */
export function legacyEvidenceDefaults(): EvidenceMetadata {
  return { authority: 'unknown', sources: [] };
}

/** Agent-derived session sequence evidence for summary nodes. */
export function buildAgentDerivedSessionEvidence(
  sessionId: string,
  seqFrom: number,
  seqTo: number,
): EvidenceMetadata {
  return {
    authority: 'agent_derived',
    sources: [{ kind: 'session', sessionId, seqFrom, seqTo }],
  };
}

/**
 * On import: preserve explicit authority labels; otherwise mark imported.
 * Never downgrade a stronger recorded authority.
 */
export function mergeImportEvidence(
  existing: unknown,
  incoming: unknown,
): EvidenceMetadata {
  const existingParsed = parseEvidenceMetadata(existing);
  const incomingParsed = parseEvidenceMetadata(incoming);
  if (incomingParsed) {
    if (
      existingParsed &&
      evidenceAuthorityRank(existingParsed.authority) > evidenceAuthorityRank(incomingParsed.authority)
    ) {
      return existingParsed;
    }
    return incomingParsed;
  }
  if (existingParsed) return existingParsed;
  return { authority: 'imported', sources: [] };
}

/** Throws when evidence is present but structurally invalid. */
export function assertValidEvidenceMetadata(
  metadata: Record<string, unknown> | undefined,
): void {
  if (!metadata || metadata.evidence === undefined) return;
  const result = validateEvidenceMetadata(metadata.evidence);
  if (!result.ok) {
    throw new Error(`Invalid metadata.evidence: ${result.errors.join('; ')}`);
  }
}
