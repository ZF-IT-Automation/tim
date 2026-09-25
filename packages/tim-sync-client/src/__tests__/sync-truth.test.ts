import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { TimStore, getCurrentVersion } from 'tim-store';
import { SyncApiError } from '../client.js';
import {
  SyncStateRejectedError,
  freshBoundSyncState,
  loadConfig,
  readSyncConfig,
  repairSyncState,
  saveConfig,
} from '../config.js';
import { collectSyncAudit } from '../audit.js';
import { buildSyncContext, pushCycle, type SyncState } from '../sync.js';
import { saveQueue, type QueueItem } from '../queue.js';
import { getQueuePath } from '../config.js';
import type { TimEnvelope } from '../envelope.js';
import type { TimSyncClient } from '../client.js';

const origHome = process.env.HOME;
let root = '';

afterEach(() => {
  process.env.HOME = origHome;
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = '';
});

function useHome(): string {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tim-sync-truth-'));
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { recursive: true });
  process.env.HOME = home;
  return home;
}

function queueItem(key: string): QueueItem {
  const env: TimEnvelope = {
    v: 1,
    type: 'entry',
    key,
    lww: '2026-01-01T00:00:00.000Z',
    deleted: false,
    payload: JSON.stringify({ id: key, title: key, content: 'body' }),
  };
  return {
    idempotency_key: key,
    envelopes: [env],
    blobs: [{
      proposed_id: key,
      data: 'cipher-not-json',
      device_id: 'dev',
      updated_at: env.lww,
    }],
    created_at: '2026-01-01T00:00:00.000Z',
    attempts: 0,
  };
}

function baseState(): SyncState {
  return {
    fileGeneration: 'test-generation',
    fileId: 'file-1',
    cursor: null,
    lastPush: '2020-01-01T00:00:00.000Z',
    lastPull: '2020-01-01T00:00:00.000Z',
  };
}

describe('push success timestamps', () => {
  it.each([
    ['UNAUTHORIZED', 401],
    ['PAYMENT_REQUIRED', 402],
    ['RATE_LIMITED', 429],
    ['TIMEOUT', 0],
  ] as const)('%s does not advance lastPush', async (code, status) => {
    useHome();
    const store = new TimStore(':memory:');
    saveQueue(getQueuePath('file-1'), [queueItem('a')]);
    const state = baseState();
    const client = {
      push: vi.fn().mockRejectedValue(new SyncApiError('failed', code, status)),
    } as unknown as TimSyncClient;

    await pushCycle(client, store, state, 'dev', (data) => data, undefined, {
      sleep: async () => undefined,
    });

    expect(state.lastPush).toBe('2020-01-01T00:00:00.000Z');
    expect(state.lastPushError).toContain(code);
    expect(state.lastPushAttempt).not.toBeNull();
    store.close();
  });

  it('a TimeoutError does not advance lastPush', async () => {
    useHome();
    const store = new TimStore(':memory:');
    saveQueue(getQueuePath('file-1'), [queueItem('a')]);
    const state = baseState();
    const timeout = new Error('The operation was aborted due to timeout');
    timeout.name = 'TimeoutError';
    const client = { push: vi.fn().mockRejectedValue(timeout) } as unknown as TimSyncClient;

    await pushCycle(client, store, state, 'dev', (data) => data);

    expect(state.lastPush).toBe('2020-01-01T00:00:00.000Z');
    expect(state.lastPushError).toBe('TIMEOUT');
    store.close();
  });

  it('a partial send does not advance lastPush', async () => {
    useHome();
    const store = new TimStore(':memory:');
    saveQueue(getQueuePath('file-1'), [queueItem('a'), queueItem('b')]);
    const state = baseState();
    let calls = 0;
    const client = {
      push: vi.fn(async () => {
        calls += 1;
        if (calls === 1) return { mappings: [] };
        throw new SyncApiError('slow down', 'RATE_LIMITED', 429);
      }),
    } as unknown as TimSyncClient;

    await pushCycle(client, store, state, 'dev', (data) => data, undefined, {
      sleep: async () => undefined,
    });

    // One accepted batch, then eight retries and the attempt that exhausts the budget.
    expect(calls).toBe(10);
    expect(state.lastPush).toBe('2020-01-01T00:00:00.000Z');
    expect(state.lastPushError).toContain('RATE_LIMITED');
    store.close();
  });

  it('a completed send advances lastPush', async () => {
    useHome();
    const store = new TimStore(':memory:');
    saveQueue(getQueuePath('file-1'), [queueItem('a')]);
    const state = baseState();
    const client = {
      push: vi.fn().mockResolvedValue({ mappings: [] }),
    } as unknown as TimSyncClient;

    await pushCycle(client, store, state, 'dev', (data) => data);

    expect(state.lastPush).not.toBe('2020-01-01T00:00:00.000Z');
    expect(state.lastPushError).toBeNull();
    store.close();
  });
});

