import type { TimStore } from 'tim-store';
import {
  ackStaging,
  applyRemoteEntry,
  applyRemoteEdge,
  getUnackedStaging,
  isSecret,
  localEntryRecordFromRow,
  localEdgeRecord,
  remoteEdgeWins,
} from 'tim-store';
import { SYNC_PROTOCOL_GENERATION, parseGenerationCursor, resolveLWW } from 'tim-core';
import { PERMANENT_SYNC_CODES, SyncApiError, TimSyncClient, type SyncCallOptions } from './client.js';
import { deriveKey, encrypt, decrypt } from './crypto.js';
import { stagingToEnvelope, envelopeToStaging, validatePulledEnvelope, type TimEnvelope } from './envelope.js';
import {
  getDeviceId,
  getQueuePath,
  loadBoundSyncState,
  saveSyncState,
  SyncStateRejectedError,
  type SyncState,
} from './config.js';
import { randomUUID } from 'node:crypto';
import { enqueue, loadQueue, queuedRevisions, saveQueue, PUSH_BATCH_MAX_BYTES, type QueueItem } from './queue.js';
import { MissingSecretPassphraseError } from './credentials.js';
import { SyncLockBusyError, syncDbIdentity, withSyncMutationAsync } from './lock.js';

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

type LockedSecretMetadata = { secret: true; _enc: string; _enc_v?: number };

function lockedSecretMetadata(payload: Record<string, unknown>): LockedSecretMetadata | undefined {
  const metadata = parsePayloadMetadata(payload.metadata) as Record<string, unknown>;
  if (metadata.secret !== true || typeof metadata._enc !== 'string' || !metadata._enc) return undefined;
  return {
    secret: true,
    _enc: metadata._enc,
    ...(typeof metadata._enc_v === 'number' ? { _enc_v: metadata._enc_v } : {}),
  };
}

/** Ciphertext marker, not display text, decides whether a payload is locked. */
export function isLockedSecretPayload(payloadJson: string): boolean {
  try {
    return lockedSecretMetadata(JSON.parse(payloadJson) as Record<string, unknown>) !== undefined;
  } catch {
    return false;
  }
}

