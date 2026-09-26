import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TimStore } from 'tim-store';
import { startHostedSyncServer, type HostedServerHandle } from '../../../tim-sync-server/src/server.js';
import {
  buildSyncContext,
  clearSyncState,
  deriveKey,
  encrypt,
  encryptSecretPayload,
  generateSalt,
  runPull,
  runPush,
  runSyncOwner,
  SecretUndecryptableError,
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
  const keylessState = readFileSync(join(home, '.tim', 'sync-state.json'), 'utf8');
  clearSyncState();
  const writerAgain = new TimStore(join(root, 'writer.db'));
  await writerAgain.write('second private body', {
    id: 'SECRET-LATER', title: 'second private title', metadata: { secret: true },
  });
  await runPush(buildSyncContext(writerAgain, config, passphrase, 'writer', secretPassphrase));
  writerAgain.close();
  writeFileSync(join(home, '.tim', 'sync-state.json'), keylessState);
  await expect(runPull(buildSyncContext(keyless, config, passphrase, 'keyless', 'wrong-inner-key')))
    .rejects.toThrow('Secret passphrase cannot decrypt locked entries');
  const afterWrongKey = loadBoundSyncState(config, keyless.getDatabasePath());
  expect(afterWrongKey.cursor).toBe(cursorBeforeWrongKey);
  expect(afterWrongKey.lastPullError).toBe('Secret passphrase cannot decrypt locked entries');
  expect(await keyless.read('SECRET-LATER')).toBeNull();

  await runPull(buildSyncContext(keyless, config, passphrase, 'keyless', secretPassphrase));
  const restored = await keyless.read('SECRET-CHILD');
  expect(restored).not.toBeNull();
  expect(restored!.title).toBe('private child title');
  expect(restored!.content).toBe('private child body');
  expect(restored!.tags).toEqual(['#private-child']);
  expect(restored!.metadata.kind).toBe('note');
  keyless.close();
});

it('wrong secret key on a fresh database leaves page cursor and entry unchanged', async () => {
  server = await startHostedSyncServer({ port: 0, dataDir: root });
  const tenant = server.registry.register('free');
  const salt = generateSalt();
  const config = { serverUrl: `http://127.0.0.1:${server.port}`, userId: tenant.id, token: tenant.token, salt, fileId: 'fresh-wrong-key' };
  const client = new TimSyncClient(config.serverUrl, config.token);
  await client.createFile(config.fileId, salt);
  const writer = new TimStore(join(root, 'writer.db'));
  await writer.write('private body', { id: 'PAGE-SECRET', title: 'private title', metadata: { secret: true } });
  await runPush(buildSyncContext(writer, config, 'outer', 'writer', 'right-inner'));
  writer.close();

  clearSyncState();
  const receiver = new TimStore(join(root, 'fresh.db'));
  await expect(runPull(buildSyncContext(receiver, config, 'outer', 'receiver', 'wrong-inner')))
    .rejects.toThrow('Secret passphrase cannot decrypt locked entries');
  const state = loadBoundSyncState(config, receiver.getDatabasePath());
  expect(state.cursor).toBeNull();
  expect(await receiver.read('PAGE-SECRET')).toBeNull();
  receiver.close();
});

it('owner pulls after a missing secret passphrase push result', async () => {
  server = await startHostedSyncServer({ port: 0, dataDir: root });
  const tenant = server.registry.register('free');
  const salt = generateSalt();
  const config = { serverUrl: `http://127.0.0.1:${server.port}`, userId: tenant.id, token: tenant.token, salt, fileId: 'owner-missing-secret' };
  const client = new TimSyncClient(config.serverUrl, config.token);
  await client.createFile(config.fileId, salt);
  const remote = new TimStore(join(root, 'remote.db'));
  await remote.write('public body', { id: 'REMOTE-PUBLIC', title: 'public title' });
  await runPush(buildSyncContext(remote, config, 'outer', 'remote'));
  remote.close();

  clearSyncState();
  const owner = new TimStore(join(root, 'owner.db'));
  await owner.write('private body', { id: 'LOCAL-SECRET', metadata: { secret: true } });
  const result = await runSyncOwner({ store: owner, config, passphrase: 'outer', deviceId: 'owner', once: true, sleep: async () => undefined });
  expect(result.push?.errorCode).toBe('SECRET_KEY_REQUIRED');
  expect(result.pull?.complete).toBe(true);
  expect(await owner.read('REMOTE-PUBLIC')).not.toBeNull();
  owner.close();
});

