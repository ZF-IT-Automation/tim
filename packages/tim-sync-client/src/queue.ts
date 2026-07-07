import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PushBlob } from './client.js';
import type { TimEnvelope } from './envelope.js';

export interface QueueItem {
  idempotency_key: string;
  envelopes: TimEnvelope[];
  blobs: PushBlob[];
  created_at: string;
  attempts: number;
}

export const PUSH_CHUNK = 500;

export function loadQueue(path: string): QueueItem[] {
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, 'utf8')) as QueueItem[];
}

function save(path: string, q: QueueItem[]): void {
  if (q.length === 0) {
    if (existsSync(path)) rmSync(path);
    return;
  }
  const tmp = `${path}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(tmp, JSON.stringify(q));
  renameSync(tmp, path);
}

export function saveQueue(path: string, items: QueueItem[]): void {
  save(path, items);
}

export function enqueue(
  path: string,
  q: QueueItem[],
  envelopes: TimEnvelope[],
  blobs: PushBlob[],
): QueueItem[] {
  const created: QueueItem[] = [];
  for (let i = 0; i < blobs.length; i += PUSH_CHUNK) {
    const item: QueueItem = {
      idempotency_key: randomUUID(),
      envelopes: envelopes.slice(i, i + PUSH_CHUNK),
      blobs: blobs.slice(i, i + PUSH_CHUNK),
      created_at: new Date().toISOString(),
      attempts: 0,
    };
    q.push(item);
    created.push(item);
  }
  save(path, q);
  return created;
}

export async function flushQueue(
  path: string,
  q: QueueItem[],
  send: (item: QueueItem) => Promise<void>,
): Promise<{ ok: boolean; sent: QueueItem[] }> {
  const sent: QueueItem[] = [];
  while (q.length > 0) {
    const item = q[0];
    try {
      await send(item);
      q.shift();
      sent.push(item);
      save(path, q);
    } catch {
      item.attempts += 1;
      save(path, q);
      return { ok: false, sent };
    }
  }
  return { ok: true, sent };
}
