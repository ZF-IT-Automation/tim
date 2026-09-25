import { afterEach, beforeEach, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getUnackedStaging, TimStore } from 'tim-store';
import { startHostedSyncServer, type HostedServerHandle } from '../../../tim-sync-server/src/server.js';
import { TimSyncClient } from '../client.js';
import {
  freshBoundSyncState,
  getQueuePath,
  loadBoundSyncState,
  saveConfig,
  saveSyncState,
  type SyncConfig,
} from '../config.js';
import { syncDbIdentity, syncOwnerLockName, tryAcquireSyncLock } from '../lock.js';
import { loadQueue } from '../queue.js';
import { autoPush } from '../auto-sync.js';
import { buildSyncContext, runPush, syncCycleExitCode } from '../sync.js';
import { runSyncOwner } from '../owner.js';

let home: string;
let previousHome: string | undefined;
let root: string;
let server: HostedServerHandle | undefined;
let store: TimStore | undefined;

beforeEach(() => {
  previousHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), 'tim-durable-home-'));
  process.env.HOME = home;
  root = mkdtempSync(join(tmpdir(), 'tim-durable-'));
});

afterEach(async () => {
  store?.close();
  store = undefined;
  if (server) await server.close();
  server = undefined;
  process.env.HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
  delete process.env.TIM_SYNC_PASSPHRASE;
});

async function hosted(): Promise<{ config: SyncConfig; generation: string; token: string }> {
  server = await startHostedSyncServer({ port: 0, dataDir: root });
  const tenant = server.registry.register('free');
  const client = new TimSyncClient(`http://127.0.0.1:${server.port}`, tenant.token);
  const file = await client.createFile('f', 'salt');
  const config: SyncConfig = {
    serverUrl: `http://127.0.0.1:${server.port}`,
    userId: tenant.id,
    token: tenant.token,
    salt: 'salt',
    fileId: 'f',
  };
  saveConfig(config);
  return { config, generation: file.generation, token: tenant.token };
}

function openStore(): TimStore {
  store = new TimStore(join(root, 'local.db'));
  return store;
}

function bindState(config: SyncConfig, db: TimStore, generation: string): void {
  const state = freshBoundSyncState(config, db.getDatabasePath());
  state.fileGeneration = generation;
  saveSyncState(state, { replace: true });
}

it('does not ack a same-millisecond replacement and does not re-enqueue a queued revision', async () => {
  const { config, generation } = await hosted();
  const db = openStore();
  await db.write('original');
  bindState(config, db, generation);
  const ctx = buildSyncContext(db, config, 'pass', 'device-1');
  const original = ctx.client.push.bind(ctx.client);
  ctx.client.push = async (req, options) => {
    const inflight = getUnackedStaging(db.getDb())[0]!;
    db.getDb().prepare(`INSERT INTO staging (key, entity_type, operation, payload,
      lww_timestamp, lww_device, lww_confidence)
      VALUES (?, 'entry', 'upsert', ?, ?, 'device-1', 1)`).run(
      inflight.key, JSON.stringify({ id: inflight.key, content: 'replacement' }), inflight.lww_timestamp,
    );
    return original(req, options);
  };
  const first = await runPush(ctx);
  expect(first.pushed).toBeGreaterThan(0);
  const unacked = getUnackedStaging(db.getDb());
  expect(unacked).toHaveLength(1);
  expect(unacked[0]!.payload).toContain('replacement');
  const queued = loadQueue(getQueuePath('f'));
  expect(queued.some((item) => item.revisions?.includes(unacked[0]!.rowid))).toBe(false);

  let pushes = 0;
  ctx.client.push = async (req, options) => {
    pushes += 1;
    return original(req, options);
  };
  const before = loadQueue(getQueuePath('f'));
  await runPush(ctx);
  const after = loadQueue(getQueuePath('f'));
  expect(pushes).toBe(1);
  expect(after.length).toBe(before.length);
  expect(getUnackedStaging(db.getDb())).toHaveLength(0);
});

