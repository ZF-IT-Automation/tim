import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TimStore } from 'tim-store';
import { cmdConsolidate } from '../consolidate.js';

describe('cmdConsolidate', () => {
  let dbPath: string;
  let store: TimStore;
  const logs: string[] = [];
  const errors: string[] = [];

  beforeEach(async () => {
    dbPath = path.join(os.tmpdir(), `tim-consolidate-${Date.now()}.db`);
    process.env.TIM_DB_PATH = dbPath;
    store = new TimStore(dbPath);
    await store.createProject('P0500', { content: 'P0500 — CLI | Active' });
    const project = await store.read('P0500');
    await store.write('Shared idea title\nA.', {
      parentId: project!.id,
      tags: ['#idea', '#test'],
    });
    await store.write('Shared idea title copy\nB.', {
      parentId: project!.id,
      tags: ['#idea', '#test'],
    });
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

  it('find-duplicates reports queued candidates', async () => {
    await cmdConsolidate(['find-duplicates', '--project', 'P0500']);
    const out = JSON.parse(logs.join('\n'));
    expect(out.project).toBe('P0500');
    expect(out.count).toBeGreaterThanOrEqual(1);
  });
});
