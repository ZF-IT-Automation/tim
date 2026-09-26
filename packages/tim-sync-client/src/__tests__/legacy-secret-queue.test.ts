import { describe, expect, it, vi, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TimStore, applyRemoteEntry } from 'tim-store';
import { pushCycle } from '../sync.js';
import { loadQueue, saveQueue } from '../queue.js';
import { TimSyncClient } from '../client.js';
import { deriveKey, encrypt, decrypt, generateSalt } from '../crypto.js';
import {
  encryptSecretPayload,
  decryptSecretPayload,
  MissingSecretPassphraseError,
} from '../sync.js';
import type { TimEnvelope } from '../envelope.js';
import type { QueueItem } from '../queue.js';

const isolated = vi.hoisted(() => ({ queue: '', tmpDirs: [] as string[] }));
vi.mock('../config.js', async importOriginal => ({
  ...await importOriginal<typeof import('../config.js')>(),
  getQueuePath: () => isolated.queue,
  saveSyncState: vi.fn(),
}));

function fullEntryPayload(
  key: string,
  title: string,
  content: string,
  metadata: Record<string, unknown>,
): string {
  const now = '2026-09-01T00:00:00.000Z';
  return JSON.stringify({
    id: key,
    parent_id: null,
    created_at: now,
    updated_at: now,
    accessed_at: now,
    depth: 1,
    title,
    content,
    content_type: 'text',
    confidence: 1,
    decay_rate: 0,
    visibility: 1,
    tags: '[]',
    irrelevant: 0,
    favorite: 0,
    tombstoned_at: null,
    metadata: JSON.stringify(metadata),
  });
}

function makeSecretEnvelope(
  key: string,
  title = 'Sensitive',
  content = 'private value',
): TimEnvelope {
  return {
    v: 1,
    type: 'entry',
    key,
    lww: '2026-09-01T00:00:00.000Z',
    deleted: false,
    payload: fullEntryPayload(key, title, content, { secret: true }),
  };
}

function makePublicEnvelope(key: string): TimEnvelope {
  return {
    v: 1,
    type: 'entry',
    key,
    lww: '2026-09-01T00:00:00.000Z',
    deleted: false,
    payload: fullEntryPayload(key, 'Public', 'visible', {}),
  };
}

function queueItem(
  idempotencyKey: string,
  envelopes: TimEnvelope[],
  deviceId = 'test',
): QueueItem {
  return {
    idempotency_key: idempotencyKey,
    envelopes,
    blobs: envelopes.map((e) => ({
      proposed_id: e.key,
      data: JSON.stringify(e),
      device_id: deviceId,
      updated_at: e.lww,
    })),
    created_at: envelopes[0]?.lww ?? new Date().toISOString(),
    attempts: 1,
  };
}

function freshQueuePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tim-legacy-queue-'));
  isolated.tmpDirs.push(dir);
  return join(dir, 'queue.json');
}

