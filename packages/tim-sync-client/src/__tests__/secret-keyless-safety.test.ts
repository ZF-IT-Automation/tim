import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TimStore } from 'tim-store';
import { startHostedSyncServer, type HostedServerHandle } from '../../../tim-sync-server/src/server.js';
import {
  buildSyncContext,
  clearSyncState,
  generateSalt,
  runPull,
  runPush,
  TimSyncClient,
} from '../index.js';
import { loadBoundSyncState } from '../config.js';

let root: string;
let home: string;
let previousHome: string | undefined;
let server: HostedServerHandle | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tim-secret-hosted-'));
  home = mkdtempSync(join(tmpdir(), 'tim-secret-home-'));
  previousHome = process.env.HOME;
  process.env.HOME = home;
});

afterEach(async () => {
  if (server) await server.close();
  server = undefined;
  process.env.HOME = previousHome;
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

it('keyless hosted client retains v2 ciphertext, cannot edit it, then unlocks after cursor passed', async () => {
  server = await startHostedSyncServer({ port: 0, dataDir: root });
  const tenant = server.registry.register('free');
  const fileId = 'secret-keyless-file';
  const salt = generateSalt();
  const passphrase = 'outer-test-key';
  const secretPassphrase = 'inner-test-key';
  const client = new TimSyncClient(`http://127.0.0.1:${server.port}`, tenant.token);
  await client.createFile(fileId, salt);
  const config = {
    serverUrl: `http://127.0.0.1:${server.port}`,
    userId: tenant.id,
    token: tenant.token,
    salt,
    fileId,
  };

  const writer = new TimStore(join(root, 'writer.db'));
  const parent = await writer.write('private parent body', {
    id: 'SECRET-PARENT', title: 'private parent title', tags: ['#private-parent'], metadata: { secret: true, kind: 'note' },
  });
  await writer.write('private child body', {
    id: 'SECRET-CHILD', parentId: parent.id, title: 'private child title', tags: ['#private-child'], metadata: { kind: 'note' },
  });
  await runPush(buildSyncContext(writer, config, passphrase, 'writer', secretPassphrase));
  writer.close();

  clearSyncState();
  const keyless = new TimStore(join(root, 'keyless.db'));
  const keylessCtx = buildSyncContext(keyless, config, passphrase, 'keyless');
  await runPull(keylessCtx);
  const locked = await keyless.read('SECRET-CHILD');
  const lockedParent = await keyless.read('SECRET-PARENT');
  expect(locked).not.toBeNull();
  expect(lockedParent).not.toBeNull();
  expect(lockedParent!.title).not.toContain('private parent title');
  expect(lockedParent!.tags).toEqual([]);
  expect(locked!.title).not.toContain('private child title');
  expect(locked!.content).toBe('');
  expect(locked!.tags).toEqual([]);
  expect(locked!.metadata).toMatchObject({ secret: true });
  expect(locked!.metadata.kind).toBeUndefined();
  await expect(keyless.update(locked!.id, { title: 'replacement' })).rejects.toThrow(/locked secret/i);
  expect(() => keyless.curate().tagAdd(locked!.id, ['#leak'])).toThrow(/locked secret/i);

  const cursorBeforeWrongKey = loadBoundSyncState(config, keyless.getDatabasePath()).cursor;
  await expect(runPull(buildSyncContext(keyless, config, passphrase, 'keyless', 'wrong-inner-key')))
    .rejects.toThrow();
  expect(loadBoundSyncState(config, keyless.getDatabasePath()).cursor).toBe(cursorBeforeWrongKey);

  await runPull(buildSyncContext(keyless, config, passphrase, 'keyless', secretPassphrase));
  const restored = await keyless.read('SECRET-CHILD');
  expect(restored).not.toBeNull();
  expect(restored!.title).toBe('private child title');
  expect(restored!.content).toBe('private child body');
  expect(restored!.tags).toEqual(['#private-child']);
  expect(restored!.metadata.kind).toBe('note');
  keyless.close();
});
