import { afterEach, describe, expect, it } from 'vitest';
import { fork, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TimStore } from '../store.js';

const WORKER = fileURLToPath(new URL('./helpers/edge-race-worker.mjs', import.meta.url));
const KEY = 'source|target|relates';

function waitFor(child: ChildProcess, type: 'ready' | 'calling' | 'done'): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), 8_000);
    const onMessage = (message: { type?: string; error?: string }) => {
      if (message.type === 'error') {
        clearTimeout(timer);
        child.off('message', onMessage);
        reject(new Error(message.error ?? 'worker error'));
        return;
      }
      if (message.type !== type) return;
      clearTimeout(timer);
      child.off('message', onMessage);
      resolve();
    };
    child.on('message', onMessage);
    child.once('error', reject);
  });
}

async function race(
  parent: TimStore,
  dbPath: string,
  cmd: { cmd: 'link' } | { cmd: 'unlink'; edgeId: string },
  whileBlocked: () => void,
): Promise<void> {
  const child = fork(WORKER, [], {
    env: { ...process.env, TIM_DB_PATH: dbPath },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  try {
    await waitFor(child, 'ready');
    parent.getDb().exec('BEGIN IMMEDIATE');
    child.send(cmd);
    await waitFor(child, 'calling');
    // The child flushes `calling` and then blocks in link/unlink. Hold the
    // lock across that gap so the pre-lock read cannot see this write.
    await new Promise(resolve => setTimeout(resolve, 250));
    try {
      whileBlocked();
      parent.getDb().exec('COMMIT');
    } catch (error) {
      try { parent.getDb().exec('ROLLBACK'); } catch { /* already finished */ }
      throw error;
    }
    await waitFor(child, 'done');
  } finally {
    child.kill();
  }
}

describe('two TimStore connections on one file', () => {
  const dirs: string[] = [];
  const stores: TimStore[] = [];
  afterEach(() => {
    stores.splice(0).forEach(store => store.close());
    dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true }));
  });

  it('a link blocked on the write lock stores a timestamp past the edge committed while it waited', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tim-edge-race-'));
    dirs.push(dir);
    const dbPath = join(dir, 'edges.db');
    const parent = new TimStore(dbPath, { deviceId: 'holder' });
    stores.push(parent);
    await parent.write('source', { id: 'source' });
    await parent.write('target', { id: 'target' });
    const future = Date.now() + 60_000;
    await race(parent, dbPath, { cmd: 'link' }, () => {
      parent.getDb().prepare(
        `INSERT INTO edges (id, source_id, target_id, type, weight, metadata, updated_at)
         VALUES ('winner', 'source', 'target', 'relates', 1, '{"from":"holder"}', ?)`,
      ).run(new Date(future).toISOString());
      parent.getDb().prepare(
        `INSERT INTO edge_versions (entity_key, payload, lww_timestamp, lww_device, deleted)
         VALUES (?, ?, ?, 'holder', 0)`,
      ).run(KEY, JSON.stringify({
        id: 'winner', source_id: 'source', target_id: 'target', type: 'relates', weight: 1, metadata: '{}',
      }), future);
    });
    const version = parent.getDb().prepare(
      'SELECT lww_timestamp FROM edge_versions WHERE entity_key = ?',
    ).get(KEY) as { lww_timestamp: number };
    expect(version.lww_timestamp).toBeGreaterThan(future);
  }, 15_000);

  it('unlink of a stale id does not delete the replacement row', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tim-edge-race-'));
    dirs.push(dir);
    const dbPath = join(dir, 'edges.db');
    const parent = new TimStore(dbPath, { deviceId: 'holder' });
    stores.push(parent);
    await parent.write('source', { id: 'source' });
    await parent.write('target', { id: 'target' });
    const created = await parent.link('source', 'target', 'relates');
    const future = Date.now() + 60_000;
    await race(parent, dbPath, { cmd: 'unlink', edgeId: created.id }, () => {
      parent.getDb().prepare('DELETE FROM edges WHERE id = ?').run(created.id);
      parent.getDb().prepare(
        `INSERT INTO edges (id, source_id, target_id, type, weight, metadata, updated_at)
         VALUES ('replacement', 'source', 'target', 'relates', 1, '{"from":"holder"}', ?)`,
      ).run(new Date(future).toISOString());
      parent.getDb().prepare(
        `UPDATE edge_versions SET payload = ?, lww_timestamp = ?, lww_device = 'holder', deleted = 0
         WHERE entity_key = ?`,
      ).run(JSON.stringify({
        id: 'replacement', source_id: 'source', target_id: 'target', type: 'relates', weight: 1, metadata: '{}',
      }), future, KEY);
    });
    expect(parent.getDb().prepare('SELECT id FROM edges').all()).toEqual([{ id: 'replacement' }]);
    expect(parent.getDb().prepare(
      'SELECT lww_timestamp, deleted FROM edge_versions WHERE entity_key = ?',
    ).get(KEY)).toEqual({ lww_timestamp: future, deleted: 0 });
  }, 15_000);
});