it('retries the same idempotency key after a crash between server commit and ack', async () => {
  const { config, generation } = await hosted();
  const db = openStore();
  await db.write('crash');
  bindState(config, db, generation);
  const ctx = buildSyncContext(db, config, 'pass', 'device-1');
  const original = ctx.client.push.bind(ctx.client);
  const keys: string[] = [];
  ctx.client.push = async (req, options) => {
    keys.push(req.idempotency_key);
    const result = await original(req, options);
    if (keys.length === 1) throw new Error('crash after commit');
    return result;
  };
  const failed = await runPush(ctx);
  expect(failed.complete).toBe(false);
  expect(getUnackedStaging(db.getDb()).length).toBeGreaterThan(0);
  const queued = loadQueue(getQueuePath('f'));
  expect(queued).toHaveLength(1);
  expect(statSync(getQueuePath('f')).mode & 0o777).toBe(0o600);
  expect(statSync(join(home, '.tim')).mode & 0o777).toBe(0o700);
  const recovered = await runPush(ctx);
  expect(recovered.complete).toBe(true);
  expect(keys[0]).toBe(keys[1]);
  expect(getUnackedStaging(db.getDb())).toHaveLength(0);
  expect(loadQueue(getQueuePath('f'))).toEqual([]);
});

it('parks an oversized record without retrying it', async () => {
  const { config, generation } = await hosted();
  const db = openStore();
  await db.write('x'.repeat(50));
  bindState(config, db, generation);
  const ctx = buildSyncContext(db, config, 'pass', 'device-1');
  let calls = 0;
  ctx.client.push = async () => {
    calls += 1;
    throw new Error('should not send');
  };
  const result = await runPush(ctx, { maxBytes: 32 });
  expect(result.oversized.length).toBe(1);
  expect(result.complete).toBe(true);
  expect(calls).toBe(0);
  const queued = loadQueue(getQueuePath('f'));
  expect(queued.every((item) => item.disposition === 'oversized' && item.attempts === 0)).toBe(true);
  await runPush(ctx, { maxBytes: 32 });
  expect(calls).toBe(0);
  expect(loadQueue(getQueuePath('f')).every((item) => item.attempts === 0)).toBe(true);
  expect(syncCycleExitCode(result)).toBe(0);
});

it('backs off on 429 and stops at the deadline without sleeping past it', async () => {
  let hits = 0;
  let stopForDeadline = false;
  const retry: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      hits += 1;
      const retryAfter = hits === 1 && !stopForDeadline ? '0' : '60';
      if (stopForDeadline || hits === 1) {
        res.writeHead(429, { 'Retry-After': retryAfter, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'slow', protocol_generation: 1 }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ protocol_generation: 1, mappings: [] }));
    });
  });
  await new Promise<void>((resolve) => retry.listen(0, '127.0.0.1', resolve));
  const address = retry.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const config: SyncConfig = {
    serverUrl: `http://127.0.0.1:${port}`,
    userId: 'tenant',
    token: 'token',
    salt: 'salt',
    fileId: 'f',
  };
  saveConfig(config);
  const db = openStore();
  await db.write('rate');
  const state = freshBoundSyncState(config, db.getDatabasePath());
  state.fileGeneration = 'gen';
  saveSyncState(state, { replace: true });
  try {
    const ctx = buildSyncContext(db, config, 'pass', 'device-1');
    const ok = await runPush(ctx, { deadlineAt: Date.now() + 5_000, sleep: async () => undefined });
    expect(hits).toBe(2);
    expect(ok.complete).toBe(true);
    expect(getUnackedStaging(db.getDb())).toHaveLength(0);

    hits = 0;
    stopForDeadline = true;
    await db.write('rate-again');
    const stopped = await runPush(ctx, { deadlineAt: Date.now() + 1_000, sleep: async () => undefined });
    expect(stopped.complete).toBe(false);
    expect(stopped.errorCode).toBe('DEADLINE');
    expect(stopped.permanent).toBe(false);
    expect(syncCycleExitCode(stopped)).toBe(2);
    expect(hits).toBe(1);
  } finally {
    await new Promise<void>((resolve, reject) => retry.close((err) => (err ? reject(err) : resolve())));
  }
});

