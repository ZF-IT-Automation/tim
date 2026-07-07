import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Server } from 'node:http';
import { TimStore, applyRemoteEntry, getUnackedStaging } from 'tim-store';
import {
  TimSyncClient,
  generateSalt,
  buildSyncContext,
  runPush,
  runPull,
  startDevServer,
  resetDevServer,
  encryptSecretPayload,
  decryptSecretPayload,
  isSecretPlaceholderPayload,
  SECRET_PLACEHOLDER_TITLE,
} from '../index.js';
import { deriveKey, encrypt, decrypt } from '../crypto.js';

describe('secret sync fixes', () => {
  describe('isSecretPlaceholderPayload', () => {
    it('detects local placeholder rows', () => {
      const placeholder = JSON.stringify({
        id: 'PH-1',
        title: SECRET_PLACEHOLDER_TITLE,
        content: '',
        metadata: JSON.stringify({ secret: true, _enc: 'blob' }),
      });
      expect(isSecretPlaceholderPayload(placeholder)).toBe(true);
      expect(isSecretPlaceholderPayload(JSON.stringify({ id: 'X', title: 'real' }))).toBe(false);
    });
  });

  describe('applyRemoteEntry with encrypted secret payload', () => {
    it('succeeds when cleartext fields are preserved alongside encryption', () => {
      const store = new TimStore(':memory:');
      const db = store.getDb();
      const salt = generateSalt();
      const secretKey = deriveKey('secret-pass', salt);
      const secretEncrypt = (s: string) => encrypt(s, secretKey);
      const secretDecrypt = (s: string) => decrypt(s, secretKey);

      const basePayload = JSON.stringify({
        id: 'SEC-SYNC-1',
        parent_id: null,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
        accessed_at: '2026-01-01T00:00:00.000Z',
        depth: 1,
        title: 'Secret note',
        content: 'Hidden content',
        content_type: 'text',
        confidence: 0.9,
        decay_rate: 0,
        visibility: 1,
        tags: '["#private"]',
        irrelevant: 0,
        favorite: 0,
        tombstoned_at: null,
        metadata: JSON.stringify({ secret: true, kind: 'note' }),
      });

      const encrypted = decryptSecretPayload(
        encryptSecretPayload(basePayload, secretEncrypt),
        secretDecrypt,
      );

      const applied = applyRemoteEntry(db, encrypted, Date.now(), 'remote-device', false);
      expect(applied).toBe(true);

      const row = db.prepare('SELECT * FROM entries WHERE id = ?').get('SEC-SYNC-1') as {
        content_type: string;
        accessed_at: string;
        tags: string;
        title: string;
        content: string;
      };
      expect(row.content_type).toBe('text');
      expect(row.accessed_at).toBe('2026-01-01T00:00:00.000Z');
      expect(row.tags).toBe('["#private"]');
      expect(row.title).toBe('Secret note');
      expect(row.content).toBe('Hidden content');
      store.close();
    });
  });

  describe('push skips placeholder echo', () => {
    let server: Server;
    const deviceId = 'placeholder-device';
    const fileId = `tim-${deviceId}`;
    const passphrase = 'integration-test';
    const salt = generateSalt();
    const port = 3198;
    let dbPath: string;

    beforeAll(async () => {
      resetDevServer();
      try { fs.unlinkSync(path.join(os.homedir(), '.tim', 'sync-state.json')); } catch {}
      server = startDevServer(port);
      await new Promise<void>((r) => server.once('listening', r));

      const client = new TimSyncClient(`http://127.0.0.1:${port}`, 'test-token');
      await client.createFile(fileId, salt);
      vi.spyOn(client, 'push');

      dbPath = path.join(os.tmpdir(), `tim-placeholder-${Date.now()}.db`);
      const store = new TimStore(dbPath);
      const db = store.getDb();
      const now = new Date().toISOString();
      db.prepare(`INSERT INTO entries
        (id, parent_id, title, content, content_type, depth, confidence, created_at,
         accessed_at, updated_at, decay_rate, visibility, tags, irrelevant, favorite,
         tombstoned_at, metadata, lww_device)
        VALUES (?, NULL, ?, '', 'text', 1, 1, ?, ?, ?, 0, 1, '[]', 0, 0, NULL, ?, 'local')`)
        .run(
          'PH-LOCAL',
          SECRET_PLACEHOLDER_TITLE,
          now,
          now,
          now,
          JSON.stringify({ secret: true, _enc: 'blob' }),
        );
      db.prepare(`INSERT INTO staging (key, entity_type, operation, payload,
        lww_timestamp, lww_device, lww_confidence, acked)
        VALUES (?, 'entry', 'upsert', ?, ?, 'local', 1, 0)`).run(
        'PH-LOCAL',
        JSON.stringify({
          id: 'PH-LOCAL',
          parent_id: null,
          title: SECRET_PLACEHOLDER_TITLE,
          content: '',
          content_type: 'text',
          depth: 1,
          confidence: 1,
          created_at: now,
          accessed_at: now,
          updated_at: now,
          decay_rate: 0,
          visibility: 1,
          tags: '[]',
          irrelevant: 0,
          favorite: 0,
          tombstoned_at: null,
          metadata: JSON.stringify({ secret: true, _enc: 'blob' }),
        }),
        Date.now(),
      );
      store.close();
    });

    afterAll(() => {
      server.close();
      if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
      vi.restoreAllMocks();
    });

    it('does not push placeholder rows to server but acks them locally', async () => {
      const store = new TimStore(dbPath);
      const client = new TimSyncClient(`http://127.0.0.1:${port}`, 'test-token');
      const pushSpy = vi.spyOn(client, 'push');
      const ctx = {
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

      const { pushed } = await runPush(ctx);
      expect(pushed).toBe(0);
      expect(pushSpy).not.toHaveBeenCalled();
      expect(getUnackedStaging(store.getDb()).length).toBe(0);
      store.close();
    });
  });

  describe('secret entry end-to-end sync', () => {
    let server: Server;
    const deviceId = 'secret-sync-device';
    const fileId = `tim-${deviceId}`;
    const passphrase = 'integration-test';
    const secretPassphrase = 'secret-key-pass';
    const salt = generateSalt();
    const port = 3197;
    let dbPath: string;

    beforeAll(async () => {
      resetDevServer();
      try { fs.unlinkSync(path.join(os.homedir(), '.tim', 'sync-state.json')); } catch {}
      server = startDevServer(port);
      await new Promise<void>((r) => server.once('listening', r));

      const client = new TimSyncClient(`http://127.0.0.1:${port}`, 'test-token');
      await client.createFile(fileId, salt);
      dbPath = path.join(os.tmpdir(), `tim-secret-sync-${Date.now()}.db`);
    });

    afterAll(() => {
      server.close();
      if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    });

    it('syncs secret entry to receiving device without constraint errors', async () => {
      const store1 = new TimStore(dbPath);
      await store1.write('Secret sync body', {
        id: 'SEC-E2E',
        metadata: { secret: true },
      });

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
        secretPassphrase,
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
        secretPassphrase,
      );
      const { pulled } = await runPull(ctx2);
      expect(pulled).toBeGreaterThan(0);

      const entry = await store2.read('SEC-E2E');
      expect(entry).not.toBeNull();
      expect(entry!.title).toBe('Secret sync body');
      expect(entry!.metadata.secret).toBe(true);
      store2.close();
      fs.unlinkSync(dbPath2);
    });
  });
});
