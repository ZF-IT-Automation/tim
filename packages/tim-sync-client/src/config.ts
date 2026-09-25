import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  SYNC_PROTOCOL_GENERATION,
  classifySyncConfigValue,
  classifySyncStateValue,
  getTimDir,
  type SyncBindingIdentity,
  type SyncConfigDiagnosticStatus,
  type SyncStateClassification,
} from 'tim-core';

export interface SyncConfig {
  serverUrl: string;
  userId: string;
  token: string;
  salt: string;
  fileId: string;
}

export interface SyncState {
  fileGeneration?: string;
  fileId: string;
  cursor: string | null;
  lastPush: string | null;
  lastPull: string | null;
  /** Canonical local database path this state is bound to. */
  dbIdentity?: string;
  serverUrl?: string;
  tenantId?: string;
  protocolGeneration?: number;
  lastPushAttempt?: string | null;
  lastPullAttempt?: string | null;
  lastPushError?: string | null;
  lastPullError?: string | null;
}

export interface SyncConfigRead {
  status: SyncConfigDiagnosticStatus;
  config: SyncConfig | null;
  path: string;
}

export type SyncStateFileRead =
  | { kind: 'missing'; path: string }
  | { kind: 'invalid_json'; path: string }
  | { kind: 'parsed'; path: string; value: unknown };

export function getSyncConfigPath(): string {
  return path.join(getTimDir(), 'sync.json');
}

export function getSyncStatePath(): string {
  return path.join(getTimDir(), 'sync-state.json');
}

export function getDeviceIdPath(): string {
  return path.join(getTimDir(), 'device-id');
}

export function getQueuePath(fileId: string): string {
  return path.join(getTimDir(), `${fileId}.queue.json`);
}

export function describeSyncConfigStatus(status: SyncConfigDiagnosticStatus): string {
  switch (status) {
    case 'missing':
      return 'Not connected. Run: tim sync connect';
    case 'disconnected':
      return 'Sync config is a disconnected placeholder (empty server, tenant, token, salt, and file). Not a network failure.';
    case 'invalid_json':
      return 'sync.json is invalid JSON.';
    case 'invalid_config':
      return 'sync.json failed schema validation.';
    case 'configured':
      return 'Sync config is valid.';
  }
}

export function readSyncConfig(): SyncConfigRead {
  const configPath = getSyncConfigPath();
  if (!fs.existsSync(configPath)) {
    return { status: 'missing', config: null, path: configPath };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    return { status: 'invalid_json', config: null, path: configPath };
  }
  const classified = classifySyncConfigValue(parsed);
  if (classified.status !== 'configured' || !classified.identity) {
    return { status: classified.status, config: null, path: configPath };
  }
  const identity = classified.identity;
  return {
    status: 'configured',
    path: configPath,
    config: {
      serverUrl: identity.serverUrl,
      userId: identity.tenantId,
      token: identity.token,
      salt: identity.salt,
      fileId: identity.fileId,
    },
  };
}

/** Valid connected config only. Placeholder, invalid JSON, and schema failures are null. */
export function loadConfig(): SyncConfig | null {
  return readSyncConfig().config;
}

/** Real path of an existing database file. Does not create the file. */
export function canonicalDbIdentity(dbPath: string): string | null {
  if (dbPath === ':memory:') return ':memory:';
  if (!fs.existsSync(dbPath)) return null;
  return fs.realpathSync(dbPath);
}

export function bindingFor(config: SyncConfig, dbIdentity: string): SyncBindingIdentity {
  return {
    dbIdentity,
    serverUrl: config.serverUrl,
    tenantId: config.userId,
    fileId: config.fileId,
    protocolGeneration: SYNC_PROTOCOL_GENERATION,
  };
}

export function freshBoundSyncState(config: SyncConfig, dbIdentity: string): SyncState {
  return {
    fileId: config.fileId,
    cursor: null,
    lastPush: null,
    lastPull: null,
    dbIdentity,
    serverUrl: config.serverUrl,
    tenantId: config.userId,
    protocolGeneration: SYNC_PROTOCOL_GENERATION,
    lastPushAttempt: null,
    lastPullAttempt: null,
    lastPushError: null,
    lastPullError: null,
  };
}

export function saveConfig(config: SyncConfig): void {
  const dir = getTimDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(getSyncConfigPath(), JSON.stringify(config, null, 2), { mode: 0o600 });
}

export function clearConfig(): boolean {
  const p = getSyncConfigPath();
  if (!fs.existsSync(p)) return false;
  fs.unlinkSync(p);
  return true;
}

export function clearSyncState(): boolean {
  const p = getSyncStatePath();
  if (!fs.existsSync(p)) return false;
  fs.unlinkSync(p);
  return true;
}

export function clearSyncConnection(): { config: boolean; state: boolean } {
  return {
    config: clearConfig(),
    state: clearSyncState(),
  };
}

export function readSyncStateFile(): SyncStateFileRead {
  const statePath = getSyncStatePath();
  if (!fs.existsSync(statePath)) return { kind: 'missing', path: statePath };
  try {
    return { kind: 'parsed', path: statePath, value: JSON.parse(fs.readFileSync(statePath, 'utf8')) };
  } catch {
    return { kind: 'invalid_json', path: statePath };
  }
}

export function classifySyncStateFile(
  binding: SyncBindingIdentity | null,
): SyncStateClassification & { path: string } {
  const read = readSyncStateFile();
  if (read.kind === 'missing') return { ...blankMissing(), path: read.path, status: 'missing' };
  if (read.kind === 'invalid_json') {
    return { ...classifySyncStateValue(null, binding), path: read.path, status: 'invalid_json' };
  }
  return { ...classifySyncStateValue(read.value, binding), path: read.path };
}

