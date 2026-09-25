import { isTimezoneQualifiedIso } from './temporal.js';

/**
 * Local protocol generation this client binds into sync state.
 * Wire evolution belongs to the convergence ticket; a different generation
 * must not supply a cursor.
 */
export const SYNC_PROTOCOL_GENERATION = 1;

const CONFIG_FIELDS = ['serverUrl', 'userId', 'token', 'salt', 'fileId'] as const;

export type SyncConfigDiagnosticStatus =
  | 'missing'
  | 'invalid_json'
  | 'disconnected'
  | 'invalid_config'
  | 'configured';

export interface SyncConfigIdentity {
  serverUrl: string;
  tenantId: string;
  fileId: string;
  token: string;
  salt: string;
}

export type SyncStateDiagnosticStatus =
  | 'missing'
  | 'invalid_json'
  | 'invalid_timestamp'
  | 'mismatched_file'
  | 'mismatched_db'
  | 'mismatched_server'
  | 'mismatched_tenant'
  | 'mismatched_protocol'
  | 'unbound'
  | 'available';

/** Identity a bound state file must match before its cursor may be used. */
export interface SyncBindingIdentity {
  dbIdentity: string;
  serverUrl: string;
  tenantId: string;
  fileId: string;
  protocolGeneration: number;
}

export interface SyncStateClassification {
  status: SyncStateDiagnosticStatus;
  cursorUsable: boolean;
  lastPushSuccess: string | null;
  lastPullSuccess: string | null;
  lastPushAttempt: string | null;
  lastPullAttempt: string | null;
  lastPushError: string | null;
  lastPullError: string | null;
}

function blankState(status: SyncStateDiagnosticStatus): SyncStateClassification {
  return {
    status,
    cursorUsable: false,
    lastPushSuccess: null,
    lastPullSuccess: null,
    lastPushAttempt: null,
    lastPullAttempt: null,
    lastPushError: null,
    lastPullError: null,
  };
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Classify a parsed sync.json value.
 * The all-empty placeholder is `disconnected`, not invalid JSON and not a network failure.
 */
export function classifySyncConfigValue(value: unknown): {
  status: Exclude<SyncConfigDiagnosticStatus, 'missing' | 'invalid_json'>;
  identity: SyncConfigIdentity | null;
} {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { status: 'invalid_config', identity: null };
  }
  const record = value as Record<string, unknown>;
  const placeholder = CONFIG_FIELDS.every((key) => record[key] === '');
  if (placeholder) return { status: 'disconnected', identity: null };

  const serverUrl = record.serverUrl;
  const userId = record.userId;
  const token = record.token;
  const salt = record.salt;
  const fileId = record.fileId;
  if (
    nonEmptyString(serverUrl)
    && nonEmptyString(userId)
    && nonEmptyString(token)
    && nonEmptyString(salt)
    && nonEmptyString(fileId)
  ) {
    return {
      status: 'configured',
      identity: {
        serverUrl,
        tenantId: userId,
        fileId,
        token,
        salt,
      },
    };
  }
  return { status: 'invalid_config', identity: null };
}

function timestampField(value: unknown): { ok: true; iso: string | null } | { ok: false } {
  if (value === null || value === undefined) return { ok: true, iso: null };
  if (typeof value === 'string' && isTimezoneQualifiedIso(value)) return { ok: true, iso: value };
  return { ok: false };
}

/**
 * Classify a parsed sync-state.json value against the current binding.
 * Pass `binding` null when config itself is not usable. Success timestamps and
 * the cursor are withheld unless every identity field matches.
 */
export function classifySyncStateValue(
  value: unknown,
  binding: SyncBindingIdentity | null,
): SyncStateClassification {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return blankState('invalid_json');
  }
  const record = value as Record<string, unknown>;
  const lastPush = timestampField(record.lastPush);
  const lastPull = timestampField(record.lastPull);
  const lastPushAttempt = timestampField(record.lastPushAttempt);
  const lastPullAttempt = timestampField(record.lastPullAttempt);
  if (!lastPush.ok || !lastPull.ok || !lastPushAttempt.ok || !lastPullAttempt.ok) {
    return blankState('invalid_timestamp');
  }

  const fileId = typeof record.fileId === 'string' && record.fileId.length > 0
    ? record.fileId
    : null;
  if (!fileId || (binding && fileId !== binding.fileId)) {
    return blankState('mismatched_file');
  }
  if (!binding) return blankState('unbound');

  const dbIdentity = typeof record.dbIdentity === 'string' && record.dbIdentity.length > 0
    ? record.dbIdentity
    : null;
  const serverUrl = typeof record.serverUrl === 'string' && record.serverUrl.length > 0
    ? record.serverUrl
    : null;
  const tenantId = typeof record.tenantId === 'string' && record.tenantId.length > 0
    ? record.tenantId
    : null;
  const protocolGeneration = typeof record.protocolGeneration === 'number'
    && Number.isInteger(record.protocolGeneration)
    ? record.protocolGeneration
    : null;
  if (!dbIdentity || !serverUrl || !tenantId || protocolGeneration === null) {
    return blankState('unbound');
  }
  if (dbIdentity !== binding.dbIdentity) return blankState('mismatched_db');
  if (serverUrl !== binding.serverUrl) return blankState('mismatched_server');
  if (tenantId !== binding.tenantId) return blankState('mismatched_tenant');
  if (protocolGeneration !== binding.protocolGeneration) return blankState('mismatched_protocol');

  const cursorUsable = record.cursor === undefined
    || record.cursor === null
    || typeof record.cursor === 'string';
  return {
    status: 'available',
    cursorUsable,
    lastPushSuccess: lastPush.iso,
    lastPullSuccess: lastPull.iso,
    lastPushAttempt: lastPushAttempt.iso,
    lastPullAttempt: lastPullAttempt.iso,
    lastPushError: typeof record.lastPushError === 'string' ? record.lastPushError : null,
    lastPullError: typeof record.lastPullError === 'string' ? record.lastPullError : null,
  };
}
