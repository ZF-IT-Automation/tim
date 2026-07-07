import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TimStore } from 'tim-store';
import { cmdSecret } from '../secret.js';

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
});