it('owner treats pull-side wrong secret key as permanent', async () => {
  server = await startHostedSyncServer({ port: 0, dataDir: root });
  const tenant = server.registry.register('free');
  const salt = generateSalt();
  const config = { serverUrl: `http://127.0.0.1:${server.port}`, userId: tenant.id, token: tenant.token, salt, fileId: 'owner-wrong-secret' };
  const client = new TimSyncClient(config.serverUrl, config.token);
  await client.createFile(config.fileId, salt);
  const writer = new TimStore(join(root, 'writer.db'));
  await writer.write('private body', { id: 'OWNER-SECRET', metadata: { secret: true } });
  await runPush(buildSyncContext(writer, config, 'outer', 'writer', 'right-inner'));
  writer.close();

  clearSyncState();
  const owner = new TimStore(join(root, 'owner.db'));
  const result = await runSyncOwner({ store: owner, config, passphrase: 'outer', secretPassphrase: 'wrong-inner', deviceId: 'owner', once: true, sleep: async () => undefined });
  expect(result.exitCode).toBe(3);
  expect(result.pull).toMatchObject({ permanent: true, errorCode: 'Secret passphrase cannot decrypt locked entries' });
  owner.close();
});

it('malformed secret blob is permanent and identifies its blob id', async () => {
  server = await startHostedSyncServer({ port: 0, dataDir: root });
  const tenant = server.registry.register('free');
  const salt = generateSalt();
  const config = { serverUrl: `http://127.0.0.1:${server.port}`, userId: tenant.id, token: tenant.token, salt, fileId: 'malformed-secret' };
  const client = new TimSyncClient(config.serverUrl, config.token);
  const file = await client.createFile(config.fileId, salt);
  const source = new TimStore(join(root, 'source.db'));
  await source.write('private body', { id: 'MALFORMED-SECRET', title: 'private title', metadata: { secret: true } });
  const payload = JSON.stringify(source.getDb().prepare('SELECT * FROM entries WHERE id=?').get('MALFORMED-SECRET'));
  source.close();
  const innerKey = deriveKey('inner', salt);
  const outerKey = deriveKey('outer', salt);
  const secretPayload = encryptSecretPayload(payload, () => encrypt('not-json', innerKey));
  const updatedAt = '2026-09-01T00:00:00.000Z';
  const envelope = { v: 1, type: 'entry' as const, key: 'MALFORMED-SECRET', lww: updatedAt, device: 'writer', deleted: false, payload: secretPayload, is_encrypted: true };
  await client.push({
    file_id: config.fileId, file_generation: file.generation, protocol_generation: 1, client_schema_major: 1, idempotency_key: 'malformed-secret',
    blobs: [{ proposed_id: 'MALFORMED-SECRET', entity_key: 'MALFORMED-SECRET', entity_type: 'entry', lww_device: 'writer', data: encrypt(JSON.stringify(envelope), outerKey), device_id: 'writer', updated_at: updatedAt }],
  });

  clearSyncState();
  const receiver = new TimStore(join(root, 'receiver.db'));
  await expect(runPull(buildSyncContext(receiver, config, 'outer', 'receiver', 'inner')))
    .rejects.toBeInstanceOf(SecretUndecryptableError);
  const state = loadBoundSyncState(config, receiver.getDatabasePath());
  expect(state.cursor).toBeNull();
  expect(state.lastPullError).toMatch(/^SECRET_UNDECRYPTABLE blob \d+$/);
  expect(await receiver.read('MALFORMED-SECRET')).toBeNull();
  const ownerResult = await runSyncOwner({ store: receiver, config, passphrase: 'outer', secretPassphrase: 'inner', deviceId: 'owner', once: true, sleep: async () => undefined });
  expect(ownerResult.exitCode).toBe(3);
  receiver.close();
});
