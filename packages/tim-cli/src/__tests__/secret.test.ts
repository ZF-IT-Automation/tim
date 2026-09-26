import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TimStore, applyRemoteEntry } from 'tim-store';
import { cmdSecret } from '../secret.js';
import { deriveKey, encrypt, encryptSecretPayload, generateSalt, SecretWrongKeyError } from 'tim-sync-client';

describe('cmdSecret', () => {
  let dbPath: string;
  const logs: string[] = [];
  const errors: string[] = [];

  beforeEach(async () => {
    dbPath = path.join(os.tmpdir(), `tim-secret-cli-${Date.now()}.db`);
    process.env.TIM_DB_PATH = dbPath;
    const store = new TimStore(dbPath);
    await store.write('Root', { id: 'ROOT-1' });
    await store.write('Child', { id: 'CHILD-1', parentId: 'ROOT-1' });
    store.close();

    logs.length = 0;
    errors.length = 0;
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(' '));
    });
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(' '));
    });
  });

  afterEach(() => {
    delete process.env.TIM_DB_PATH;
    if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
    vi.restoreAllMocks();
  });

  it('setting secret then listing shows it', async () => {
    await cmdSecret(['set', 'ROOT-1']);
    await cmdSecret(['list']);

    const out = logs.join('\n');
    expect(out).toContain('ROOT-1');
    expect(out).toContain('CHILD-1');
  });

  it('status on descendant reports inherited', async () => {
    await cmdSecret(['set', 'ROOT-1']);
    await cmdSecret(['status', 'CHILD-1']);

    const out = logs.join('\n');
    expect(out).toMatch(/secret: true \(inherited from ROOT-1\)/);
  });

  it('set on non-existent id reports error', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit');
    }) as never);

    await expect(cmdSecret(['set', 'MISSING-ID'])).rejects.toThrow('process.exit');
    expect(errors.join('\n')).toContain('Entry not found: MISSING-ID');
    exitSpy.mockRestore();
  });

  it('unlock keeps row locked for wrong key, then restores it with right key', async () => {
    const salt = generateSalt();
    const rightKey = deriveKey('right-key', salt);
    const store = new TimStore(dbPath);
    const entry = await store.write('Private body', { id: 'LOCKED-1', title: 'Private title', metadata: { secret: true, kind: 'note' } });
    const row = store.getDb().prepare('SELECT * FROM entries WHERE id=?').get(entry.id);
    const encrypted = encryptSecretPayload(JSON.stringify(row), value => encrypt(value, rightKey));
    applyRemoteEntry(store.getDb(), encrypted, Date.now() + 1, 'remote', false);
    store.close();

    await expect(cmdSecret(['unlock', '--secret-passphrase', 'wrong-key', '--salt', salt]))
      .rejects.toBeInstanceOf(SecretWrongKeyError);
    const locked = new TimStore(dbPath);
    expect((locked.getDb().prepare('SELECT title FROM entries WHERE id=?').get('LOCKED-1') as { title: string }).title).toContain('🔒');
    locked.close();

    await cmdSecret(['unlock', '--secret-passphrase', 'right-key', '--salt', salt]);
    const restored = new TimStore(dbPath);
    expect(restored.getDb().prepare('SELECT title, content, metadata FROM entries WHERE id=?').get('LOCKED-1'))
      .toMatchObject({ title: 'Private title', content: 'Private body', metadata: expect.stringContaining('"kind":"note"') });
    restored.close();
  });
});