describe('state binding and repair', () => {
  it('does not adopt fake-file-id and repair archives it without reusing the cursor', () => {
    useHome();
    const dbPath = path.join(root, 'tim.db');
    const store = new TimStore(dbPath);
    store.close();
    saveConfig({
      serverUrl: 'https://sync.example',
      userId: 'tenant-1',
      token: 'super-secret-token',
      salt: 'super-secret-salt',
      fileId: 'file-real',
    });
    const statePath = path.join(os.homedir(), '.tim', 'sync-state.json');
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    const legacy = {
      fileId: 'fake-file-id',
      cursor: 'old-cursor',
      lastPush: '2026-08-12T00:00:00.000Z',
      lastPull: '2026-08-12T00:00:00.000Z',
    };
    fs.writeFileSync(statePath, JSON.stringify(legacy));
    const before = fs.readFileSync(statePath);

    const opened = new TimStore(dbPath);
    expect(() => buildSyncContext(opened, loadConfig()!, 'pass', 'dev')).toThrow(SyncStateRejectedError);
    opened.close();
    expect(fs.readFileSync(statePath)).toEqual(before);

    const repaired = repairSyncState(fs.realpathSync(dbPath));
    expect(repaired.action).toBe('repaired');
    expect(repaired.preservedPath).toBeTruthy();
    const preserved = JSON.parse(fs.readFileSync(repaired.preservedPath!, 'utf8')) as typeof legacy;
    expect(preserved).toEqual(legacy);
    const next = JSON.parse(fs.readFileSync(statePath, 'utf8')) as {
      fileId: string;
      cursor: string | null;
      dbIdentity: string;
    };
    expect(next.fileId).toBe('file-real');
    expect(next.cursor).toBeNull();
    expect(next.dbIdentity).toBe(fs.realpathSync(dbPath));
    expect(JSON.stringify(next)).not.toContain('fake-file-id');
    expect(JSON.stringify(next)).not.toContain('old-cursor');
    expect(loadConfig()?.fileId).toBe('file-real');
  });

  it('refuses repair of a disconnected placeholder without touching state', () => {
    useHome();
    const dbPath = path.join(root, 'tim.db');
    const store = new TimStore(dbPath);
    store.close();
    fs.mkdirSync(path.join(os.homedir(), '.tim'), { recursive: true });
    const statePath = path.join(os.homedir(), '.tim', 'sync-state.json');
    fs.writeFileSync(statePath, JSON.stringify({ fileId: 'fake-file-id', cursor: 'keep' }));
    fs.writeFileSync(path.join(os.homedir(), '.tim', 'sync.json'), JSON.stringify({
      serverUrl: '',
      userId: '',
      token: '',
      salt: '',
      fileId: '',
    }));
    const before = fs.readFileSync(statePath);
    expect(readSyncConfig().status).toBe('disconnected');
    expect(() => repairSyncState(fs.realpathSync(dbPath))).toThrow(/disconnected placeholder/);
    expect(fs.readFileSync(statePath)).toEqual(before);
  });
});

