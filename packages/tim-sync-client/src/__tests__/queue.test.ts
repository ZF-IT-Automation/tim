import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadQueue, enqueue, flushQueue, planQueueBatches, serializedPushBytes, PUSH_CHUNK } from '../queue.js';
import { deriveKey, encrypt } from '../crypto.js';
import type { TimEnvelope } from '../envelope.js';

describe('queue', () => {
  let queuePath: string;

  beforeEach(() => {
    queuePath = path.join(os.tmpdir(), `tim-queue-${Date.now()}.json`);
  });

  afterEach(() => {
    if (fs.existsSync(queuePath)) fs.unlinkSync(queuePath);
    if (fs.existsSync(`${queuePath}.tmp`)) fs.unlinkSync(`${queuePath}.tmp`);
  });

  it('chunks large pushes at 500', () => {
    const envelopes: TimEnvelope[] = [];
    const blobs = [];
    for (let i = 0; i < PUSH_CHUNK + 10; i++) {
      envelopes.push({
        v: 1, type: 'entry', key: `k${i}`, lww: new Date().toISOString(),
        deleted: false, payload: '{}',
      });
      blobs.push({
        proposed_id: `k${i}`,
        data: 'enc',
        device_id: 'dev',
        updated_at: new Date().toISOString(),
      });
    }
    const q = loadQueue(queuePath);
    enqueue(queuePath, q, envelopes, blobs);
    const loaded = loadQueue(queuePath);
    expect(loaded.length).toBe(2);
    expect(loaded[0].blobs.length).toBe(PUSH_CHUNK);
    expect(loaded[1].blobs.length).toBe(10);
  });

  it('flushQueue drains on success', async () => {
    const q = loadQueue(queuePath);
    const env: TimEnvelope = {
      v: 1, type: 'entry', key: 'a', lww: new Date().toISOString(),
      deleted: false, payload: '{}',
    };
    enqueue(queuePath, q, [env], [{
      proposed_id: 'a', data: 'x', device_id: 'd', updated_at: env.lww,
    }]);
    const loaded = loadQueue(queuePath);
    const sent: string[] = [];
    const result = await flushQueue(queuePath, loaded, async (item) => {
      sent.push(item.idempotency_key);
    });
    expect(result.ok).toBe(true);
    expect(sent.length).toBe(1);
    expect(loadQueue(queuePath).length).toBe(0);
  });

  it('splits on UTF-8 bytes and parks a record that cannot fit', () => {
    const envelope = (key: string): TimEnvelope => ({
      v: 1, type: 'entry', key, lww: new Date(1000).toISOString(), deleted: false, payload: '{}',
    });
    const blob = (key: string, data: string) => ({
      proposed_id: key,
      entity_key: key,
      entity_type: 'entry' as const,
      data,
      device_id: 'd',
      updated_at: new Date(1000).toISOString(),
    });
    const small = blob('k0', 'ü'.repeat(40));
    const limit = serializedPushBytes([small]);
    const split = planQueueBatches(
      [envelope('k0'), envelope('k1')],
      [small, blob('k1', 'ü'.repeat(40))],
      [11, 12],
      limit,
    );
    expect(split).toHaveLength(2);
    expect(split[0]!.revisions).toEqual([11]);
    expect(split[1]!.revisions).toEqual([12]);

    const cipher = encrypt('ü'.repeat(500), deriveKey('pass', 'salt'));
    const expanded = blob('k2', cipher);
    expect(Buffer.byteLength(cipher, 'utf8')).toBeGreaterThan(Buffer.byteLength('ü'.repeat(500), 'utf8'));
    const parked = planQueueBatches(
      [envelope('k2')],
      [expanded],
      [13],
      serializedPushBytes([blob('k2', 'x')]),
    );
    expect(parked[0]!.disposition).toBe('oversized');
    expect(parked[0]!.revisions).toEqual([13]);
    expect(parked[0]!.attempts).toBe(0);
  });
});
