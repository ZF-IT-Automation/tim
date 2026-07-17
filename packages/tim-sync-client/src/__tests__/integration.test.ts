import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Server } from 'node:http';
import { ensureInboxProject, TimStore } from 'tim-store';
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

// Isolate ~/.tim (sync-state.json, queues) from the real home and from other
// test files — vitest runs each file in its own process, so the override is safe.
const origHome = process.env.HOME;
let tmpHome: string;
beforeAll(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-sync-int-home-'));
  process.env.HOME = tmpHome;
});
afterAll(() => {
  process.env.HOME = origHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

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

  it('preserves raw metadata tokens through push, pull, and remote apply', async () => {
    const rawFileId = `${fileId}-raw-metadata`;
    const client = new TimSyncClient(`http://127.0.0.1:${port}`, 'test-token');
    await client.createFile(rawFileId, salt);

    const sourcePath = `${dbPath}.raw-source`;
    const destinationPath = `${dbPath}.raw-destination`;
    const source = new TimStore(sourcePath);
    await source.write('Raw metadata Inbox', {
      id: 'P0000',
      metadata: { kind: 'note', label: 'N0000' },
    });
    source.getDb().prepare(`UPDATE entries SET metadata = ? WHERE id = 'P0000'`).run(
      '{"kind":"note","label":"N0000","pinned":1,"custom":{"big":9007199254740993,"negative_zero":-0}}',
    );
    source.getDb().prepare('DELETE FROM staging').run();
    await ensureInboxProject(source);

    const expectedMetadata =
      '{"kind":"project","label":"P0000","pinned":1,"custom":{"big":9007199254740993,"negative_zero":-0},"is_system":true,"render_depth":1}';
    const staged = getUnackedStaging(source.getDb());
    const stagedPayload = JSON.parse(staged[0]!.payload) as { metadata_raw?: string };
    const sourceContext = buildSyncContext(
      source,
      {
        serverUrl: `http://127.0.0.1:${port}`,
        token: 'test-token',
        salt,
        fileId: rawFileId,
      },
      passphrase,
      'raw-source-device',
    );
    await runPush(sourceContext);
    source.close();

    const destination = new TimStore(destinationPath);
    const destinationContext = buildSyncContext(
      destination,
      {
        serverUrl: `http://127.0.0.1:${port}`,
        token: 'test-token',
        salt,
        fileId: rawFileId,
      },
      passphrase,
      'raw-destination-device',
    );
    destinationContext.state.cursor = null;
    const { pulled } = await runPull(destinationContext);
    expect(pulled).toBeGreaterThan(0);

    const stored = destination.getDb().prepare(
      `SELECT metadata FROM entries WHERE id = 'P0000'`,
    ).get() as { metadata: string };
    expect(stored.metadata).toBe(expectedMetadata);
    expect(stagedPayload.metadata_raw).toBe(expectedMetadata);

    destination.close();
    fs.rmSync(sourcePath, { force: true });
    fs.rmSync(destinationPath, { force: true });
  });
});