describe('sync audit', () => {
  it('reads the database without changing schema, staging, or queue and omits secrets', () => {
    useHome();
    const dbPath = path.join(root, 'tim.db');
    const store = new TimStore(dbPath, { staging: true });
    store.getDb().prepare(
      `INSERT INTO staging (key, entity_type, operation, payload, lww_timestamp, lww_device, lww_confidence, acked)
       VALUES ('old-acked', 'entry', 'upsert', '{}', 1, 'local', 1, 1)`,
    ).run();
    const unackedAt = Date.now() - 5_000;
    store.getDb().prepare(
      `INSERT INTO staging (key, entity_type, operation, payload, lww_timestamp, lww_device, lww_confidence, acked)
       VALUES ('waiting', 'entry', 'upsert', '{}', ?, 'local', 1, 0)`,
    ).run(unackedAt);
    store.close();

    const timDir = path.join(os.homedir(), '.tim');
    fs.mkdirSync(timDir, { recursive: true });
    fs.writeFileSync(path.join(timDir, 'config.json'), JSON.stringify({ sync: { staging: false } }));
    fs.writeFileSync(path.join(timDir, 'sync.json'), JSON.stringify({
      serverUrl: 'https://sync.example',
      userId: 'tenant-1',
      token: 'super-secret-token',
      salt: 'super-secret-salt',
      fileId: 'file-real',
    }));
    const legacy = {
      fileId: 'fake-file-id',
      cursor: 'old-cursor',
      lastPush: '2026-08-12T00:00:00.000Z',
      lastPull: null,
    };
    const statePath = path.join(timDir, 'sync-state.json');
    fs.writeFileSync(statePath, JSON.stringify(legacy));
    const queuePath = getQueuePath('file-real');
    fs.writeFileSync(queuePath, '{"bytes":true}\n');
    const legacyQueue = getQueuePath('fake-file-id');
    fs.writeFileSync(legacyQueue, 'legacy-queue-must-stay');
    const stateBefore = fs.readFileSync(statePath);
    const queueBefore = fs.readFileSync(queuePath);
    const legacyQueueBefore = fs.readFileSync(legacyQueue);

    const report = collectSyncAudit(dbPath);
    const json = JSON.stringify(report);
    expect(report.openedReadOnly).toBe(true);
    expect(report.schemaCompatible).toBe(true);
    expect(report.schemaVersion).toBe(getCurrentVersion());
    expect(report.stagingEnabled).toBe(true);
    expect(report.backlog.count).toBe(1);
    expect(report.backlog.oldestAgeMs).toBeGreaterThanOrEqual(5_000);
    expect(report.queue.bytes).toBe(queueBefore.length);
    expect(report.connection).toEqual({
      status: 'configured',
      serverUrl: 'https://sync.example',
      tenantId: 'tenant-1',
      fileId: 'file-real',
      protocolGeneration: 1,
    });
    expect(report.state.status).toBe('mismatched_file');
    expect(report.state.cursorUsable).toBe(false);
    expect(report.state.lastPushSuccess).toBeNull();
    expect(json).not.toContain('super-secret-token');
    expect(json).not.toContain('super-secret-salt');
    expect(json).not.toContain('old-cursor');
    expect(json).not.toContain('fake-file-id');
    expect(fs.readFileSync(statePath)).toEqual(stateBefore);
    expect(fs.readFileSync(queuePath)).toEqual(queueBefore);
    expect(fs.readFileSync(legacyQueue)).toEqual(legacyQueueBefore);

    const check = new TimStore(dbPath, { readonly: true });
    expect(check.getDb().prepare(
      "SELECT 1 AS present FROM sqlite_master WHERE type = 'trigger' AND name = 'staging_disabled'",
    ).get()).toBeUndefined();
    expect(check.getDb().prepare('SELECT key FROM staging WHERE key = ?').get('old-acked')).toEqual({
      key: 'old-acked',
    });
    check.close();
  });

  it('reports today-shaped empty config as disconnected', () => {
    useHome();
    const dbPath = path.join(root, 'tim.db');
    const store = new TimStore(dbPath);
    store.close();
    fs.mkdirSync(path.join(os.homedir(), '.tim'), { recursive: true });
    fs.writeFileSync(path.join(os.homedir(), '.tim', 'sync.json'), JSON.stringify({
      serverUrl: '',
      userId: '',
      token: '',
      salt: '',
      fileId: '',
    }));
    const report = collectSyncAudit(dbPath);
    expect(report.connection.status).toBe('disconnected');
    expect(report.connection.fileId).toBeNull();
    expect(report.connection.serverUrl).toBeNull();
    expect(report.queue.bytes).toBeNull();
    expect(report.openedReadOnly).toBe(true);
  });
});

describe('fresh bound state', () => {
  it('starts from a null cursor', () => {
    const state = freshBoundSyncState({
      serverUrl: 'https://sync.example',
      userId: 'tenant-1',
      token: 't',
      salt: 's',
      fileId: 'file-real',
    }, '/tmp/tim.db');
    expect(state.cursor).toBeNull();
    expect(state.fileId).toBe('file-real');
    expect(state.protocolGeneration).toBe(1);
  });
});
it('keeps retry ciphertext stable when entry and edge keys share the same string', async () => {
  useHome();
  const store = new TimStore(':memory:');
  const key='a|b|relates';
  const entry={...queueItem(key).envelopes[0],device:'origin',deleted:true};
  const edge={...entry,type:'edge' as const,payload:JSON.stringify({id:'edge',source_id:'a',target_id:'b',type:'relates'})};
  const blobs=[entry,edge].map(e=>({proposed_id:key,entity_key:key,entity_type:e.type,lww_device:'origin',device_id:'sender',updated_at:e.lww,data:`${e.type}-cipher`}));
  saveQueue(getQueuePath('file-1'),[{...queueItem(key),envelopes:[entry,edge],blobs}]);
  const push=vi.fn().mockRejectedValueOnce(new SyncApiError('lost response','NETWORK')).mockResolvedValue({mappings:[]});
  const client={push} as unknown as TimSyncClient;
  const state=baseState();
  let encryptions=0;
  try {
    await pushCycle(client,store,state,'sender',()=>`reencrypted-${++encryptions}`);
    await pushCycle(client,store,state,'sender',()=>`reencrypted-${++encryptions}`);
    expect(push.mock.calls[0][0]).toEqual(push.mock.calls[1][0]);
    expect(encryptions).toBe(0);
  } finally {store.close();}
});
