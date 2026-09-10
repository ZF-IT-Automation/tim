import type { TimStore } from 'tim-store';
import {
  ackStaging,
  applyRemoteEntry,
  applyRemoteEdge,
  getUnackedStaging,
  isSecret,
  localEntryRecordFromRow,
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
import { randomUUID } from 'node:crypto';
import { enqueue, loadQueue, saveQueue, type QueueItem } from './queue.js';
import { MissingSecretPassphraseError } from './credentials.js';

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

function entryRequiresSecretPassphrase(
  db: ReturnType<TimStore['getDb']>,
  payloadJson: string,
  entryKey: string,
): boolean {
  if (payloadIsSecret(payloadJson)) return true;
  try {
    const payload = JSON.parse(payloadJson) as { id?: string };
    const id = payload.id ?? entryKey;
    return isSecret(db, id);
  } catch {
    return false;
  }
}

export const SECRET_PLACEHOLDER_TITLE = '🔒 [secret]';

export function isSecretPlaceholderPayload(payloadJson: string): boolean {
  try {
    const payload = JSON.parse(payloadJson) as {
      title?: string;
      content?: string;
      metadata?: unknown;
    };
    return (
      payload.title === SECRET_PLACEHOLDER_TITLE &&
      payload.content === '' &&
      parsePayloadMetadata(payload.metadata).secret === true
    );
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
  const rawMetadata = typeof payload.metadata_raw === 'string'
    ? payload.metadata_raw
    : typeof metaRaw === 'string'
      ? metaRaw
      : JSON.stringify(metaRaw ?? {});
  const encMeta = secretEncrypt(rawMetadata);
  const encryptedMetadata = JSON.stringify({ secret: true, _enc: encMeta });

  const encrypted = {
    ...payload,
    title: secretEncrypt(String(payload.title ?? '')),
    content: secretEncrypt(String(payload.content ?? '')),
    metadata: encryptedMetadata,
    metadata_raw: encryptedMetadata,
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

    const placeholderMetadata = JSON.stringify(
      enc !== undefined ? { secret: true, _enc: enc } : { secret: true },
    );
    const placeholder = {
      ...payload,
      title: '🔒 [secret]',
      content: '',
      metadata: placeholderMetadata,
      metadata_raw: placeholderMetadata,
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

  const fullMetadata = encBlob ? secretDecrypt(encBlob) : JSON.stringify({ secret: true });

  const decrypted = {
    ...payload,
    title: secretDecrypt(String(payload.title ?? '')),
    content: secretDecrypt(String(payload.content ?? '')),
    metadata: fullMetadata,
    metadata_raw: fullMetadata,
  };

  return JSON.stringify(decrypted);
}

function envelopeBlocksWithoutSecretKey(
  env: TimEnvelope,
  db: ReturnType<TimStore['getDb']>,
): boolean {
  if (env.type !== 'entry' || env.deleted) return false;
  if (isSecretPlaceholderPayload(env.payload)) return true;
  if (env.is_encrypted) return false;
  return entryRequiresSecretPassphrase(db, env.payload, env.key);
}

function transformEnvelopeForPush(
  env: TimEnvelope,
  secretEncrypt?: (data: string) => string,
  db?: ReturnType<TimStore['getDb']>,
): TimEnvelope {
  const needsSecret = db
    ? entryRequiresSecretPassphrase(db, env.payload, env.key)
    : payloadIsSecret(env.payload);
  if (
    !secretEncrypt
    || env.type !== 'entry'
    || env.deleted
    || env.is_encrypted
    || !needsSecret
  ) {
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

function blobForEnvelope(
  env: TimEnvelope,
  item: QueueItem,
  encryptFn: (data: string) => string,
  deviceId: string,
  reuseUnchanged: boolean,
): QueueItem['blobs'][number] {
  const orig = item.blobs.find((b) => b.proposed_id === env.key);
  // Legacy queue rows may store plaintext envelope JSON; only reuse blobs already
  // prepared for network (outer ciphertext differs from the envelope JSON).
  if (reuseUnchanged && orig && orig.data !== JSON.stringify(env)) return orig;
  return {
    proposed_id: env.key,
    data: encryptFn(JSON.stringify(env)),
    device_id: deviceId,
    updated_at: env.lww,
  };
}

function prepareQueueForPush(
  queue: QueueItem[],
  deviceId: string,
  encryptFn: (data: string) => string,
  db: ReturnType<TimStore['getDb']>,
  secretEncrypt?: (data: string) => string,
): { ready: QueueItem[]; remaining: QueueItem[]; blockedSecretCount: number } {
  const ready: QueueItem[] = [];
  const remaining: QueueItem[] = [];
  let blockedSecretCount = 0;

  for (const item of queue) {
    const sendEnvelopes: TimEnvelope[] = [];
    const blockEnvelopes: TimEnvelope[] = [];
    let payloadChanged = false;

    for (const env of item.envelopes) {
      if (!secretEncrypt && envelopeBlocksWithoutSecretKey(env, db)) {
        blockEnvelopes.push(env);
        blockedSecretCount++;
        continue;
      }

      const transformed = transformEnvelopeForPush(env, secretEncrypt, db);
      if (transformed.payload !== env.payload || transformed.is_encrypted !== env.is_encrypted) {
        payloadChanged = true;
      }
      sendEnvelopes.push(transformed);
    }

    const membershipChanged =
      sendEnvelopes.length !== item.envelopes.length
      || blockEnvelopes.length > 0;
    const needsFreshKey = payloadChanged || membershipChanged;
    const reuseBlobs = !payloadChanged && !membershipChanged;

    if (sendEnvelopes.length > 0) {
      ready.push({
        ...item,
        envelopes: sendEnvelopes,
        blobs: sendEnvelopes.map((e) => blobForEnvelope(e, item, encryptFn, deviceId, reuseBlobs)),
        idempotency_key: needsFreshKey ? randomUUID() : item.idempotency_key,
      });
    }

    if (blockEnvelopes.length > 0) {
      const origBlobByKey = new Map(item.blobs.map((b) => [b.proposed_id, b]));
      remaining.push({
        ...item,
        envelopes: blockEnvelopes,
        blobs: blockEnvelopes.map((e) => {
          const orig = origBlobByKey.get(e.key);
          return orig ?? {
            proposed_id: e.key,
            data: JSON.stringify(e),
            device_id: deviceId,
            updated_at: e.lww,
          };
        }),
        idempotency_key: membershipChanged ? randomUUID() : item.idempotency_key,
      });
    }
  }

  return { ready, remaining, blockedSecretCount };
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
  const allRows = getUnackedStaging(db);
  const placeholderKeys: Array<{ key: string; lww: number }> = [];
  let blockedSecretCount = 0;
  const rows = allRows.filter((row) => {
    if (row.entity_type === 'entry' && isSecretPlaceholderPayload(row.payload)) {
      placeholderKeys.push({ key: row.key, lww: row.lww_timestamp });
      return false;
    }
    if (row.entity_type === 'entry' && row.operation !== 'delete' && !secretEncrypt && entryRequiresSecretPassphrase(db, row.payload, row.key)) {
      blockedSecretCount++;
      return false;
    }
    return true;
  });
  const qPath = getQueuePath(state.fileId);
  let queue = loadQueue(qPath);
  let queueBlockedSecretCount = 0;

  if (rows.length > 0) {
    const envelopes = rows
      .map(stagingToEnvelope)
      .map((e) => transformEnvelopeForPush(e, secretEncrypt, db));
    const blobs = envelopes.map((e) => ({
      proposed_id: e.key,
      data: encryptFn(JSON.stringify(e)),
      device_id: deviceId,
      updated_at: e.lww,
    }));
    enqueue(qPath, queue, envelopes, blobs);
    queue = loadQueue(qPath);
  }

  const prepared = prepareQueueForPush(queue, deviceId, encryptFn, db, secretEncrypt);
  queueBlockedSecretCount = prepared.blockedSecretCount;
  const blockedRemaining = [...prepared.remaining];
  const readyToSend = [...prepared.ready];
  saveQueue(qPath, [...blockedRemaining, ...readyToSend]);

  const sent: QueueItem[] = [];
  let ok = true;
  while (readyToSend.length > 0) {
    const item = readyToSend[0];
    try {
      await client.push({
        file_id: state.fileId,
        idempotency_key: item.idempotency_key,
        client_schema_major: 1,
        blobs: item.blobs,
      });
      sent.push(item);
      readyToSend.shift();
      saveQueue(qPath, [...blockedRemaining, ...readyToSend]);
    } catch {
      item.attempts += 1;
      saveQueue(qPath, [...blockedRemaining, ...readyToSend]);
      ok = false;
      break;
    }
  }

  const unsentReady = readyToSend;

  const keysToAck: Array<{ key: string; lww: number }> = [...placeholderKeys];
  let pushedCount = 0;
  for (const item of sent) {
    for (const e of item.envelopes) {
      // Envelopes carry the timestamp as ISO; staging stores epoch millis.
      const lww = Date.parse(e.lww);
      keysToAck.push({ key: e.key, lww: Number.isFinite(lww) ? lww : Date.now() });
      pushedCount++;
    }
  }
  if (keysToAck.length > 0) ackStaging(db, keysToAck);

  state.lastPush = new Date().toISOString();
  saveSyncState(state);

  const totalBlocked = blockedSecretCount + queueBlockedSecretCount;
  if (totalBlocked > 0) {
    throw new MissingSecretPassphraseError(totalBlocked, pushedCount);
  }

  const queueLeft = blockedRemaining.length + unsentReady.length;
  return { pushed: pushedCount, queued: !ok || queueLeft > 0 };
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
            ...localEntryRecordFromRow(existing as Parameters<typeof localEntryRecordFromRow>[0]),
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
