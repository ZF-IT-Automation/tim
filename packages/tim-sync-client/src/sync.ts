import type { TimStore } from 'tim-store';
import {
  ackStaging,
  applyRemoteEntry,
  applyRemoteEdge,
  getUnackedStaging,
} from 'tim-store';
import { resolveLWW } from 'tim-core';
import type { StagingRecord } from 'tim-core';
import { TimSyncClient } from './client.js';
import { deriveKey, encrypt, decrypt } from './crypto.js';
import { stagingToEnvelope, envelopeToStaging, type TimEnvelope } from './envelope.js';
import {
  getQueuePath,
  loadSyncState,
  saveSyncState,
  type SyncState,
} from './config.js';
import { enqueue, flushQueue, loadQueue } from './queue.js';

export type { SyncState } from './config.js';

export interface SyncCycleContext {
  client: TimSyncClient;
  store: TimStore;
  state: SyncState;
  deviceId: string;
  passphrase: string;
  salt: string;
  secretPassphrase?: string;
}

function makeEncrypt(passphrase: string, salt: string): (data: string) => string {
  const key = deriveKey(passphrase, salt);
  return (data: string) => encrypt(data, key);
}

function makeDecrypt(passphrase: string, salt: string): (data: string) => string {
  const key = deriveKey(passphrase, salt);
  return (data: string) => decrypt(data, key);
}

function makeSecretEncrypt(secretPassphrase: string, salt: string): (data: string) => string {
  const key = deriveKey(secretPassphrase, salt);
  return (data: string) => encrypt(data, key);
}

function makeSecretDecrypt(secretPassphrase: string, salt: string): (data: string) => string {
  const key = deriveKey(secretPassphrase, salt);
  return (data: string) => decrypt(data, key);
}

function parsePayloadMetadata(metadata: unknown): { secret?: boolean } {
  if (typeof metadata === 'string') {
    try {
      return JSON.parse(metadata) as { secret?: boolean };
    } catch {
      return {};
    }
  }
  if (metadata && typeof metadata === 'object') {
    return metadata as { secret?: boolean };
  }
  return {};
}

function payloadIsSecret(payloadJson: string): boolean {
  try {
    const payload = JSON.parse(payloadJson) as { metadata?: unknown };
    return parsePayloadMetadata(payload.metadata).secret === true;
  } catch {
    return false;
  }
}

export function encryptSecretPayload(
  payloadJson: string,
  secretEncrypt: (data: string) => string,
): string {
  const payload = JSON.parse(payloadJson) as Record<string, unknown>;
  const metaRaw = payload.metadata;
  const meta =
    typeof metaRaw === 'string'
      ? (JSON.parse(metaRaw) as Record<string, unknown>)
      : { ...(metaRaw as Record<string, unknown>) };

  const encMeta = secretEncrypt(JSON.stringify(meta));

  const encrypted = {
    id: payload.id,
    parent_id: payload.parent_id,
    created_at: payload.created_at,
    updated_at: payload.updated_at,
    depth: payload.depth,
    title: secretEncrypt(String(payload.title ?? '')),
    content: secretEncrypt(String(payload.content ?? '')),
    metadata: JSON.stringify({ secret: true, _enc: encMeta }),
  };

  return JSON.stringify(encrypted);
}

