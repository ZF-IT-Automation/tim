import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PushBlob } from './client.js';
import type { TimEnvelope } from './envelope.js';
import { insideSyncMutation, withSyncMutationSync } from './lock.js';
import { atomicWritePrivate, ensurePrivateDir } from './private-file.js';

export interface QueueItem {
  idempotency_key: string;
  envelopes: TimEnvelope[];
  blobs: PushBlob[];
  created_at: string;
  attempts: number;
  /** Staging rowids captured at enqueue. Aligned with envelopes. Absent on legacy items. */
  revisions?: number[];
  /** A single blob that cannot fit in a batch. Never retried. */
  disposition?: 'oversized';
}

export const PUSH_CHUNK = 500;
/** Under the hosted 10 MiB body limit, including JSON overhead. */
export const PUSH_BATCH_MAX_BYTES = 8 * 1024 * 1024;

const PUSH_BODY_OVERHEAD = {
  protocol_generation: 1,
  client_schema_major: 1,
  file_generation: 'g'.repeat(36),
  file_id: 'f'.repeat(64),
  idempotency_key: 'i'.repeat(36),
};

/** UTF-8 size of a push body. Counts encryption expansion and multibyte characters. */
export function serializedPushBytes(blobs: PushBlob[]): number {
  return Buffer.byteLength(JSON.stringify({ ...PUSH_BODY_OVERHEAD, blobs }), 'utf8');
}

export function queuedRevisions(items: QueueItem[]): Set<number> {
  const revisions = new Set<number>();
  for (const item of items) {
    for (const revision of item.revisions ?? []) {
      if (Number.isSafeInteger(revision) && revision > 0) revisions.add(revision);
    }
  }
  return revisions;
}

export function loadQueue(path: string): QueueItem[] {
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, 'utf8')) as QueueItem[];
}

function writeQueue(path: string, q: QueueItem[]): void {
  if (q.length === 0) {
    ensurePrivateDir(dirname(path));
    if (existsSync(path)) rmSync(path);
    return;
  }
  atomicWritePrivate(path, JSON.stringify(q));
}

function save(path: string, q: QueueItem[]): void {
  if (insideSyncMutation()) {
    writeQueue(path, q);
    return;
  }
  withSyncMutationSync(() => writeQueue(path, q));
}

export function saveQueue(path: string, items: QueueItem[]): void {
  save(path, items);
}

export interface EnqueueOptions {
  maxBytes?: number;
}

function makeItem(
  envelopes: TimEnvelope[],
  blobs: PushBlob[],
  revisions: number[] | undefined,
  disposition?: 'oversized',
): QueueItem {
  return {
    idempotency_key: randomUUID(),
    envelopes,
    blobs,
    ...(revisions ? { revisions } : {}),
    created_at: new Date().toISOString(),
    attempts: 0,
    ...(disposition ? { disposition } : {}),
  };
}

export function planQueueBatches(
  envelopes: TimEnvelope[],
  blobs: PushBlob[],
  revisions?: number[],
  maxBytes = PUSH_BATCH_MAX_BYTES,
): QueueItem[] {
  if (revisions && revisions.length !== blobs.length) {
    throw new Error(`Queue revisions (${revisions.length}) do not match blobs (${blobs.length})`);
  }
  const items: QueueItem[] = [];
  let batchEnv: TimEnvelope[] = [];
  let batchBlobs: PushBlob[] = [];
  let batchRev: number[] = [];

  const flush = (): void => {
    if (batchBlobs.length === 0) return;
    items.push(makeItem(
      batchEnv,
      batchBlobs,
      revisions ? batchRev : undefined,
    ));
    batchEnv = [];
    batchBlobs = [];
    batchRev = [];
  };

  for (let i = 0; i < blobs.length; i++) {
    const blob = blobs[i]!;
    const envelope = envelopes[i]!;
    const revision = revisions ? revisions[i]! : undefined;
    if (serializedPushBytes([blob]) > maxBytes) {
      flush();
      items.push(makeItem(
        [envelope],
        [blob],
        revisions ? [revision!] : undefined,
        'oversized',
      ));
      continue;
    }
    const candidate = serializedPushBytes([...batchBlobs, blob]);
    if (batchBlobs.length > 0 && (batchBlobs.length >= PUSH_CHUNK || candidate > maxBytes)) {
      flush();
    }
    batchEnv.push(envelope);
    batchBlobs.push(blob);
    if (revision !== undefined) batchRev.push(revision);
  }
  flush();
  return items;
}

export function enqueue(
  path: string,
  q: QueueItem[],
  envelopes: TimEnvelope[],
  blobs: PushBlob[],
  revisions?: number[],
  options?: EnqueueOptions,
): QueueItem[] {
  const created = planQueueBatches(envelopes, blobs, revisions, options?.maxBytes);
  q.push(...created);
  save(path, q);
  return created;
}

export async function flushQueue(
  path: string,
  q: QueueItem[],
  send: (item: QueueItem) => Promise<void>,
): Promise<{ ok: boolean; sent: QueueItem[] }> {
  const sent: QueueItem[] = [];
  const parked = q.filter((item) => item.disposition === 'oversized');
  const pending = q.filter((item) => item.disposition !== 'oversized');
  q.length = 0;
  q.push(...pending);
  while (q.length > 0) {
    const item = q[0]!;
    try {
      await send(item);
      q.shift();
      sent.push(item);
      save(path, [...q, ...parked]);
    } catch {
      item.attempts += 1;
      save(path, [...q, ...parked]);
      q.push(...parked);
      return { ok: false, sent };
    }
  }
  q.push(...parked);
  if (parked.length > 0) save(path, q);
  return { ok: true, sent };
}
