import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Server } from 'node:http';
import { TimStore, getUnackedStaging } from 'tim-store';
import {
  TimSyncClient,
  generateSalt,
  autoPush,
  resetSyncCooldowns,
  _peekCooldown,
  startDevServer,
  resetDevServer,
} from '../index.js';

const origHome = process.env.HOME;
let tmpHome: string;
beforeAll(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-autopush-home-'));
  process.env.HOME = tmpHome;
});
afterAll(() => {
  process.env.HOME = origHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('autoPush partial secret block (#F3)', () => {
  let server: Server;
  const deviceId = 'autopush-partial-device';
  const fileId = `tim-${deviceId}`;
  const passphrase = 'sync-pass';
  const salt = generateSalt();
  const port = 3195;

  beforeAll(async () => {
    resetDevServer();
    server = startDevServer(port);
    await new Promise<void>(r => server.once('listening', r));
    const client = new TimSyncClient(`http://127.0.0.1:${port}`, 'test-token');
    await client.createFile(fileId, salt);

    const timDir = path.join(tmpHome, '.tim');
    fs.mkdirSync(timDir, { recursive: true });
    fs.writeFileSync(
      path.join(timDir, 'sync.json'),
      JSON.stringify({
        serverUrl: `http://127.0.0.1:${port}`,
        userId: 'u',
        token: 'test-token',
        salt,
        fileId,
      }),
    );
    fs.writeFileSync(
      path.join(timDir, 'sync-state.json'),
      JSON.stringify({ fileId, cursor: null, lastPush: null, lastPull: null }),
    );
  });

  afterAll(() => {
    server.close();
  });

  it('arms cooldown after partial push when secret rows remain blocked', async () => {
    const dbPath = path.join(os.tmpdir(), `tim-autopush-partial-${Date.now()}.db`);
    const store = new TimStore(dbPath);
    await store.write('public', { id: 'PUB-AUTO' });
    await store.write('secret', { id: 'SEC-AUTO', metadata: { secret: true } });

    const origSync = process.env.TIM_SYNC_PASSPHRASE;
    const origSecret = process.env.TIM_SECRET_PASSPHRASE;
    process.env.TIM_SYNC_PASSPHRASE = passphrase;
    delete process.env.TIM_SECRET_PASSPHRASE;
    resetSyncCooldowns();

    const first = await autoPush(store);
    expect(first.ran).toBe(true);
    expect(first.reason).toBe('partial-blocked');
    expect(first.pushed).toBe(1);
    expect(_peekCooldown('push')).toBeGreaterThan(0);
    expect(getUnackedStaging(store.getDb()).length).toBe(1);

    const second = await autoPush(store);
    expect(second.ran).toBe(false);
    expect(second.reason).toBe('cooldown');

    if (origSync === undefined) delete process.env.TIM_SYNC_PASSPHRASE;
    else process.env.TIM_SYNC_PASSPHRASE = origSync;
    if (origSecret === undefined) delete process.env.TIM_SECRET_PASSPHRASE;
    else process.env.TIM_SECRET_PASSPHRASE = origSecret;

    store.close();
    fs.unlinkSync(dbPath);
  });
});