export function decryptSecretPayload(
  payloadJson: string,
  secretDecrypt?: (data: string) => string,
): string {
  const payload = JSON.parse(payloadJson) as Record<string, unknown>;

  if (!secretDecrypt) {
    const metaRaw = payload.metadata;
    let enc: unknown;
    if (typeof metaRaw === 'string') {
      try {
        enc = (JSON.parse(metaRaw) as { _enc?: unknown })._enc;
      } catch {
        enc = undefined;
      }
    } else if (metaRaw && typeof metaRaw === 'object') {
      enc = (metaRaw as { _enc?: unknown })._enc;
    }

    const placeholder = {
      ...payload,
      title: '🔒 [secret]',
      content: '',
      metadata: JSON.stringify(
        enc !== undefined ? { secret: true, _enc: enc } : { secret: true },
      ),
    };
    return JSON.stringify(placeholder);
  }

  const metaRaw = payload.metadata;
  let encBlob: string | undefined;
  if (typeof metaRaw === 'string') {
    encBlob = (JSON.parse(metaRaw) as { _enc?: string })._enc;
  } else if (metaRaw && typeof metaRaw === 'object') {
    encBlob = (metaRaw as { _enc?: string })._enc;
  }

  const fullMeta = encBlob ? JSON.parse(secretDecrypt(encBlob)) : { secret: true };

  const decrypted = {
    ...payload,
    title: secretDecrypt(String(payload.title ?? '')),
    content: secretDecrypt(String(payload.content ?? '')),
    metadata: JSON.stringify(fullMeta),
  };

  return JSON.stringify(decrypted);
}

function transformEnvelopeForPush(
  env: TimEnvelope,
  secretEncrypt?: (data: string) => string,
): TimEnvelope {
  if (!secretEncrypt || env.type !== 'entry' || env.deleted || !payloadIsSecret(env.payload)) {
    return env;
  }

  return {
    ...env,
    payload: encryptSecretPayload(env.payload, secretEncrypt),
    is_encrypted: true,
  };
}

function transformEnvelopeForPull(
  env: TimEnvelope,
  secretDecrypt?: (data: string) => string,
): TimEnvelope {
  if (!env.is_encrypted || env.type !== 'entry') {
    return env;
  }

  return {
    ...env,
    payload: decryptSecretPayload(env.payload, secretDecrypt),
  };
}

export async function pushCycle(
  client: TimSyncClient,
  store: TimStore,
  state: SyncState,
  deviceId: string,
  encryptFn: (data: string) => string,
  secretEncrypt?: (data: string) => string,
): Promise<{ pushed: number; queued: boolean }> {
  const db = store.getDb();
  const rows = getUnackedStaging(db);
  const qPath = getQueuePath(state.fileId);
  let queue = loadQueue(qPath);

  if (rows.length > 0) {
    const envelopes = rows
      .map(stagingToEnvelope)
      .map((e) => transformEnvelopeForPush(e, secretEncrypt));
    const blobs = envelopes.map((e) => ({
      proposed_id: e.key,
      data: encryptFn(JSON.stringify(e)),
      device_id: deviceId,
      updated_at: e.lww,
    }));
    enqueue(qPath, queue, envelopes, blobs);
    queue = loadQueue(qPath);
  }

  const { ok, sent } = await flushQueue(qPath, queue, async (item) => {
    await client.push({
      file_id: state.fileId,
      idempotency_key: item.idempotency_key,
      client_schema_major: 1,
      blobs: item.blobs,
    });
  });

  const keysToAck: string[] = [];
  for (const item of sent) {
    for (const e of item.envelopes) keysToAck.push(e.key);
  }
  if (keysToAck.length > 0) ackStaging(db, keysToAck);

  state.lastPush = new Date().toISOString();
  saveSyncState(state);

  return { pushed: keysToAck.length, queued: !ok };
}

