import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadQueue, enqueue, flushQueue, PUSH_CHUNK } from '../queue.js';
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
});
