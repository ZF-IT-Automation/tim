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
import { stagingToEnvelope, envelopeToStaging } from './envelope.js';
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
}

function makeEncrypt(passphrase: string, salt: string): (data: string) => string {
  const key = deriveKey(passphrase, salt);
  return (data: string) => encrypt(data, key);
}

function makeDecrypt(passphrase: string, salt: string): (data: string) => string {
  const key = deriveKey(passphrase, salt);
  return (data: string) => decrypt(data, key);
}

export async function pushCycle(
  client: TimSyncClient,
  store: TimStore,
  state: SyncState,
  deviceId: string,
  encryptFn: (data: string) => string,
): Promise<{ pushed: number; queued: boolean }> {
  const db = store.getDb();
  const rows = getUnackedStaging(db);
  const qPath = getQueuePath(state.fileId);
  let queue = loadQueue(qPath);

  if (rows.length > 0) {
    const envelopes = rows.map(stagingToEnvelope);
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
      const env = JSON.parse(decryptFn(blob.data)) as ReturnType<typeof stagingToEnvelope>;
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
  return pushCycle(ctx.client, ctx.store, ctx.state, ctx.deviceId, enc);
}

export async function runPull(ctx: SyncCycleContext): Promise<{ pulled: number; conflicts: number }> {
  const dec = makeDecrypt(ctx.passphrase, ctx.salt);
  return pullCycle(ctx.client, ctx.store, ctx.state, dec);
}

export function buildSyncContext(
  store: TimStore,
  config: { serverUrl: string; token: string; salt: string; fileId: string },
  passphrase: string,
  deviceId: string,
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
  };
}