afterEach(() => {
  for (const dir of isolated.tmpDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  isolated.tmpDirs = [];
});

describe('legacy secret retry queue', () => {
  it('does not transmit a legacy unprotected secret envelope without the secret key', async () => {
    isolated.queue = freshQueuePath();
    const store = new TimStore(':memory:');
    const client = new TimSyncClient('http://127.0.0.1:1', 'test');
    const push = vi.spyOn(client, 'push').mockResolvedValue({} as Awaited<ReturnType<TimSyncClient['push']>>);
    const envelope = makeSecretEnvelope('legacy-secret');
    saveQueue(isolated.queue, [queueItem('legacy-attempt', [envelope])]);
    try {
      await expect(
        pushCycle(client, store, { fileGeneration: 'test-generation', fileId: 'isolated-test', cursor: null, lastPush: null, lastPull: null }, 'test', s => s),
      ).rejects.toThrow(MissingSecretPassphraseError);
      expect(push).not.toHaveBeenCalled();
      expect(loadQueue(isolated.queue).length).toBe(1);
    } finally {
      store.close();
    }
  });

  it('preserves an already locked queue payload and idempotency key without the secret key', async () => {
    isolated.queue = freshQueuePath();
    const store = new TimStore(':memory:');
    const client = new TimSyncClient('http://127.0.0.1:1', 'test');
    const push = vi.spyOn(client, 'push').mockResolvedValue({} as Awaited<ReturnType<TimSyncClient['push']>>);
    const envelope = makeSecretEnvelope('locked-legacy');
    const payload = encryptSecretPayload(envelope.payload, value => value);
    const locked = { ...envelope, payload, is_encrypted: true };
    saveQueue(isolated.queue, [queueItem('locked-attempt', [locked])]);
    try {
      await expect(
        pushCycle(client, store, { fileGeneration: 'test-generation', fileId: 'isolated-test', cursor: null, lastPush: null, lastPull: null }, 'test', value => value),
      ).rejects.toThrow(MissingSecretPassphraseError);
      expect(push).not.toHaveBeenCalled();
      const [remaining] = loadQueue(isolated.queue);
      expect(remaining.idempotency_key).toBe('locked-attempt');
      expect(remaining.envelopes[0].payload).toBe(payload);
    } finally {
      store.close();
    }
  });

  it('still syncs non-secret queue items when legacy secrets are blocked', async () => {
    isolated.queue = freshQueuePath();
    const store = new TimStore(':memory:');
    const client = new TimSyncClient('http://127.0.0.1:1', 'test');
    const push = vi.spyOn(client, 'push').mockResolvedValue({} as Awaited<ReturnType<TimSyncClient['push']>>);
    saveQueue(isolated.queue, [
      queueItem('mixed-attempt', [makePublicEnvelope('pub-1'), makeSecretEnvelope('sec-1')]),
    ]);
    try {
      await expect(
        pushCycle(client, store, { fileGeneration: 'test-generation', fileId: 'isolated-test', cursor: null, lastPush: null, lastPull: null }, 'test', s => s),
      ).rejects.toThrow(MissingSecretPassphraseError);
      expect(push).toHaveBeenCalledOnce();
      const sent = push.mock.calls[0][0];
      expect(sent.blobs).toHaveLength(1);
      expect(sent.blobs[0].proposed_id).toBe('pub-1');
      const remaining = loadQueue(isolated.queue);
      expect(remaining).toHaveLength(1);
      expect(remaining[0].envelopes).toHaveLength(1);
      expect(remaining[0].envelopes[0].key).toBe('sec-1');
    } finally {
      store.close();
    }
  });

  it('encrypts legacy secrets on retry with secret key and uses a fresh idempotency key', async () => {
    isolated.queue = freshQueuePath();
    const store = new TimStore(':memory:');
    const client = new TimSyncClient('http://127.0.0.1:1', 'test');
    const salt = generateSalt();
    const syncKey = deriveKey('sync-pass', salt);
    const secretKey = deriveKey('secret-pass', salt);
    const encryptFn = (s: string) => encrypt(s, syncKey);
    const secretEncrypt = (s: string) => encrypt(s, secretKey);
    const secretDecrypt = (s: string) => decrypt(s, secretKey);
    const originalKey = 'legacy-retry';
    saveQueue(isolated.queue, [queueItem(originalKey, [makeSecretEnvelope('sec-retry', 'Title', 'Body')])]);

    let capturedIdempotency: string | undefined;
    let capturedBlob: string | undefined;
    const push = vi.spyOn(client, 'push').mockImplementation(async (req) => {
      capturedIdempotency = req.idempotency_key;
      capturedBlob = req.blobs[0]?.data;
      return { mappings: req.blobs.map((b) => ({ proposed_id: b.proposed_id, final_id: b.proposed_id })) };
    });

    try {
      const result = await pushCycle(
        client,
        store,
        { fileGeneration: 'test-generation', fileId: 'isolated-test', cursor: null, lastPush: null, lastPull: null },
        'test',
        encryptFn,
        secretEncrypt,
      );
      expect(result.pushed).toBe(1);
      expect(push).toHaveBeenCalledOnce();
      expect(capturedIdempotency).toBeDefined();
      expect(capturedIdempotency).not.toBe(originalKey);
      expect(loadQueue(isolated.queue).length).toBe(0);

      const outer = JSON.parse(decrypt(capturedBlob!, syncKey)) as TimEnvelope;
      expect(outer.is_encrypted).toBe(true);
      const decrypted = decryptSecretPayload(outer.payload, secretDecrypt);
      const parsed = JSON.parse(decrypted) as { title: string; content: string };
      expect(parsed.title).toBe('Title');
      expect(parsed.content).toBe('Body');
    } finally {
      store.close();
    }
  });

  it('leaves already-protected envelopes unchanged', async () => {
    isolated.queue = freshQueuePath();
    const store = new TimStore(':memory:');
    const client = new TimSyncClient('http://127.0.0.1:1', 'test');
    const salt = generateSalt();
    const syncKey = deriveKey('sync-pass', salt);
    const secretKey = deriveKey('secret-pass', salt);
    const encryptFn = (s: string) => encrypt(s, syncKey);
    const secretEncrypt = (s: string) => encrypt(s, secretKey);

    const basePayload = JSON.stringify({
      id: 'sec-protected',
      title: 'Already safe',
      content: 'cipher',
      metadata: JSON.stringify({ secret: true }),
    });
    const encryptedPayload = encryptSecretPayload(basePayload, secretEncrypt);
    const protectedEnv: TimEnvelope = {
      v: 1,
      type: 'entry',
      key: 'sec-protected',
      lww: '2026-09-01T00:00:00.000Z',
      deleted: false,
      payload: encryptedPayload,
      is_encrypted: true,
    };
    saveQueue(isolated.queue, [queueItem('protected-attempt', [protectedEnv])]);

    const push = vi.spyOn(client, 'push').mockImplementation(async (req) => {
      return { mappings: req.blobs.map((b) => ({ proposed_id: b.proposed_id, final_id: b.proposed_id })) };
    });

    try {
      await pushCycle(
        client,
        store,
        { fileGeneration: 'test-generation', fileId: 'isolated-test', cursor: null, lastPush: null, lastPull: null },
        'test',
        encryptFn,
        secretEncrypt,
      );
      expect(push).toHaveBeenCalledOnce();
      expect(push.mock.calls[0][0].idempotency_key).toBe('protected-attempt');
      const outer = JSON.parse(decrypt(push.mock.calls[0][0].blobs[0].data, syncKey)) as TimEnvelope;
      expect(outer.payload).toBe(encryptedPayload);
      expect(outer.is_encrypted).toBe(true);
    } finally {
      store.close();
    }
  });

  it('replays a queued v1 envelope byte-for-byte and retains its idempotency key', async () => {
    isolated.queue = freshQueuePath();
    const store = new TimStore(':memory:');
    const client = new TimSyncClient('http://127.0.0.1:1', 'test');
    const salt = generateSalt();
    const syncKey = deriveKey('sync-pass', salt);
    const secretKey = deriveKey('secret-pass', salt);
    const encryptFn = (s: string) => encrypt(s, syncKey);
    const secretEncrypt = (s: string) => encrypt(s, secretKey);
    const legacyPayload = JSON.stringify({
      ...JSON.parse(makeSecretEnvelope('queued-v1', 'Sensitive title', 'Sensitive content').payload),
      title: secretEncrypt('Sensitive title'),
      content: secretEncrypt('Sensitive content'),
      metadata: JSON.stringify({ secret: true, _enc: secretEncrypt(JSON.stringify({ secret: true })) }),
    });
    const envelope: TimEnvelope = {
      ...makeSecretEnvelope('queued-v1'), payload: legacyPayload, is_encrypted: true,
    };
    saveQueue(isolated.queue, [queueItem('v1-attempt', [envelope])]);
    const push = vi.spyOn(client, 'push').mockImplementation(async (request) => ({
      mappings: request.blobs.map((blob) => ({ proposed_id: blob.proposed_id, final_id: blob.proposed_id })),
    }));
    try {
      await pushCycle(client, store, { fileGeneration: 'test-generation', fileId: 'isolated-test', cursor: null, lastPush: null, lastPull: null }, 'test', encryptFn, secretEncrypt);
      expect(push.mock.calls[0]![0].idempotency_key).toBe('v1-attempt');
      const wire = JSON.parse(decrypt(push.mock.calls[0]![0].blobs[0]!.data, syncKey)) as TimEnvelope;
      expect(wire.payload).toBe(legacyPayload);
    } finally {
      store.close();
    }
  });

  it('keeps blocked legacy items on disk while a push is in flight', async () => {
    isolated.queue = freshQueuePath();
    const store = new TimStore(':memory:');
    const client = new TimSyncClient('http://127.0.0.1:1', 'test');
    saveQueue(isolated.queue, [
      queueItem('inflight-attempt', [makePublicEnvelope('pub-inflight'), makeSecretEnvelope('sec-inflight')]),
    ]);

    let releasePush!: () => void;
    const pushGate = new Promise<void>(resolve => { releasePush = resolve; });
    const push = vi.spyOn(client, 'push').mockImplementation(async () => {
      await pushGate;
      return { mappings: [{ proposed_id: 'pub-inflight', final_id: 'pub-inflight' }] };
    });

    try {
      const cycle = pushCycle(
        client,
        store,
        { fileGeneration: 'test-generation', fileId: 'isolated-test', cursor: null, lastPush: null, lastPull: null },
        'test',
        s => s,
      );
      await vi.waitFor(() => push.mock.calls.length > 0, { timeout: 2000 });
      const during = loadQueue(isolated.queue);
      expect(during.length).toBeGreaterThan(0);
      expect(during.some(item => item.envelopes.some(e => e.key === 'sec-inflight'))).toBe(true);
      releasePush();
      await expect(cycle).rejects.toThrow(MissingSecretPassphraseError);
      const after = loadQueue(isolated.queue);
      expect(after).toHaveLength(1);
      expect(after[0].envelopes[0].key).toBe('sec-inflight');
    } finally {
      store.close();
    }
  });

  it('retries failed sends with identical idempotency key and blob bytes', async () => {
    isolated.queue = freshQueuePath();
    const store = new TimStore(':memory:');
    const client = new TimSyncClient('http://127.0.0.1:1', 'test');
    const salt = generateSalt();
    const syncKey = deriveKey('sync-pass', salt);
    const encryptFn = (s: string) => encrypt(s, syncKey);
    const originalKey = 'stable-retry-key';
    saveQueue(isolated.queue, [queueItem(originalKey, [makePublicEnvelope('pub-stable')])]);

    let attempts = 0;
    const captured: Array<{ key: string; blob: string }> = [];
    vi.spyOn(client, 'push').mockImplementation(async (req) => {
      attempts++;
      captured.push({ key: req.idempotency_key, blob: req.blobs[0].data });
      if (attempts === 1) throw new Error('network down');
      return { mappings: [{ proposed_id: 'pub-stable', final_id: 'pub-stable' }] };
    });

    try {
      const first = await pushCycle(
        client,
        store,
        { fileGeneration: 'test-generation', fileId: 'isolated-test', cursor: null, lastPush: null, lastPull: null },
        'test',
        encryptFn,
      );
      expect(first.pushed).toBe(0);
      expect(first.queued).toBe(true);
      expect(loadQueue(isolated.queue).length).toBe(1);

      const second = await pushCycle(
        client,
        store,
        { fileGeneration: 'test-generation', fileId: 'isolated-test', cursor: null, lastPush: null, lastPull: null },
        'test',
        encryptFn,
      );
      expect(second.pushed).toBe(1);
      expect(captured).toHaveLength(2);
      expect(captured[0].key).toBe(originalKey);
      expect(captured[1].key).toBe(originalKey);
      expect(captured[0].blob).toBe(captured[1].blob);
    } finally {
      store.close();
    }
  });

  it('keeps blocked ciphertext idempotency key when a mixed queue item is split', async () => {
    isolated.queue = freshQueuePath();
    const store = new TimStore(':memory:');
    const client = new TimSyncClient('http://127.0.0.1:1', 'test');
    const originalKey = 'mixed-split-key';
    saveQueue(isolated.queue, [
      queueItem(originalKey, [makePublicEnvelope('pub-split'), makeSecretEnvelope('sec-split')]),
    ]);

    let sentKey: string | undefined;
    vi.spyOn(client, 'push').mockImplementation(async (req) => {
      sentKey = req.idempotency_key;
      return { mappings: [{ proposed_id: 'pub-split', final_id: 'pub-split' }] };
    });

    try {
      await expect(
        pushCycle(
          client,
          store,
          { fileGeneration: 'test-generation', fileId: 'isolated-test', cursor: null, lastPush: null, lastPull: null },
          'test',
          s => s,
        ),
      ).rejects.toThrow(MissingSecretPassphraseError);
      expect(sentKey).toBeDefined();
      expect(sentKey).not.toBe(originalKey);
      const remaining = loadQueue(isolated.queue);
      expect(remaining).toHaveLength(1);
      expect(remaining[0].idempotency_key).toBe(originalKey);
      expect(remaining[0].idempotency_key).not.toBe(sentKey);
    } finally {
      store.close();
    }
  });

  it('end-to-end: queued legacy secret decrypts into a temporary store after retry', async () => {
    isolated.queue = freshQueuePath();
    const dbPath = join(mkdtempSync(join(tmpdir(), 'tim-legacy-e2e-')), 'store.db');
    isolated.tmpDirs.push(join(dbPath, '..'));
    const store = new TimStore(dbPath);
    const client = new TimSyncClient('http://127.0.0.1:1', 'test');
    const salt = generateSalt();
    const syncKey = deriveKey('sync-pass', salt);
    const secretKey = deriveKey('secret-pass', salt);
    const encryptFn = (s: string) => encrypt(s, syncKey);
    const secretEncrypt = (s: string) => encrypt(s, secretKey);
    const secretDecrypt = (s: string) => decrypt(s, secretKey);

    saveQueue(isolated.queue, [
      queueItem('e2e-attempt', [makeSecretEnvelope('SEC-E2E-Q', 'Vault', 'Top secret')]),
    ]);

    vi.spyOn(client, 'push').mockImplementation(async (req) => {
      const blob = req.blobs[0];
      const env = JSON.parse(decrypt(blob.data, syncKey)) as TimEnvelope;
      const cleartext = decryptSecretPayload(env.payload, secretDecrypt);
      applyRemoteEntry(store.getDb(), cleartext, Date.parse(env.lww), 'remote', false);
      return { mappings: [{ proposed_id: blob.proposed_id, final_id: blob.proposed_id }] };
    });

    try {
      await pushCycle(
        client,
        store,
        { fileGeneration: 'test-generation', fileId: 'isolated-test', cursor: null, lastPush: null, lastPull: null },
        'test',
        encryptFn,
        secretEncrypt,
      );
      const entry = await store.read('SEC-E2E-Q');
      expect(entry).not.toBeNull();
      expect(entry!.title).toBe('Vault');
      expect(entry!.content).toBe('Top secret');
      expect(existsSync(isolated.queue)).toBe(false);
    } finally {
      store.close();
    }
  });
});