it('treats hosted 401 and 402 as permanent and leaves the cursor untouched', async () => {
  const { config, generation } = await hosted();
  const db = openStore();
  await db.write('secret-not-really');
  bindState(config, db, generation);
  const savedCursor = loadBoundSyncState(config, db.getDatabasePath()).cursor;
  const missed = await runPush(buildSyncContext(db, config, 'pass', 'device-1'), {
    deadlineAt: Date.now() - 1,
  });
  expect(missed.errorCode).toBe('DEADLINE');
  expect(missed.permanent).toBe(false);
  expect(getUnackedStaging(db.getDb()).length).toBeGreaterThan(0);
  const denied = buildSyncContext(db, { ...config, token: 'nope' }, 'pass', 'device-1');
  denied.client = new TimSyncClient(config.serverUrl, 'nope');
  const auth = await runPush(denied);
  expect(auth.permanent).toBe(true);
  expect(auth.errorCode).toContain('UNAUTHORIZED');
  expect(syncCycleExitCode(auth)).toBe(3);
  expect(loadBoundSyncState(config, db.getDatabasePath()).cursor).toBe(savedCursor);
  expect(loadBoundSyncState(config, db.getDatabasePath()).lastPush).toBeNull();
  expect(getUnackedStaging(db.getDb()).length).toBeGreaterThan(0);

  const blobs = Array.from({ length: 1000 }, (_, i) => ({
    proposed_id: `k${i}`,
    entity_key: `k${i}`,
    entity_type: 'entry' as const,
    lww_device: 'dev',
    data: 'x',
    device_id: 'dev',
    updated_at: new Date(10_000).toISOString(),
  }));
  const filler = new TimSyncClient(config.serverUrl, config.token);
  await filler.push({
    file_id: 'f',
    file_generation: generation,
    protocol_generation: 1,
    client_schema_major: 1,
    idempotency_key: 'fill-quota',
    blobs,
  });
  const quota = await runPush(buildSyncContext(db, config, 'pass', 'device-1'));
  expect(quota.permanent).toBe(true);
  expect(quota.errorCode).toContain('PAYMENT_REQUIRED');
  expect(syncCycleExitCode(quota)).toBe(3);
  expect(getUnackedStaging(db.getDb()).length).toBeGreaterThan(0);
});

it('drains idle staging from the owner without an MCP call, and a second owner exits 0', async () => {
  const { config, generation } = await hosted();
  const db = openStore();
  await db.write('idle');
  bindState(config, db, generation);
  const held = tryAcquireSyncLock(syncOwnerLockName(syncDbIdentity(db.getDatabasePath())));
  expect(held).not.toBeNull();
  process.env.TIM_SYNC_PASSPHRASE = 'pass';
  expect(await autoPush(db)).toMatchObject({ ran: false, reason: 'owner' });
  const busy = await runSyncOwner({
    store: db, config, passphrase: 'pass', deviceId: 'device-1', once: true, sleep: async () => undefined,
  });
  expect(busy.alreadyOwned).toBe(true);
  expect(busy.exitCode).toBe(0);
  held!.release();

  const drained = await runSyncOwner({
    store: db, config, passphrase: 'pass', deviceId: 'device-1', once: true, sleep: async () => undefined,
  });
  expect(drained.alreadyOwned).toBe(false);
  expect(drained.exitCode).toBe(0);
  expect(drained.push?.pushed).toBeGreaterThan(0);
  expect(getUnackedStaging(db.getDb())).toHaveLength(0);
});

it('reports a deadline when the server does not answer in time', async () => {
  const hanging: Server = createServer(() => {
    /* leave the socket open until the client aborts */
  });
  await new Promise<void>((resolve) => hanging.listen(0, '127.0.0.1', resolve));
  const address = hanging.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  const config: SyncConfig = {
    serverUrl: `http://127.0.0.1:${port}`,
    userId: 'tenant',
    token: 'token',
    salt: 'salt',
    fileId: 'f',
  };
  saveConfig(config);
  const db = openStore();
  await db.write('hang');
  const state = freshBoundSyncState(config, db.getDatabasePath());
  state.fileGeneration = 'gen';
  saveSyncState(state, { replace: true });
  try {
    const ctx = buildSyncContext(db, config, 'pass', 'device-1');
    const result = await runPush(ctx, { deadlineAt: Date.now() + 80 });
    expect(result.complete).toBe(false);
    expect(result.errorCode).toBe('DEADLINE');
    expect(result.permanent).toBe(false);
    expect(getUnackedStaging(db.getDb()).length).toBeGreaterThan(0);
    expect(loadBoundSyncState(config, db.getDatabasePath()).lastPush).toBeNull();
  } finally {
    hanging.closeAllConnections?.();
    await new Promise<void>((resolve, reject) => hanging.close((err) => (err ? reject(err) : resolve())));
  }
});
