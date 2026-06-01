import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Server } from 'node:http';
import { TimStore } from 'tim-store';
import { getUnackedStaging } from 'tim-store';
import {
  TimSyncClient,
  generateSalt,
  buildSyncContext,
  runPush,
  runPull,
  startDevServer,
  resetDevServer,
} from '../index.js';

describe('sync integration', () => {
  let server: Server;
  let dbPath: string;
  const deviceId = 'test-device-001';
  const fileId = `tim-${deviceId}`;
  const passphrase = 'integration-test';
  const salt = generateSalt();
  const port = 3199;

  beforeAll(async () => {
    resetDevServer();
    // Clear stale sync state from previous runs (causes pull to skip blobs)
    try { fs.unlinkSync(path.join(os.homedir(), '.tim', 'sync-state.json')); } catch {}
    server = startDevServer(port);
    await new Promise<void>((r) => server.once('listening', r));

    const client = new TimSyncClient(`http://127.0.0.1:${port}`, 'test-token');
    await client.createFile(fileId, salt);

    dbPath = path.join(os.tmpdir(), `tim-sync-int-${Date.now()}.db`);
  });

  afterAll(() => {
    server.close();
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  });

  it('push then pull restores entry on fresh DB', async () => {
    const store1 = new TimStore(dbPath);
    await store1.write('sync test entry', { confidence: 0.8 });
    expect(getUnackedStaging(store1.getDb()).length).toBeGreaterThan(0);

    const ctx1 = buildSyncContext(
      store1,
      {
        serverUrl: `http://127.0.0.1:${port}`,
        token: 'test-token',
        salt,
        fileId,
      },
      passphrase,
      deviceId,
    );
    const { pushed } = await runPush(ctx1);
    expect(pushed).toBeGreaterThan(0);
    store1.close();

    const dbPath2 = `${dbPath}.remote`;
    if (fs.existsSync(dbPath2)) fs.unlinkSync(dbPath2);
    const store2 = new TimStore(dbPath2);
    const ctx2 = buildSyncContext(
      store2,
      {
        serverUrl: `http://127.0.0.1:${port}`,
        token: 'test-token',
        salt,
        fileId,
      },
      passphrase,
      deviceId,
    );
    const { pulled } = await runPull(ctx2);
    expect(pulled).toBeGreaterThan(0);

    const stats = await store2.stats();
    expect(stats.totalEntries).toBeGreaterThan(0);
    store2.close();
    fs.unlinkSync(dbPath2);
  });
});