export function isSecretPlaceholderPayload(payloadJson: string): boolean {
  return isLockedSecretPayload(payloadJson);
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
  const inner = JSON.stringify({
    v: 2,
    title: String(payload.title ?? ''),
    content: String(payload.content ?? ''),
    tags: typeof payload.tags === 'string' ? payload.tags : '[]',
    metadata: rawMetadata,
    metadata_raw: rawMetadata,
  });
  const encryptedMetadata = JSON.stringify({ secret: true, _enc_v: 2, _enc: secretEncrypt(inner) });

  const encrypted = {
    ...payload,
    title: SECRET_PLACEHOLDER_TITLE,
    content: '',
    tags: '[]',
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
  const lock = lockedSecretMetadata(payload);

  if (!secretDecrypt) {
    if (!lock) throw new Error('Encrypted secret payload has no ciphertext marker');
    const placeholderMetadata = JSON.stringify(lock);
    const placeholder = {
      ...payload,
      title: '🔒 [secret]',
      content: '',
      tags: '[]',
      metadata: placeholderMetadata,
      metadata_raw: placeholderMetadata,
    };
    return JSON.stringify(placeholder);
  }

  if (!lock) throw new Error('Encrypted secret payload has no ciphertext marker');
  if (lock._enc_v === 2) {
    const inner = JSON.parse(secretDecrypt(lock._enc)) as Record<string, unknown>;
    if (inner.v !== 2 || typeof inner.title !== 'string' || typeof inner.content !== 'string'
      || typeof inner.tags !== 'string' || typeof inner.metadata !== 'string'
      || typeof inner.metadata_raw !== 'string') {
      throw new Error('Malformed v2 secret payload');
    }
    return JSON.stringify({
      ...payload,
      title: inner.title,
      content: inner.content,
      tags: inner.tags,
      metadata: inner.metadata,
      metadata_raw: inner.metadata_raw,
    });
  }

  // v1 is migration input: title/content and metadata were encrypted separately.
  const fullMetadata = secretDecrypt(lock._enc);

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
  if (isLockedSecretPayload(env.payload)) return true;
  if (env.is_encrypted) return true;
  return entryRequiresSecretPassphrase(db, env.payload, env.key);
}

function transformEnvelopeForPush(
  env: TimEnvelope,
  secretEncrypt?: (data: string) => string,
  db?: ReturnType<TimStore['getDb']>,
): TimEnvelope {
  if (env.type === 'entry' && !env.deleted && isLockedSecretPayload(env.payload)) {
    // A queued locked payload is opaque. It may only travel as its preserved
    // ciphertext; runPush unlocks local rows before creating new envelopes.
    return { ...env, is_encrypted: true };
  }
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

/** Unlock locally retained shells before cursor-based pull so old pages recover too. */
export function unlockPersistedSecretEntries(
  store: TimStore,
  secretDecrypt: (data: string) => string,
): number {
  const db = store.getDb();
  const rows = db.prepare('SELECT * FROM entries WHERE metadata LIKE \'%"_enc"%\'').all() as Record<string, unknown>[];
  let unlocked = 0;
  const update = db.prepare(
    'UPDATE entries SET title=?, content=?, tags=?, metadata=? WHERE id=?',
  );
  db.transaction(() => {
    for (const row of rows) {
      const payload = JSON.stringify(row);
      if (!isLockedSecretPayload(payload)) continue;
      const decrypted = JSON.parse(decryptSecretPayload(payload, secretDecrypt)) as Record<string, unknown>;
      update.run(decrypted.title, decrypted.content, decrypted.tags, decrypted.metadata_raw, row.id);
      unlocked++;
    }
  })();
  return unlocked;
}

function blobForEnvelope(
  env: TimEnvelope,
  item: QueueItem,
  encryptFn: (data: string) => string,
  deviceId: string,
  reuseUnchanged: boolean,
): QueueItem['blobs'][number] {
  const orig = item.blobs.find((b) => b.proposed_id === env.key && b.entity_type === env.type);
  // Legacy queue rows may store plaintext envelope JSON; only reuse blobs already
  // prepared for network (outer ciphertext differs from the envelope JSON).
  if (reuseUnchanged && orig && orig.entity_type === env.type && orig.entity_key === env.key && orig.lww_device === env.device && orig.data !== JSON.stringify(env)) return orig;
  return {
    entity_type: env.type, entity_key: env.key, lww_device: env.device,
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
): { ready: QueueItem[]; remaining: QueueItem[]; parked: QueueItem[]; blockedSecretCount: number } {
  const ready: QueueItem[] = [];
  const remaining: QueueItem[] = [];
  const parked: QueueItem[] = [];
  let blockedSecretCount = 0;

  for (const item of queue) {
    if (item.disposition === 'oversized') {
      parked.push(item);
      continue;
    }
    const sendEnvelopes: TimEnvelope[] = [];
    const sendRevisions: number[] = [];
    const blockEnvelopes: TimEnvelope[] = [];
    const blockRevisions: number[] = [];
    let payloadChanged = false;
    const hasRevisions = Array.isArray(item.revisions);

    for (let i = 0; i < item.envelopes.length; i++) {
      const env = item.envelopes[i]!;
      const revision = item.revisions?.[i];
      if (!secretEncrypt && envelopeBlocksWithoutSecretKey(env, db)) {
        blockEnvelopes.push(env);
        if (hasRevisions && revision !== undefined) blockRevisions.push(revision);
        blockedSecretCount++;
        continue;
      }

      const transformed = transformEnvelopeForPush(env, secretEncrypt, db);
      if (transformed.payload !== env.payload || transformed.is_encrypted !== env.is_encrypted) {
        payloadChanged = true;
      }
      sendEnvelopes.push(transformed);
      if (hasRevisions && revision !== undefined) sendRevisions.push(revision);
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
        revisions: hasRevisions ? sendRevisions : item.revisions,
        idempotency_key: needsFreshKey ? randomUUID() : item.idempotency_key,
      });
    }

    if (blockEnvelopes.length > 0) {
      const origBlobByKey = new Map(item.blobs.map((b) => [`${b.entity_type}:${b.proposed_id}`, b]));
      remaining.push({
        ...item,
        envelopes: blockEnvelopes,
        blobs: blockEnvelopes.map((e) => {
          const orig = origBlobByKey.get(`${e.type}:${e.key}`);
          return orig ?? {
            entity_type: e.type, entity_key: e.key, lww_device: e.device,
            proposed_id: e.key,
            data: JSON.stringify(e),
            device_id: deviceId,
            updated_at: e.lww,
          };
        }),
        revisions: hasRevisions ? blockRevisions : item.revisions,
        // A blocked item has not changed its sendable version. Preserve its
        // idempotency key and ciphertext exactly until a key can unlock it.
        idempotency_key: item.idempotency_key,
      });
    }
  }

  return { ready, remaining, parked, blockedSecretCount };
}

export interface SyncCycleOptions {
  deadlineAt?: number;
  maxBytes?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface PushCycleResult {
  pushed: number;
  queued: boolean;
  complete: boolean;
  permanent: boolean;
  errorCode: string | null;
  oversized: Array<{ revision: number; key: string }>;
}

const MAX_RATE_LIMIT_RETRIES = 8;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function pastDeadline(deadlineAt: number | undefined): boolean {
  return deadlineAt !== undefined && Date.now() >= deadlineAt;
}

export function syncCycleExitCode(result: { complete: boolean; permanent: boolean }): number {
  if (result.permanent) return 3;
  if (!result.complete) return 2;
  return 0;
}

export function thrownSyncExitCode(err: unknown): number {
  if (err instanceof SyncLockBusyError) return 2;
  if (err instanceof SyncStateRejectedError || err instanceof MissingSecretPassphraseError) return 1;
  if (err instanceof SyncApiError && PERMANENT_SYNC_CODES.has(err.code)) return 3;
  if (err instanceof SyncApiError) return 2;
  return 1;
}

export async function pushCycle(
  client: TimSyncClient,
  store: TimStore,
  state: SyncState,
  deviceId: string,
  encryptFn: (data: string) => string,
  secretEncrypt?: (data: string) => string,
  options?: SyncCycleOptions,
): Promise<PushCycleResult> {
  return withSyncMutationAsync(() => pushCycleUnlocked(
    client, store, state, deviceId, encryptFn, secretEncrypt, options,
  ), options?.deadlineAt);
}

async function pushCycleUnlocked(
  client: TimSyncClient,
  store: TimStore,
  state: SyncState,
  deviceId: string,
  encryptFn: (data: string) => string,
  secretEncrypt: ((data: string) => string) | undefined,
  options: SyncCycleOptions | undefined,
): Promise<PushCycleResult> {
  const db = store.getDb();
  const deadlineAt = options?.deadlineAt;
  const allRows = getUnackedStaging(db);
  let blockedSecretCount = 0;
  const rows = allRows.filter((row) => {
    if (row.entity_type === 'entry' && isLockedSecretPayload(row.payload) && !secretEncrypt) {
      blockedSecretCount++;
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
  const alreadyQueued = queuedRevisions(queue);
  const fresh = rows.filter((row) => !alreadyQueued.has(row.rowid));
  let queueBlockedSecretCount = 0;

  if (fresh.length > 0) {
    const envelopes = fresh
      .map(stagingToEnvelope)
      .map((e) => transformEnvelopeForPush(e, secretEncrypt, db));
    const blobs = envelopes.map((e) => ({
      entity_type: e.type, entity_key: e.key, lww_device: e.device,
      proposed_id: e.key,
      data: encryptFn(JSON.stringify(e)),
      device_id: deviceId,
      updated_at: e.lww,
    }));
    enqueue(qPath, queue, envelopes, blobs, fresh.map((row) => row.rowid), {
      maxBytes: options?.maxBytes ?? PUSH_BATCH_MAX_BYTES,
    });
    queue = loadQueue(qPath);
  }

  const prepared = prepareQueueForPush(queue, deviceId, encryptFn, db, secretEncrypt);
  queueBlockedSecretCount = prepared.blockedSecretCount;
  const parked = [...prepared.parked];
  const blockedRemaining = [...prepared.remaining];
  const readyToSend = [...prepared.ready];
  saveQueue(qPath, [...parked, ...blockedRemaining, ...readyToSend]);

  let ok = true;
  let permanent = false;
  let pushError: string | null = null;
  let pushedCount = 0;
  let rateLimits = 0;
  const sleep = options?.sleep ?? defaultSleep;
  const call: SyncCallOptions = { deadlineAt };

  while (readyToSend.length > 0) {
    if (pastDeadline(deadlineAt)) {
      ok = false;
      pushError = 'DEADLINE';
      break;
    }
    const item = readyToSend[0]!;
    try {
      await bindFileGeneration(client, state, deadlineAt);
      await client.push({
        file_id: state.fileId,
        file_generation: state.fileGeneration,
        protocol_generation: SYNC_PROTOCOL_GENERATION,
        idempotency_key: item.idempotency_key,
        client_schema_major: SYNC_PROTOCOL_GENERATION,
        blobs: item.blobs,
      }, call);
      const revisions = (item.revisions ?? []).filter((revision) => (
        Number.isSafeInteger(revision) && revision > 0
      ));
      if (revisions.length > 0) ackStaging(db, revisions);
      pushedCount += item.envelopes.length;
      readyToSend.shift();
      saveQueue(qPath, [...parked, ...blockedRemaining, ...readyToSend]);
    } catch (err) {
      if (err instanceof SyncApiError && err.code === 'RATE_LIMITED') {
        rateLimits += 1;
        const wait = err.retryAfterMs ?? 1000;
        const wouldPassDeadline = deadlineAt !== undefined && Date.now() + wait > deadlineAt;
        if (rateLimits > MAX_RATE_LIMIT_RETRIES || wouldPassDeadline) {
          ok = false;
          pushError = wouldPassDeadline ? 'DEADLINE' : 'RATE_LIMITED';
          break;
        }
        await sleep(wait);
        continue;
      }
      if (err instanceof SyncApiError && PERMANENT_SYNC_CODES.has(err.code)) {
        ok = false;
        permanent = true;
        pushError = formatSyncFailure(err);
        break;
      }
      if (!(err instanceof SyncApiError && err.code === 'DEADLINE')) {
        item.attempts += 1;
      }
      saveQueue(qPath, [...parked, ...blockedRemaining, ...readyToSend]);
      ok = false;
      pushError = err instanceof SyncApiError && err.code === 'DEADLINE'
        ? 'DEADLINE'
        : formatSyncFailure(err);
      break;
    }
  }

  const partialSend = !ok || readyToSend.length > 0;
  const now = new Date().toISOString();
  state.lastPushAttempt = now;
  if (!partialSend) {
    state.lastPush = now;
    state.lastPushError = null;
  } else {
    state.lastPushError = pushError ?? 'PARTIAL_SEND';
  }
  saveSyncState(state);

  const totalBlocked = blockedSecretCount + queueBlockedSecretCount;
  if (totalBlocked > 0) {
    throw new MissingSecretPassphraseError(totalBlocked, pushedCount);
  }

  const oversized = parked.flatMap((item) => item.envelopes.map((envelope, index) => ({
    revision: item.revisions?.[index] ?? 0,
    key: envelope.key,
  })));
  return {
    pushed: pushedCount,
    queued: !ok || blockedRemaining.length + readyToSend.length > 0,
    complete: ok && readyToSend.length === 0 && !permanent,
    permanent,
    errorCode: pushError,
    oversized,
  };
}


async function bindFileGeneration(
  client: TimSyncClient,
  state: SyncState,
  deadlineAt?: number,
): Promise<void> {
  if (state.fileGeneration) return;
  if (state.cursor) throw new SyncApiError('Cursor has no bound file generation; explicit reconciliation required','PROTOCOL_MISMATCH');
  const generation = await client.fileGeneration(state.fileId, { deadlineAt });
  const next = { ...state, fileGeneration: generation };
  saveSyncState(next);
  Object.assign(state, next);
}

export async function pullCycle(
  client: TimSyncClient, store: TimStore, state: SyncState,
  decryptFn: (data: string) => string, secretDecrypt?: (data: string) => string,
  deviceId = getDeviceId(),
  options?: SyncCycleOptions,
): Promise<{ pulled: number; conflicts: number }> {
  return withSyncMutationAsync(() => pullCycleUnlocked(
    client, store, state, decryptFn, secretDecrypt, deviceId, options,
  ), options?.deadlineAt);
}

async function pullCycleUnlocked(
  client: TimSyncClient, store: TimStore, state: SyncState,
  decryptFn: (data: string) => string, secretDecrypt: ((data: string) => string) | undefined,
  deviceId: string,
  options: SyncCycleOptions | undefined,
): Promise<{ pulled: number; conflicts: number }> {
  const db = store.getDb();
  const deadlineAt = options?.deadlineAt;
  const call: SyncCallOptions = { deadlineAt };
  let pulled = 0; let conflicts = 0;
  try {
    if (secretDecrypt) unlockPersistedSecretEntries(store, secretDecrypt);
    if (pastDeadline(deadlineAt)) throw new SyncApiError('Deadline exceeded', 'DEADLINE');
    await bindFileGeneration(client, state, deadlineAt);
    const generation = state.fileGeneration!;
    db.pragma('synchronous = FULL');
    // A previous cycle may have persisted the cursor and crashed before its ACK.
    if (state.cursor) await client.ack(state.fileId, generation, deviceId, state.cursor, call);
    let more: boolean;
    do {
      if (pastDeadline(deadlineAt)) throw new SyncApiError('Deadline exceeded', 'DEADLINE');
      const res = await client.pull(state.fileId, state.cursor ?? undefined, SYNC_PROTOCOL_GENERATION, generation, deviceId, call);
      const counts = db.transaction(() => {
        let appliedCount = 0; let conflictCount = 0;
        for (const blob of res.blobs) {
          let env: unknown = JSON.parse(decryptFn(blob.data));
          validatePulledEnvelope(env,blob);
          env = transformEnvelopeForPull(env,secretDecrypt);
          const envelope = env as TimEnvelope;
          const remote = envelopeToStaging(envelope,blob.lww_device!);
          const local = envelope.type === 'edge' ? localEdgeRecord(db,envelope.key) : (() => {
            const row = db.prepare('SELECT * FROM entries WHERE id=?').get(envelope.key) as
              Parameters<typeof localEntryRecordFromRow>[0] | undefined;
            return row ? localEntryRecordFromRow(row) : undefined;
          })();
          const remoteWins = envelope.type === 'edge'
            ? remoteEdgeWins(local, remote)
            : !local || resolveLWW(local, remote).winner === remote;
          if (!remoteWins) conflictCount++;
          const apply = envelope.type === 'entry' ? applyRemoteEntry : applyRemoteEdge;
          if (apply(db,envelope.payload,remote.lwwTimestamp,remote.lwwDevice,envelope.deleted)) appliedCount++;
        }
        return { appliedCount, conflictCount };
      })();
      if (state.cursor) {
        const before = parseGenerationCursor(state.cursor, generation);
        const after = parseGenerationCursor(res.next_cursor, generation);
        if (after < before) throw new SyncApiError('Cursor moved backwards', 'PROTOCOL_MISMATCH');
      }
      const next = { ...state, cursor: res.next_cursor };
      saveSyncState(next);
      Object.assign(state, next);
      await client.ack(state.fileId, generation, deviceId, res.next_cursor, call);
      pulled += counts.appliedCount; conflicts += counts.conflictCount;
      more = res.has_more;
    } while (more);
    const now = new Date().toISOString();
    state.lastPullAttempt = now; state.lastPull = now; state.lastPullError = null;
    saveSyncState(state);
    return { pulled, conflicts };
  } catch (err) {
    state.lastPullAttempt = new Date().toISOString(); state.lastPullError = formatSyncFailure(err);
    saveSyncState(state);
    throw err;
  }
}

export function formatSyncFailure(err: unknown): string {
  if (err instanceof SyncApiError) {
    return err.status === undefined ? err.code : `${err.code} (${err.status})`;
  }
  const error = err as { name?: string; message?: string };
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return 'TIMEOUT';
  if (typeof error?.message === 'string' && /timeout|aborted/i.test(error.message)) return 'TIMEOUT';
  return 'REQUEST_FAILED';
}

function reloadBoundState(ctx: SyncCycleContext): SyncState {
  return loadBoundSyncState({
    serverUrl: ctx.state.serverUrl ?? '',
    userId: ctx.state.tenantId ?? '',
    token: '',
    salt: ctx.salt,
    fileId: ctx.state.fileId,
  }, syncDbIdentity(ctx.store.getDatabasePath()));
}

export async function runPush(
  ctx: SyncCycleContext,
  options?: SyncCycleOptions,
): Promise<PushCycleResult> {
  const enc = makeEncrypt(ctx.passphrase, ctx.salt);
  const secretEnc = ctx.secretPassphrase
    ? makeSecretEncrypt(ctx.secretPassphrase, ctx.salt)
    : undefined;
  const secretDec = ctx.secretPassphrase
    ? makeSecretDecrypt(ctx.secretPassphrase, ctx.salt)
    : undefined;
  return withSyncMutationAsync(async () => {
    ctx.state = reloadBoundState(ctx);
    if (secretDec) unlockPersistedSecretEntries(ctx.store, secretDec);
    return pushCycleUnlocked(
      ctx.client, ctx.store, ctx.state, ctx.deviceId, enc, secretEnc, options,
    );
  }, options?.deadlineAt);
}

export async function runPull(
  ctx: SyncCycleContext,
  options?: SyncCycleOptions,
): Promise<{ pulled: number; conflicts: number }> {
  const dec = makeDecrypt(ctx.passphrase, ctx.salt);
  const secretDec = ctx.secretPassphrase
    ? makeSecretDecrypt(ctx.secretPassphrase, ctx.salt)
    : undefined;
  return withSyncMutationAsync(async () => {
    ctx.state = reloadBoundState(ctx);
    if (secretDec) unlockPersistedSecretEntries(ctx.store, secretDec);
    return pullCycleUnlocked(
      ctx.client, ctx.store, ctx.state, dec, secretDec, ctx.deviceId, options,
    );
  }, options?.deadlineAt);
}

export function buildSyncContext(
  store: TimStore,
  config: { serverUrl: string; userId: string; token: string; salt: string; fileId: string },
  passphrase: string,
  deviceId: string,
  secretPassphrase?: string,
): SyncCycleContext {
  const state = loadBoundSyncState(config, store.getDatabasePath());
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
