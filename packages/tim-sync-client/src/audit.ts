import * as fs from 'node:fs';
import * as path from 'node:path';
import { SYNC_PROTOCOL_GENERATION, type SyncConfigDiagnosticStatus, type SyncStateDiagnosticStatus } from 'tim-core';
import { TimStore, getCurrentVersion } from 'tim-store';
import {
  canonicalDbIdentity,
  classifySyncStateFile,
  getQueuePath,
  readSyncConfig,
  type SyncConfig,
} from './config.js';

export interface SyncAuditReport {
  requestedDbPath: string;
  dbPath: string | null;
  dbExists: boolean;
  openedReadOnly: boolean;
  schemaVersion: number | null;
  schemaCompatible: boolean;
  /** Effective outbox: false when the staging_disabled trigger is installed. */
  stagingEnabled: boolean | null;
  clientProtocolGeneration: number;
  connection: {
    status: SyncConfigDiagnosticStatus;
    serverUrl: string | null;
    tenantId: string | null;
    fileId: string | null;
    protocolGeneration: number | null;
  };
  state: {
    status: SyncStateDiagnosticStatus;
    cursorUsable: boolean;
    lastPushAttempt: string | null;
    lastPullAttempt: string | null;
    lastPushSuccess: string | null;
    lastPullSuccess: string | null;
    lastPushError: string | null;
    lastPullError: string | null;
  };
  backlog: {
    count: number | null;
    oldestAgeMs: number | null;
  };
  queue: {
    bytes: number | null;
  };
}

function connectionIdentity(config: SyncConfig | null, status: SyncConfigDiagnosticStatus): SyncAuditReport['connection'] {
  if (!config) {
    return {
      status,
      serverUrl: null,
      tenantId: null,
      fileId: null,
      protocolGeneration: null,
    };
  }
  return {
    status,
    serverUrl: config.serverUrl,
    tenantId: config.userId,
    fileId: config.fileId,
    protocolGeneration: SYNC_PROTOCOL_GENERATION,
  };
}

function queueBytes(config: SyncConfig | null): number | null {
  if (!config) return null;
  const queuePath = getQueuePath(config.fileId);
  if (!fs.existsSync(queuePath)) return 0;
  return fs.statSync(queuePath).size;
}

/**
 * Read-only sync diagnostic. Does not migrate, install triggers, ack or delete
 * staging, record usage, or rewrite config, state, or queue files.
 */
export function collectSyncAudit(dbPath: string): SyncAuditReport {
  const configRead = readSyncConfig();
  const dbIdentity = canonicalDbIdentity(dbPath);
  const binding = configRead.config && dbIdentity
    ? {
      dbIdentity,
      serverUrl: configRead.config.serverUrl,
      tenantId: configRead.config.userId,
      fileId: configRead.config.fileId,
      protocolGeneration: SYNC_PROTOCOL_GENERATION,
    }
    : null;
  const state = classifySyncStateFile(binding);

  let openedReadOnly = false;
  let schemaVersion: number | null = null;
  let schemaCompatible = false;
  let stagingEnabled: boolean | null = null;
  let backlogCount: number | null = null;
  let oldestAgeMs: number | null = null;

  if (dbIdentity && dbPath !== ':memory:') {
    const store = new TimStore(dbPath, { readonly: true });
    try {
      openedReadOnly = true;
      const db = store.getDb();
      const versionTable = db.prepare(
        "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = '_schema_version'",
      ).get() as { present: number } | undefined;
      if (versionTable) {
        const row = db.prepare('SELECT version FROM _schema_version').get() as { version: number } | undefined;
        schemaVersion = row?.version ?? null;
        schemaCompatible = schemaVersion === getCurrentVersion();
      }
      const trigger = db.prepare(
        "SELECT 1 AS present FROM sqlite_master WHERE type = 'trigger' AND name = 'staging_disabled'",
      ).get() as { present: number } | undefined;
      stagingEnabled = !trigger;
      const backlog = db.prepare(
        'SELECT COUNT(*) AS count, MIN(lww_timestamp) AS oldest FROM staging WHERE acked = 0',
      ).get() as { count: number; oldest: number | null };
      backlogCount = backlog.count;
      oldestAgeMs = backlog.oldest === null ? null : Date.now() - backlog.oldest;
    } finally {
      store.close();
    }
  }

  return {
    requestedDbPath: dbPath === ':memory:' ? dbPath : path.resolve(dbPath),
    dbPath: dbIdentity,
    dbExists: dbIdentity !== null,
    openedReadOnly,
    schemaVersion,
    schemaCompatible,
    stagingEnabled,
    clientProtocolGeneration: SYNC_PROTOCOL_GENERATION,
    connection: connectionIdentity(configRead.config, configRead.status),
    state: {
      status: state.status,
      cursorUsable: state.cursorUsable,
      lastPushAttempt: state.lastPushAttempt,
      lastPullAttempt: state.lastPullAttempt,
      lastPushSuccess: state.lastPushSuccess,
      lastPullSuccess: state.lastPullSuccess,
      lastPushError: state.lastPushError,
      lastPullError: state.lastPullError,
    },
    backlog: { count: backlogCount, oldestAgeMs },
    queue: { bytes: queueBytes(configRead.config) },
  };
}