export async function pullCycle(
  client: TimSyncClient,
  store: TimStore,
  state: SyncState,
  decryptFn: (data: string) => string,
  secretDecrypt?: (data: string) => string,
): Promise<{ pulled: number; conflicts: number }> {
  const db = store.getDb();
  let cursor = state.cursor ?? undefined;
  let pulled = 0;
  let conflicts = 0;
  let res: Awaited<ReturnType<TimSyncClient['pull']>>;

  do {
    res = await client.pull(state.fileId, cursor, 1);
    if (res.salt && !state.fileId) {
      // salt refresh handled by caller config
    }

    for (const blob of res.blobs) {
      let env = JSON.parse(decryptFn(blob.data)) as TimEnvelope;
      env = transformEnvelopeForPull(env, secretDecrypt);
      const remote = envelopeToStaging(env, blob.client_proposed_id ?? 'remote');

      if (env.type === 'entry') {
        const existing = db.prepare(
          'SELECT * FROM entries WHERE id = ?',
        ).get(env.key) as Record<string, unknown> | undefined;

        if (existing) {
          const localRecord: StagingRecord = {
            key: env.key,
            entityType: 'entry',
            operation: existing.tombstoned_at ? 'delete' : 'upsert',
            payload: JSON.stringify(existing),
            lwwTimestamp: Date.parse(String(existing.accessed_at ?? existing.created_at)),
            lwwDevice: 'local',
            lwwConfidence: Number(existing.confidence ?? 1),
            acked: true,
          };
          const resolution = resolveLWW(localRecord, remote);
          if (resolution.winner !== remote) conflicts++;
        }

        const applied = applyRemoteEntry(
          db,
          env.payload,
          remote.lwwTimestamp,
          remote.lwwDevice,
          env.deleted,
        );
        if (applied) pulled++;
      } else {
        const parts = env.key.split('|');
        const sourceId = parts[0];
        const targetId = parts[1];
        const edgeType = parts[2];
        const existing = db.prepare(
          'SELECT * FROM edges WHERE source_id = ? AND target_id = ? AND type = ?',
        ).get(sourceId, targetId, edgeType) as Record<string, unknown> | undefined;

        if (existing) {
          const localRecord: StagingRecord = {
            key: env.key,
            entityType: 'edge',
            operation: 'upsert',
            payload: JSON.stringify(existing),
            lwwTimestamp: Date.now(),
            lwwDevice: 'local',
            lwwConfidence: 1,
            acked: true,
          };
          const resolution = resolveLWW(localRecord, remote);
          if (resolution.winner !== remote) conflicts++;
        }

        const applied = applyRemoteEdge(
          db,
          env.payload,
          remote.lwwTimestamp,
          remote.lwwDevice,
          env.deleted,
        );
        if (applied) pulled++;
      }
    }

    cursor = res.next_cursor;
  } while (res.has_more === true);

  state.cursor = res.next_cursor ?? state.cursor;
  state.lastPull = new Date().toISOString();
  saveSyncState(state);

  return { pulled, conflicts };
}

export async function runPush(ctx: SyncCycleContext): Promise<{ pushed: number; queued: boolean }> {
  const enc = makeEncrypt(ctx.passphrase, ctx.salt);
  const secretEnc = ctx.secretPassphrase
    ? makeSecretEncrypt(ctx.secretPassphrase, ctx.salt)
    : undefined;
  return pushCycle(ctx.client, ctx.store, ctx.state, ctx.deviceId, enc, secretEnc);
}

export async function runPull(ctx: SyncCycleContext): Promise<{ pulled: number; conflicts: number }> {
  const dec = makeDecrypt(ctx.passphrase, ctx.salt);
  const secretDec = ctx.secretPassphrase
    ? makeSecretDecrypt(ctx.secretPassphrase, ctx.salt)
    : undefined;
  return pullCycle(ctx.client, ctx.store, ctx.state, dec, secretDec);
}

export function buildSyncContext(
  store: TimStore,
  config: { serverUrl: string; token: string; salt: string; fileId: string },
  passphrase: string,
  deviceId: string,
  secretPassphrase?: string,
): SyncCycleContext {
  const state = loadSyncState() ?? {
    fileId: config.fileId,
    cursor: null,
    lastPush: null,
    lastPull: null,
  };
  state.fileId = config.fileId;
  return {
    client: new TimSyncClient(config.serverUrl, config.token),
    store,
    state,
    deviceId,
    passphrase,
    salt: config.salt,
    secretPassphrase,
  };
}
