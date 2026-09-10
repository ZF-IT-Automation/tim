import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Server } from 'node:http';
import { TimStore, getUnackedStaging } from 'tim-store';
import {
  TimSyncClient,
  generateSalt,
  buildSyncContext,
  runPush,
  startDevServer,
  resetDevServer,
  MissingSecretPassphraseError,
} from '../index.js';

const origHome = process.env.HOME;
let tmpHome: string;
beforeAll(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-inherited-secret-home-'));
  process.env.HOME = tmpHome;
});
afterAll(() => {
  process.env.HOME = origHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('inherited secret push boundary (#F8)', () => {
  let server: Server;
  const deviceId = 'inherited-secret-device';
  const fileId = `tim-${deviceId}`;
  const passphrase = 'sync-pass';
  const salt = generateSalt();
  const port = 3194;

  beforeAll(async () => {
    resetDevServer();
    server = startDevServer(port);
    await new Promise<void>(r => server.once('listening', r));
    const client = new TimSyncClient(`http://127.0.0.1:${port}`, 'test-token');
    await client.createFile(fileId, salt);
  });

  afterAll(() => {
    server.close();
  });

  function makeCtx(store: TimStore, client: TimSyncClient) {
    return {
      ...buildSyncContext(
        store,
        {
          serverUrl: `http://127.0.0.1:${port}`,
          token: 'test-token',
          salt,
          fileId,
        },
        passphrase,
        deviceId,
      ),
      client,
    };
  }

  it('blocks child push when parent was marked secret after child existed', async () => {
    const dbPath = path.join(os.tmpdir(), `tim-retro-secret-${Date.now()}.db`);
    const store = new TimStore(dbPath);
    const parent = await store.write('Parent section', { metadata: { kind: 'section' } });
    const child = await store.write('Child note', { parentId: parent.id });
    expect(child.metadata.secret).toBeUndefined();

    await store.update(parent.id, { metadata: { kind: 'section', secret: true } });

    const client = new TimSyncClient(`http://127.0.0.1:${port}`, 'test-token');
    const pushSpy = vi.spyOn(client, 'push');
    await expect(runPush(makeCtx(store, client))).rejects.toThrow(MissingSecretPassphraseError);
    expect(pushSpy).not.toHaveBeenCalled();
    expect(getUnackedStaging(store.getDb()).some(r => r.key === child.id)).toBe(true);

    store.close();
    fs.unlinkSync(dbPath);
  });

  it('still pushes edge rows touching secret entries (ids only, no content)', async () => {
    const dbPath = path.join(os.tmpdir(), `tim-secret-edge-${Date.now()}.db`);
    const store = new TimStore(dbPath);
    const secret = await store.write('Secret node', { id: 'SEC-EDGE', metadata: { secret: true } });
    const publicNode = await store.write('Public node', { id: 'PUB-EDGE' });
    await store.link(publicNode.id, secret.id, 'relates');

    const client = new TimSyncClient(`http://127.0.0.1:${port}`, 'test-token');
    const pushSpy = vi.spyOn(client, 'push').mockResolvedValue({ accepted: true });

    await expect(runPush(makeCtx(store, client))).rejects.toThrow(MissingSecretPassphraseError);
    expect(pushSpy).toHaveBeenCalled();
    const pushedKeys = pushSpy.mock.calls.flatMap(call =>
      (call[0].blobs ?? []).map(b => b.proposed_id),
    );
    expect(pushedKeys.some(k => k.includes('PUB-EDGE') && k.includes('SEC-EDGE'))).toBe(true);

    store.close();
    fs.unlinkSync(dbPath);
  });
});