function blankMissing(): SyncStateClassification {
  return classifySyncStateValue(undefined, null);
}

export function loadBoundSyncState(config: SyncConfig, dbIdentity: string): SyncState {
  const binding = bindingFor(config, dbIdentity);
  const read = readSyncStateFile();
  if (read.kind === 'missing') return freshBoundSyncState(config, dbIdentity);
  if (read.kind === 'invalid_json') throw new SyncStateRejectedError('invalid_json');
  const classified = classifySyncStateValue(read.value, binding);
  if (classified.status !== 'available' || !classified.cursorUsable) {
    throw new SyncStateRejectedError(classified.status);
  }
  const record = read.value as Record<string, unknown>;
  return {
    fileId: config.fileId,
    cursor: typeof record.cursor === 'string' ? record.cursor : null,
    fileGeneration: typeof record.fileGeneration === 'string' ? record.fileGeneration : undefined,
    lastPush: classified.lastPushSuccess,
    lastPull: classified.lastPullSuccess,
    dbIdentity,
    serverUrl: config.serverUrl,
    tenantId: config.userId,
    protocolGeneration: SYNC_PROTOCOL_GENERATION,
    lastPushAttempt: classified.lastPushAttempt,
    lastPullAttempt: classified.lastPullAttempt,
    lastPushError: classified.lastPushError,
    lastPullError: classified.lastPullError,
  };
}

export class SyncStateRejectedError extends Error {
  readonly code: string;

  constructor(status: string) {
    super(
      `Sync state ${status} cannot supply a cursor. `
      + 'Run `tim sync repair` to archive the state file and start a new baseline. '
      + 'Diagnosis does not reset state.',
    );
    this.name = 'SyncStateRejectedError';
    this.code = status;
  }
}

export interface SyncRepairResult {
  action: 'created' | 'unchanged' | 'repaired';
  preservedPath: string | null;
}

/**
 * Archive legacy or mismatched state, then write a bound state with a null cursor.
 * Refuses when config is not a valid connection. Does not contact the server.
 */
export function repairSyncState(dbIdentity: string): SyncRepairResult {
  const configRead = readSyncConfig();
  if (!configRead.config) {
    throw new Error(describeSyncConfigStatus(configRead.status));
  }
  const binding = bindingFor(configRead.config, dbIdentity);
  const read = readSyncStateFile();
  if (read.kind === 'missing') {
    saveSyncState(freshBoundSyncState(configRead.config, dbIdentity));
    return { action: 'created', preservedPath: null };
  }
  if (read.kind === 'parsed') {
    const classified = classifySyncStateValue(read.value, binding);
    if (classified.status === 'available' && classified.cursorUsable) {
      return { action: 'unchanged', preservedPath: null };
    }
  }
  const preservedPath = legacyStateArchivePath(path.dirname(read.path));
  fs.copyFileSync(read.path, preservedPath);
  fs.chmodSync(preservedPath, 0o600);
  saveSyncState(freshBoundSyncState(configRead.config, dbIdentity));
  return { action: 'repaired', preservedPath };
}

function legacyStateArchivePath(dir: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(dir, `sync-state.legacy.${stamp}.json`);
}

/** @deprecated Prefer loadBoundSyncState. Raw parse does not prove the cursor is usable. */
export function loadSyncState(): SyncState | null {
  const read = readSyncStateFile();
  if (read.kind !== 'parsed' || !read.value || typeof read.value !== 'object' || Array.isArray(read.value)) {
    return null;
  }
  const record = read.value as Partial<SyncState>;
  if (typeof record.fileId !== 'string') return null;
  return {
    fileId: record.fileId,
    cursor: typeof record.cursor === 'string' ? record.cursor : null,
    fileGeneration: typeof record.fileGeneration === 'string' ? record.fileGeneration : undefined,
    lastPush: typeof record.lastPush === 'string' ? record.lastPush : null,
    lastPull: typeof record.lastPull === 'string' ? record.lastPull : null,
    dbIdentity: typeof record.dbIdentity === 'string' ? record.dbIdentity : undefined,
    serverUrl: typeof record.serverUrl === 'string' ? record.serverUrl : undefined,
    tenantId: typeof record.tenantId === 'string' ? record.tenantId : undefined,
    protocolGeneration: typeof record.protocolGeneration === 'number' ? record.protocolGeneration : undefined,
    lastPushAttempt: typeof record.lastPushAttempt === 'string' ? record.lastPushAttempt : null,
    lastPullAttempt: typeof record.lastPullAttempt === 'string' ? record.lastPullAttempt : null,
    lastPushError: typeof record.lastPushError === 'string' ? record.lastPushError : null,
    lastPullError: typeof record.lastPullError === 'string' ? record.lastPullError : null,
  };
}

export function saveSyncState(state: SyncState): void {
  const dir = getTimDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const target = getSyncStatePath();
  const tmp = `${target}.${randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(tmp, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(state, null, 2)); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(tmp,target);
    const dirFd = fs.openSync(dir,'r');
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
}

export function getDeviceId(): string {
  const p = getDeviceIdPath();
  if (fs.existsSync(p)) {
    const id = fs.readFileSync(p, 'utf8').trim();
    if (id) return id;
  }
  const dir = getTimDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const id = randomUUID();
  fs.writeFileSync(p, id, { mode: 0o600 });
  return id;
}

export function defaultFileId(deviceId?: string): string {
  return `tim-${deviceId ?? getDeviceId()}`;
}
